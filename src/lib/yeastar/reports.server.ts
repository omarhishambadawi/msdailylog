/**
 * Yeastar Call Reports — Extension Call Statistics + Extension Call Activity.
 *
 * Uses GET /openapi/v1.0/call_report/list. The PBX aggregates on its side, so
 * a single request per team is enough — we never download raw CDRs.
 */
import { yeastarFetch } from "./client.server";
import { resolveExtensionGroups } from "./groups.server";

export type CommunicationType = "All" | "Inbound" | "Outbound";
export type Team = "all" | "customer_care" | "telesales";

export interface CallStatsRow {
  ext_num: string;
  ext_name: string;
  group: "customer_care" | "telesales" | "unknown";
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
  team: Team;
  rows: CallStatsRow[];
  totals: {
    total: number; answered: number; missed: number;
    inbound: number; outbound: number;
    answerRate: number; missedRate: number;
  };
  groups: { customerCareId: number | null; telesalesId: number | null };
  elapsedMs: number;
}

function fmtStart(d: string) { return `${d} 00:00:00`; }
function fmtEnd(d: string) { return `${d} 23:59:59`; }

function pbxCommType(t: CommunicationType): string | undefined {
  if (t === "All") return "InOutbound"; // Extension Call Statistics supports InOutbound
  return t; // "Inbound" | "Outbound"
}

interface InOutStats { answered_calls?: number; no_answer_calls?: number; busy_calls?: number; failed_calls?: number; voicemail_calls?: number; abandoned_calls?: number; total?: number }
interface RawStatRow {
  ext_num?: string; ext_name?: string;
  answered_calls?: number; no_answer_calls?: number; busy_calls?: number; failed_calls?: number; voicemail_calls?: number; abandoned_calls?: number;
  total_call_count?: number; total_talking_time?: number; total_holding_time?: number;
  inbound_stats?: InOutStats; outbound_stats?: InOutStats;
  org_list_info?: string;
}

function classifyGroup(orgInfo: string | undefined, ccName: string, tsName: string): CallStatsRow["group"] {
  if (!orgInfo) return "unknown";
  const s = orgInfo.toLowerCase();
  if (s.includes(ccName.toLowerCase()) || s.includes("customer_care")) return "customer_care";
  if (s.includes(tsName.toLowerCase()) || s.includes("telesales")) return "telesales";
  return "unknown";
}

function normalize(raw: RawStatRow, defaultGroup: CallStatsRow["group"], ccName: string, tsName: string): CallStatsRow {
  const inb = raw.inbound_stats ?? {};
  const out = raw.outbound_stats ?? {};
  const inboundTotal = inb.total ?? ((inb.answered_calls ?? 0) + (inb.no_answer_calls ?? 0) + (inb.busy_calls ?? 0) + (inb.abandoned_calls ?? 0) + (inb.voicemail_calls ?? 0));
  const outboundTotal = out.total ?? ((out.answered_calls ?? 0) + (out.no_answer_calls ?? 0) + (out.busy_calls ?? 0) + (out.failed_calls ?? 0));
  const total = raw.total_call_count ?? (inboundTotal + outboundTotal);
  const answered = (inb.answered_calls ?? 0) + (out.answered_calls ?? 0) || (raw.answered_calls ?? 0);
  const missed = Math.max(0, total - answered);
  const group = classifyGroup(raw.org_list_info, ccName, tsName);
  return {
    ext_num: String(raw.ext_num ?? ""),
    ext_name: raw.ext_name ?? "",
    group: group === "unknown" ? defaultGroup : group,
    total,
    answered,
    missed,
    inbound: inboundTotal,
    outbound: outboundTotal,
    inboundAnswered: inb.answered_calls ?? 0,
    outboundAnswered: out.answered_calls ?? 0,
    answerRate: total > 0 ? Math.round((answered / total) * 1000) / 10 : 0,
    talkTimeSec: raw.total_talking_time ?? 0,
  };
}

async function fetchStatsForGroup(groupId: number, from: string, to: string, comm: CommunicationType): Promise<RawStatRow[]> {
  const q: Record<string, string | number | undefined> = {
    type: "extcallstatistics",
    ext_id_list: String(groupId),
    start_time: fmtStart(from),
    end_time: fmtEnd(to),
    communication_type: pbxCommType(comm),
    page: 1,
    page_size: 200,
  };
  const { httpStatus, json, body } = await yeastarFetch<any>("/openapi/v1.0/call_report/list", q);
  if (httpStatus !== 200 || !json || json.errcode !== 0) {
    throw new Error(`call_report/list failed: HTTP ${httpStatus} errcode=${json?.errcode ?? "n/a"} errmsg=${json?.errmsg ?? "n/a"} body=${body.slice(0, 200)}`);
  }
  const list: RawStatRow[] = json.ext_call_statistics_list ?? [];
  return list;
}

export async function fetchCallStatistics(opts: {
  from: string; to: string; team: Team; communicationType: CommunicationType;
}): Promise<CallStatsResult> {
  const started = Date.now();
  const groups = await resolveExtensionGroups();
  const targets: Array<{ id: number; team: "customer_care" | "telesales" }> = [];
  if (opts.team === "all" || opts.team === "customer_care") {
    if (groups.customerCareId != null) targets.push({ id: groups.customerCareId, team: "customer_care" });
  }
  if (opts.team === "all" || opts.team === "telesales") {
    if (groups.telesalesId != null) targets.push({ id: groups.telesalesId, team: "telesales" });
  }
  if (targets.length === 0) {
    throw new Error("Yeastar extension groups (Customer_Care_Emp. / Telesales_Emp.) not found on the PBX");
  }

  const rowsByExt = new Map<string, CallStatsRow>();
  for (const t of targets) {
    const raw = await fetchStatsForGroup(t.id, opts.from, opts.to, opts.communicationType);
    for (const r of raw) {
      const norm = normalize(r, t.team, "Customer_Care", "Telesales");
      if (!norm.ext_num) continue;
      // If duplicate (extension in both groups), take the larger totals
      const existing = rowsByExt.get(norm.ext_num);
      if (!existing || norm.total > existing.total) rowsByExt.set(norm.ext_num, norm);
    }
    console.log(`[yeastar reports] extcallstatistics team=${t.team} rows=${raw.length}`);
  }

  const rows = Array.from(rowsByExt.values()).sort((a, b) => b.total - a.total);
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
    groups: { customerCareId: groups.customerCareId, telesalesId: groups.telesalesId },
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
  return out.slice(0, 62); // safety cap ~2 months
}

/**
 * Daily volume — we call extcallstatistics per day (single request each) so we
 * can produce a per-day series without pulling raw CDR. This stays under 62
 * PBX calls at the very worst; typical dashboards call ≤ 31.
 */
export async function fetchDailyVolume(opts: {
  from: string; to: string; team: Team; communicationType: CommunicationType;
}): Promise<DailyPoint[]> {
  const groups = await resolveExtensionGroups();
  const ids: number[] = [];
  if ((opts.team === "all" || opts.team === "customer_care") && groups.customerCareId != null) ids.push(groups.customerCareId);
  if ((opts.team === "all" || opts.team === "telesales") && groups.telesalesId != null) ids.push(groups.telesalesId);
  if (ids.length === 0) return [];

  const days = daysBetween(opts.from, opts.to);
  const results: DailyPoint[] = [];
  // Sequential to stay within Cloudflare Worker limits.
  for (const day of days) {
    let total = 0, answered = 0, inbound = 0, outbound = 0;
    for (const id of ids) {
      const raw = await fetchStatsForGroup(id, day, day, opts.communicationType);
      for (const r of raw) {
        const inb = r.inbound_stats ?? {};
        const out = r.outbound_stats ?? {};
        const iTot = inb.total ?? ((inb.answered_calls ?? 0) + (inb.no_answer_calls ?? 0) + (inb.busy_calls ?? 0) + (inb.abandoned_calls ?? 0));
        const oTot = out.total ?? ((out.answered_calls ?? 0) + (out.no_answer_calls ?? 0) + (out.busy_calls ?? 0) + (out.failed_calls ?? 0));
        total += r.total_call_count ?? (iTot + oTot);
        answered += (inb.answered_calls ?? 0) + (out.answered_calls ?? 0);
        inbound += iTot;
        outbound += oTot;
      }
    }
    results.push({ date: day, total, answered, missed: Math.max(0, total - answered), inbound, outbound });
  }
  return results;
}
