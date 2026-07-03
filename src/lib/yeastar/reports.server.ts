/**
 * Yeastar Call Reports — Extension Call Statistics.
 *
 * Uses GET /openapi/v1.0/call_report/list with `type=extcallstatistics`.
 * Extensions are selected via the Extension Mapping table (see
 * ./mapping.server.ts) — extension groups on the PBX are NOT used, because
 * some firmwares don't expose them through the OpenAPI.
 *
 * Any extension not present in the mapping is silently excluded from all
 * dashboards; its ext_num is surfaced in `unmappedFromPbx` for diagnostics.
 */
import { yeastarFetch } from "./client.server";
import { resolveMappingContext, type Team } from "./mapping.server";

export type CommunicationType = "All" | "Inbound" | "Outbound";
export type TeamFilter = "all" | Team;

export interface CallStatsRow {
  ext_num: string;
  ext_name: string;
  group: Team;
  agent_code: string | null;
  total: number;
  answered: number;
  missed: number;
  inbound: number;
  outbound: number;
  inboundAnswered: number;
  outboundAnswered: number;
  answerRate: number;
  talkTimeSec: number;
}

export interface CallStatsResult {
  window: { from: string; to: string };
  communicationType: CommunicationType;
  team: TeamFilter;
  rows: CallStatsRow[];
  totals: {
    total: number; answered: number; missed: number;
    inbound: number; outbound: number;
    answerRate: number; missedRate: number;
  };
  mapping: {
    mappedExtensions: number;
    missingOnPbx: string[];
    unmappedFromPbx: string[];
  };
  elapsedMs: number;
}

function fmtStart(d: string) { return `${d} 00:00:00`; }
function fmtEnd(d: string) { return `${d} 23:59:59`; }
function pbxCommType(t: CommunicationType): string { return t === "All" ? "InOutbound" : t; }

interface InOutStats { answered_calls?: number; no_answer_calls?: number; busy_calls?: number; failed_calls?: number; voicemail_calls?: number; abandoned_calls?: number; total?: number }
interface RawStatRow {
  ext_num?: string; ext_name?: string;
  answered_calls?: number; no_answer_calls?: number; busy_calls?: number; failed_calls?: number; voicemail_calls?: number; abandoned_calls?: number;
  total_call_count?: number; total_talking_time?: number;
  inbound_stats?: InOutStats; outbound_stats?: InOutStats;
}

function derive(raw: RawStatRow) {
  const inb = raw.inbound_stats ?? {};
  const out = raw.outbound_stats ?? {};
  const inboundTotal = inb.total ?? ((inb.answered_calls ?? 0) + (inb.no_answer_calls ?? 0) + (inb.busy_calls ?? 0) + (inb.abandoned_calls ?? 0) + (inb.voicemail_calls ?? 0));
  const outboundTotal = out.total ?? ((out.answered_calls ?? 0) + (out.no_answer_calls ?? 0) + (out.busy_calls ?? 0) + (out.failed_calls ?? 0));
  const total = raw.total_call_count ?? (inboundTotal + outboundTotal);
  const answered = (inb.answered_calls ?? 0) + (out.answered_calls ?? 0);
  return { inb, out, inboundTotal, outboundTotal, total, answered };
}

async function fetchStats(extIds: string[], from: string, to: string, comm: CommunicationType): Promise<RawStatRow[]> {
  if (extIds.length === 0) return [];
  const out: RawStatRow[] = [];
  // The PBX supports comma-separated ext_id_list. Chunk to keep URL length sane.
  const CHUNK = 40;
  for (let i = 0; i < extIds.length; i += CHUNK) {
    const chunk = extIds.slice(i, i + CHUNK);
    const { httpStatus, json, body } = await yeastarFetch<any>("/openapi/v1.0/call_report/list", {
      type: "extcallstatistics",
      ext_id_list: chunk.join(","),
      start_time: fmtStart(from),
      end_time: fmtEnd(to),
      communication_type: pbxCommType(comm),
      page: 1,
      page_size: 200,
    });
    if (httpStatus !== 200 || !json || json.errcode !== 0) {
      throw new Error(`call_report/list failed: HTTP ${httpStatus} errcode=${json?.errcode ?? "n/a"} errmsg=${json?.errmsg ?? "n/a"} body=${body.slice(0, 200)}`);
    }
    const list: RawStatRow[] = json.ext_call_statistics_list ?? [];
    out.push(...list);
  }
  return out;
}

export async function fetchCallStatistics(opts: {
  from: string; to: string; team: TeamFilter; communicationType: CommunicationType;
}): Promise<CallStatsResult> {
  const started = Date.now();
  const ctx = await resolveMappingContext();

  // Filter mapping by requested team, then map to PBX ext_ids we know.
  const wantedExtNums: string[] = [];
  for (const [ext_num, row] of ctx.byExtNum) {
    if (opts.team !== "all" && row.team !== opts.team) continue;
    if (ctx.extNumToId.has(ext_num)) wantedExtNums.push(ext_num);
  }
  const extIds = wantedExtNums.map((n) => ctx.extNumToId.get(n)!);

  const raw = await fetchStats(extIds, opts.from, opts.to, opts.communicationType);
  console.log(`[yeastar reports] mapped=${ctx.byExtNum.size} ids=${extIds.length} pbxRows=${raw.length} unmapped(pbx)=${ctx.unmappedFromPbx.length}`);

  const rows: CallStatsRow[] = [];
  for (const r of raw) {
    const ext_num = String(r.ext_num ?? "");
    const mapped = ctx.byExtNum.get(ext_num);
    if (!mapped) continue; // silently exclude anything not in the mapping
    if (opts.team !== "all" && mapped.team !== opts.team) continue;
    const d = derive(r);
    rows.push({
      ext_num,
      ext_name: mapped.agent_name || r.ext_name || ext_num,
      group: mapped.team,
      agent_code: mapped.agent_code ?? ext_num,
      total: d.total,
      answered: d.answered,
      missed: Math.max(0, d.total - d.answered),
      inbound: d.inboundTotal,
      outbound: d.outboundTotal,
      inboundAnswered: d.inb.answered_calls ?? 0,
      outboundAnswered: d.out.answered_calls ?? 0,
      answerRate: d.total > 0 ? Math.round((d.answered / d.total) * 1000) / 10 : 0,
      talkTimeSec: r.total_talking_time ?? 0,
    });
  }
  rows.sort((a, b) => b.total - a.total);

  const sum = rows.reduce(
    (acc, r) => {
      acc.total += r.total; acc.answered += r.answered; acc.missed += r.missed;
      acc.inbound += r.inbound; acc.outbound += r.outbound;
      return acc;
    },
    { total: 0, answered: 0, missed: 0, inbound: 0, outbound: 0 },
  );
  const totals = {
    ...sum,
    answerRate: sum.total > 0 ? Math.round((sum.answered / sum.total) * 1000) / 10 : 0,
    missedRate: sum.total > 0 ? Math.round((sum.missed / sum.total) * 1000) / 10 : 0,
  };

  return {
    window: { from: opts.from, to: opts.to },
    communicationType: opts.communicationType,
    team: opts.team,
    rows,
    totals,
    mapping: {
      mappedExtensions: ctx.byExtNum.size,
      missingOnPbx: ctx.missingOnPbx,
      unmappedFromPbx: ctx.unmappedFromPbx,
    },
    elapsedMs: Date.now() - started,
  };
}

// ---- Daily activity (for the trend chart) -----------------------------------

export interface DailyPoint { date: string; total: number; answered: number; missed: number; inbound: number; outbound: number }

function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out.slice(0, 62);
}

export async function fetchDailyVolume(opts: {
  from: string; to: string; team: TeamFilter; communicationType: CommunicationType;
}): Promise<DailyPoint[]> {
  const ctx = await resolveMappingContext();
  const ids: string[] = [];
  for (const [ext_num, row] of ctx.byExtNum) {
    if (opts.team !== "all" && row.team !== opts.team) continue;
    const id = ctx.extNumToId.get(ext_num);
    if (id) ids.push(id);
  }
  if (ids.length === 0) return [];

  const days = daysBetween(opts.from, opts.to);
  const results: DailyPoint[] = [];
  for (const day of days) {
    const raw = await fetchStats(ids, day, day, opts.communicationType);
    let total = 0, answered = 0, inbound = 0, outbound = 0;
    for (const r of raw) {
      if (!ctx.byExtNum.has(String(r.ext_num ?? ""))) continue;
      const d = derive(r);
      total += d.total; answered += d.answered; inbound += d.inboundTotal; outbound += d.outboundTotal;
    }
    results.push({ date: day, total, answered, missed: Math.max(0, total - answered), inbound, outbound });
  }
  return results;
}
