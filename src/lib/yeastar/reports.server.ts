/**
 * Yeastar Call Reports — replicates the exact request the Yeastar Web UI
 * (Reports → Call Reports) makes:
 *
 *   GET /api/v2.0/report/searchbytype
 *       ?ext_id_list=<id1>,<id2>,
 *       &time_begin=DD/MM/YYYY hh:mm:ss AM
 *       &time_end=DD/MM/YYYY hh:mm:ss PM
 *       &call_type=InOutbound|Inbound|Outbound
 *       &type=extcallstatistics
 *
 * The Web UI authenticates via a websession cookie; the OpenAPI access_token
 * (query param) is accepted on this firmware for the same path. The response
 * carries `ext_call_statistics_list` and — when the account is authorised —
 * `ext_group_call_statistics_list`.
 *
 * Extension selection uses the local `yeastar_extension_map` table
 * (see ./mapping.server.ts) as the single source of truth for team grouping.
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
  request?: { url: string; params: Record<string, string> };
  raw?: {
    httpStatus: number;
    errcode: number | null;
    errmsg: string | null;
    total_number: number | null;
    keys: string[];
    ext_group_call_statistics_list: RawStatRow[] | null;
    bodyPreview: string;
  };

  rawExtNums?: string[];
}

const REPORT_PATH = "/api/v2.0/report/searchbytype";

function pad(n: number) { return String(n).padStart(2, "0"); }

// Web-UI style: "DD/MM/YYYY hh:mm:ss AM" (12-hour clock, AM/PM).
function fmtDate(iso: string, kind: "start" | "end"): string {
  // iso is "YYYY-MM-DD"
  const [y, m, d] = iso.split("-");
  return kind === "start"
    ? `${d}/${m}/${y} 12:00:00 AM`
    : `${d}/${m}/${y} 11:59:59 PM`;
}

function pbxCallType(t: CommunicationType): string {
  return t === "All" ? "InOutbound" : t;
}

interface InOutStats {
  answered_calls?: number; no_answer_calls?: number; busy_calls?: number;
  failed_calls?: number; voicemail_calls?: number; abandoned_calls?: number; total?: number;
}
interface RawStatRow {
  ext_num?: string; ext_name?: string;
  answered_calls?: number; no_answer_calls?: number; busy_calls?: number;
  failed_calls?: number; voicemail_calls?: number;
  total_call_count?: number; total_talking_time?: number;
  inbound_stats?: InOutStats; outbound_stats?: InOutStats;
}
interface ReportResponse {
  errcode?: number; errmsg?: string;
  total_number?: number;
  ext_call_statistics_list?: RawStatRow[];
  ext_group_call_statistics_list?: RawStatRow[];
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

async function fetchReport(extIds: string[], from: string, to: string, comm: CommunicationType) {
  // Match the Web UI verbatim — including the trailing comma after the last id.
  const params: Record<string, string> = {
    ext_id_list: extIds.join(",") + ",",
    time_begin: fmtDate(from, "start"),
    time_end: fmtDate(to, "end"),
    call_type: pbxCallType(comm),
    type: "extcallstatistics",
  };
  const { httpStatus, json, body } = await yeastarFetch<ReportResponse>(REPORT_PATH, params);
  return { httpStatus, json, body, params };
}

export function resetReportProbeCache() { /* no-op; kept for API compatibility */ }

export async function fetchCallStatistics(opts: {
  from: string; to: string; team: TeamFilter; communicationType: CommunicationType;
}): Promise<CallStatsResult> {
  const started = Date.now();
  const ctx = await resolveMappingContext();

  // Only extensions that are (a) in our mapping and (b) known to the PBX.
  const wantedExtNums: string[] = [];
  for (const [ext_num, row] of ctx.byExtNum) {
    if (opts.team !== "all" && row.team !== opts.team) continue;
    if (ctx.extNumToId.has(ext_num)) wantedExtNums.push(ext_num);
  }
  const extIds = wantedExtNums.map((n) => ctx.extNumToId.get(n)!);

  const rows: CallStatsRow[] = [];
  let rawList: RawStatRow[] = [];
  let raw: CallStatsResult["raw"] | undefined;
  let request: CallStatsResult["request"] | undefined;

  if (extIds.length > 0) {
    const { httpStatus, json, body, params } = await fetchReport(extIds, opts.from, opts.to, opts.communicationType);
    rawList = json?.ext_call_statistics_list ?? [];
    raw = {
      httpStatus,
      errcode: json?.errcode ?? null,
      errmsg: json?.errmsg ?? null,
      total_number: json?.total_number ?? null,
      keys: json && typeof json === "object" ? Object.keys(json) : [],
      ext_group_call_statistics_list: json?.ext_group_call_statistics_list ?? null,
      bodyPreview: body.slice(0, 400),
    };
    request = { url: REPORT_PATH, params };

    if (httpStatus !== 200 || json?.errcode !== 0) {
      throw new Error(`${REPORT_PATH} failed: HTTP ${httpStatus} errcode=${json?.errcode ?? "n/a"} errmsg=${json?.errmsg ?? "n/a"} body=${body.slice(0, 200)}`);
    }

    for (const r of rawList) {
      const ext_num = String(r.ext_num ?? "");
      const mapped = ctx.byExtNum.get(ext_num);
      if (!mapped) continue;
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
  }

  console.log(`[yeastar reports] mapped=${ctx.byExtNum.size} ids=${extIds.length} pbxRows=${rawList.length}`);

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
    request,
    raw,
    rawExtNums: Array.from(new Set(rawList.map((r) => String(r.ext_num ?? "")))).filter(Boolean),
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
    const { json } = await fetchReport(ids, day, day, opts.communicationType);
    const list = json?.ext_call_statistics_list ?? [];
    let total = 0, answered = 0, inbound = 0, outbound = 0;
    for (const r of list) {
      if (!ctx.byExtNum.has(String(r.ext_num ?? ""))) continue;
      const d = derive(r);
      total += d.total; answered += d.answered; inbound += d.inboundTotal; outbound += d.outboundTotal;
    }
    results.push({ date: day, total, answered, missed: Math.max(0, total - answered), inbound, outbound });
  }
  return results;
}

// Kept for backwards compatibility with any callers referring to old symbols.
export const lastReportProbes: never[] = [];
export type ReportProbe = never;
