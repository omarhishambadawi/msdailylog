/**
 * Yeastar CDR aggregation — queue-aware, Internal excluded.
 *
 * A queue call can hit multiple agents in sequence. Each attempt is its
 * own CDR row. We group rows by (linkedid || call_id || uid || new_id)
 * and treat the group as ONE call:
 *
 *   Global (platform) counters:
 *     - direction is majority (rows in a queue call share direction)
 *     - INTERNAL calls are dropped from every counter, chart & percentage
 *     - Answered = ANY row in the group has disposition = ANSWERED
 *     - Missed   = Inbound group, no row answered, max ring >= 5s
 *                  (queue auto-forward flows end with an ANSWERED row and
 *                  are therefore NOT counted as Missed at platform level)
 *     - Abandoned= Inbound group, no row answered, max ring <  5s
 *     - Outbound "No Answer" = Outbound group with no ANSWERED row
 *                  (kept for per-agent stats — NEVER rolled into Missed)
 *
 *   Per-agent counters use RAW rows so per-agent missed reflects the
 *   agent's own unanswered ring even when the queue later forwarded
 *   the call to someone else.
 */
import type { CdrRecord } from "./cdr.server";

export interface AgentRef {
  id: string;
  name: string;
  ext: string;
  team: "customer_care" | "telesales";
}

export interface AgentCallStats {
  agentId: string;
  name: string;
  ext: string;
  team: "customer_care" | "telesales";
  total: number;
  inbound: number;
  outbound: number;
  answered: number;
  missed: number;               // per-agent NO ANSWER (any direction)
  noAnswerOutbound: number;     // per-agent outbound calls customer did not pick up
  busy: number;
  failed: number;
  voicemail: number;
  talkSeconds: number;
  ringSeconds: number;
  handlingSeconds: number;
  longestSec: number;
  avgTalkSec: number;
  avgRingSec: number;
  avgHandlingSec: number;
  answerRate: number;
}

export interface CallTotals {
  total: number;                 // inbound + outbound only (Internal excluded)
  inbound: number;
  outbound: number;
  answered: number;
  missed: number;                // platform (queue) missed only
  abandoned: number;
  noAnswerOutbound: number;      // outbound calls customer didn't pick up
  busy: number;
  failed: number;
  voicemail: number;
  talkSeconds: number;
  ringSeconds: number;
  handlingSeconds: number;
  longestSec: number;
  avgTalkSec: number;            // avg talk on answered groups
  avgWaitSec: number;            // avg ring on answered groups (renamed from avgRing)
  answerRate: number;
  missedRate: number;
  abandonRate: number;
}

export interface HourBucket {
  hour: number;
  total: number;
  answered: number;
  inbound: number;
  outbound: number;
}

export interface DayBucket {
  date: string;
  total: number;
  answered: number;
  missed: number;
  abandoned: number;
  inbound: number;
  outbound: number;
  talkSeconds: number;
  ringSeconds: number;
  handlingSeconds: number;
}

export interface TeamCompareRow {
  team: "customer_care" | "telesales";
  calls: number; answered: number; missed: number; inbound: number; outbound: number;
  talkSeconds: number; handlingSeconds: number;
  answerRate: number; missedRate: number;
}

export interface ConversionRow {
  agentId: string; name: string; ext: string;
  answered: number;
  ordersTotal: number; ordersCompleted: number; ordersCancelled: number; ordersPending: number;
  ordersCash: number; ordersWasfaty: number;
  revenue: number;
  conversionRate: number;      // completed / answered * 100
  revenuePerCall: number;
  revenuePerOrder: number;
}

export interface AnalyticsResult {
  totals: CallTotals;
  agents: AgentCallStats[];
  byDay: DayBucket[];
  byHour: HourBucket[];              // 0..23
  teamCompare: TeamCompareRow[];
  conversion: {
    overall: {
      answered: number; orders: number; completed: number; cancelled: number; pending: number;
      cash: number; wasfaty: number; revenue: number;
      conversionRate: number;        // completed / answered * 100
      revenuePerCall: number; revenuePerOrder: number;
    };
    perAgent: ConversionRow[];
    perDay: { date: string; answered: number; completed: number; rate: number }[];
  };
  unmatched: { records: number; extensions: { ext: string; count: number }[] };
}

export interface OrderRef {
  id: string;
  agent_id: string;
  order_date: string;
  status: string;
  order_type: string | null;
  invoice_value: number | null;
}

const ABANDON_THRESHOLD_SEC = 5;
const QUEUE_LEG_WINDOW_SEC = 120; // legs within 2 min sharing from/to are one call

const isAnswered = (d?: string) => d === "ANSWERED";
const isNoAnswer = (d?: string) => d === "NO ANSWER";
const num = (v: any) => Number(v ?? 0);

/**
 * Group multi-leg queue calls into one call.
 * Prefer PBX-provided call identifiers; only fall back to a from/to/time
 * fingerprint when NONE is present. NEVER fall back to per-row IDs
 * (`uid`, `new_id`, `id`), which are unique per CDR row and defeat grouping.
 */
function groupKey(r: CdrRecord): string {
  const anyR = r as any;
  const cid = anyR.call_id ?? anyR.linkedid ?? anyR.linked_id ?? anyR.pin_code;
  if (cid) return `id:${String(cid)}`;
  const from = String(r.call_from_number ?? "").trim();
  const to = String(r.call_to_number ?? "").trim();
  const bucket = typeof r.timestamp === "number" ? Math.floor(r.timestamp / QUEUE_LEG_WINDOW_SEC) : 0;
  return `fp:${from}|${to}|${bucket}`;
}

function ringOf(r: CdrRecord): number {
  const anyR = r as any;
  return Math.max(num(r.ring_duration), num(anyR.agent_ring_time), num(anyR.wait_time));
}

/** True if a row looks like an internal ext-to-ext call regardless of `call_type`. */
function looksInternal(r: CdrRecord): boolean {
  if (r.call_type === "Internal") return true;
  const from = String(r.call_from_number ?? "").trim();
  const to = String(r.call_to_number ?? "").trim();
  // Both endpoints are short internal extension numbers (≤4 digits)
  if (from && to && /^\d{1,4}$/.test(from) && /^\d{1,4}$/.test(to)) return true;
  return false;
}

function agentExtFor(r: CdrRecord): string | null {
  if (r.call_type === "Outbound") return r.call_from_number ?? null;
  if (r.call_type === "Inbound") return r.call_to_number ?? null;
  return null; // Internal ignored
}

function dayKey(ts: number | undefined, tzOffsetMin: number): string {
  if (typeof ts !== "number") return "—";
  const d = new Date(ts * 1000 + tzOffsetMin * 60_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
function hourOf(ts: number | undefined, tzOffsetMin: number): number {
  if (typeof ts !== "number") return 0;
  const d = new Date(ts * 1000 + tzOffsetMin * 60_000);
  return d.getUTCHours();
}

/** Legacy adaptor kept for the old dashboard component (if referenced). */
export function aggregateAgentStats(
  records: CdrRecord[],
  agents: AgentRef[],
  opts: { tzOffsetMin?: number } = {},
) {
  const r = aggregateAnalytics(records, agents, [], opts);
  return {
    agents: r.agents,
    totals: {
      total: r.totals.total, inbound: r.totals.inbound, outbound: r.totals.outbound,
      answered: r.totals.answered, missed: r.totals.missed,
      talkSeconds: r.totals.talkSeconds, answerRate: r.totals.answerRate,
    },
    unmatched: r.unmatched,
    byDay: r.byDay.map((d) => ({ date: d.date, total: d.total, answered: d.answered, missed: d.missed })),
  };
}

export function aggregateAnalytics(
  records: CdrRecord[],
  agents: AgentRef[],
  orders: OrderRef[],
  opts: { tzOffsetMin?: number } = {},
): AnalyticsResult {
  const tz = opts.tzOffsetMin ?? Number(process.env.YEASTAR_UTC_OFFSET_MINUTES ?? 180);

  const byExt = new Map<string, AgentRef>();
  for (const a of agents) if (a.ext) byExt.set(String(a.ext).trim(), a);

  // Drop Internal / ext-to-ext rows entirely, up front.
  const nonInternal = records.filter(
    (r) => (r.call_type === "Inbound" || r.call_type === "Outbound") && !looksInternal(r),
  );

  // Row-level dedup: identical (timestamp, from, to, disposition, talk) rows
  // sometimes appear when the PBX re-emits a leg on hang-up. Collapse them.
  const seen = new Set<string>();
  const filteredRecords: CdrRecord[] = [];
  for (const r of nonInternal) {
    const fp = `${r.timestamp ?? ""}|${r.call_from_number ?? ""}|${r.call_to_number ?? ""}|${r.disposition ?? ""}|${r.talk_duration ?? ""}|${r.ring_duration ?? ""}`;
    if (seen.has(fp)) continue;
    seen.add(fp);
    filteredRecords.push(r);
  }

  // ---- Group by call ----
  const groups = new Map<string, CdrRecord[]>();
  for (const r of filteredRecords) {
    const k = groupKey(r);
    const arr = groups.get(k);
    if (arr) arr.push(r); else groups.set(k, [r]);
  }

  const totals: CallTotals = {
    total: 0, inbound: 0, outbound: 0,
    answered: 0, missed: 0, abandoned: 0, noAnswerOutbound: 0,
    busy: 0, failed: 0, voicemail: 0,
    talkSeconds: 0, ringSeconds: 0, handlingSeconds: 0,
    longestSec: 0,
    avgTalkSec: 0, avgWaitSec: 0,
    answerRate: 0, missedRate: 0, abandonRate: 0,
  };

  const dayMap = new Map<string, DayBucket>();
  const hourMap = new Map<number, HourBucket>();

  for (const [, rows] of groups) {
    const direction = rows[0].call_type ?? "Unknown";
    if (direction !== "Inbound" && direction !== "Outbound") continue;

    const anyAnswered = rows.some((r) => isAnswered(r.disposition));
    const primary = rows.find((r) => isAnswered(r.disposition)) ?? rows[rows.length - 1];
    const talk = num(primary.talk_duration);
    const ring = Math.max(0, ...rows.map(ringOf));
    const handling = talk + ring;

    totals.total++;
    if (direction === "Inbound") totals.inbound++;
    else totals.outbound++;

    if (anyAnswered) {
      totals.answered++;
      totals.talkSeconds += talk;
      totals.ringSeconds += ring;
      totals.handlingSeconds += handling;
      if (handling > totals.longestSec) totals.longestSec = handling;
    } else {
      const dispSet = new Set(rows.map((r) => r.disposition));
      if (dispSet.has("BUSY")) totals.busy++;
      else if (dispSet.has("FAILED")) totals.failed++;
      else if (dispSet.has("VOICEMAIL")) totals.voicemail++;
      else if (direction === "Inbound") {
        if (ring < ABANDON_THRESHOLD_SEC) totals.abandoned++;
        else totals.missed++;
      } else {
        // Outbound customer didn't pick up — NOT platform missed
        totals.noAnswerOutbound++;
      }
    }

    // Buckets — Inbound + Outbound only
    const ts = primary.timestamp;
    const dk = dayKey(ts, tz);
    const hr = hourOf(ts, tz);
    const day = dayMap.get(dk) ?? { date: dk, total: 0, answered: 0, missed: 0, abandoned: 0, inbound: 0, outbound: 0, talkSeconds: 0, ringSeconds: 0, handlingSeconds: 0 };
    day.total++;
    if (direction === "Inbound") day.inbound++;
    else day.outbound++;
    if (anyAnswered) {
      day.answered++; day.talkSeconds += talk; day.ringSeconds += ring; day.handlingSeconds += handling;
    } else if (direction === "Inbound") {
      if (ring < ABANDON_THRESHOLD_SEC) day.abandoned++; else day.missed++;
    }
    dayMap.set(dk, day);

    const hb = hourMap.get(hr) ?? { hour: hr, total: 0, answered: 0, inbound: 0, outbound: 0 };
    hb.total++;
    if (anyAnswered) hb.answered++;
    if (direction === "Inbound") hb.inbound++; else hb.outbound++;
    hourMap.set(hr, hb);
  }

  totals.avgTalkSec = totals.answered ? totals.talkSeconds / totals.answered : 0;
  totals.avgWaitSec = totals.answered ? totals.ringSeconds / totals.answered : 0;
  totals.answerRate = totals.total ? (totals.answered / totals.total) * 100 : 0;
  totals.missedRate = totals.inbound ? (totals.missed / totals.inbound) * 100 : 0;
  totals.abandonRate = totals.inbound ? (totals.abandoned / totals.inbound) * 100 : 0;

  // ---- Per-agent (from raw rows, Internal already stripped) ----
  const blank = (a: AgentRef): AgentCallStats => ({
    agentId: a.id, name: a.name, ext: a.ext, team: a.team,
    total: 0, inbound: 0, outbound: 0,
    answered: 0, missed: 0, noAnswerOutbound: 0, busy: 0, failed: 0, voicemail: 0,
    talkSeconds: 0, ringSeconds: 0, handlingSeconds: 0,
    longestSec: 0,
    avgTalkSec: 0, avgRingSec: 0, avgHandlingSec: 0, answerRate: 0,
  });
  const perAgent = new Map<string, AgentCallStats>();
  const unmatchedExt = new Map<string, number>();
  let unmatchedRecords = 0;

  for (const r of filteredRecords) {
    const ext = agentExtFor(r);
    const agent = ext ? byExt.get(String(ext).trim()) : undefined;
    if (!agent) {
      unmatchedRecords++;
      if (ext) unmatchedExt.set(ext, (unmatchedExt.get(ext) ?? 0) + 1);
      continue;
    }
    let s = perAgent.get(agent.id);
    if (!s) { s = blank(agent); perAgent.set(agent.id, s); }
    s.total++;
    if (r.call_type === "Inbound") s.inbound++;
    else if (r.call_type === "Outbound") s.outbound++;

    const talk = num(r.talk_duration);
    const ring = num(r.ring_duration);
    if (isAnswered(r.disposition)) {
      s.answered++;
      s.talkSeconds += talk;
      s.ringSeconds += ring;
      const handling = talk + ring;
      s.handlingSeconds += handling;
      if (handling > s.longestSec) s.longestSec = handling;
    } else if (isNoAnswer(r.disposition)) {
      s.missed++;
      if (r.call_type === "Outbound") s.noAnswerOutbound++;
    } else if (r.disposition === "BUSY") s.busy++;
    else if (r.disposition === "FAILED") s.failed++;
    else if (r.disposition === "VOICEMAIL") s.voicemail++;
  }

  const agentRows = [...perAgent.values()].map((s) => ({
    ...s,
    avgTalkSec: s.answered ? s.talkSeconds / s.answered : 0,
    avgRingSec: s.answered ? s.ringSeconds / s.answered : 0,
    avgHandlingSec: s.answered ? s.handlingSeconds / s.answered : 0,
    answerRate: s.total ? (s.answered / s.total) * 100 : 0,
  })).sort((a, b) => b.total - a.total);

  // ---- Team compare ----
  const teams: Record<"customer_care" | "telesales", TeamCompareRow> = {
    customer_care: { team: "customer_care", calls: 0, answered: 0, missed: 0, inbound: 0, outbound: 0, talkSeconds: 0, handlingSeconds: 0, answerRate: 0, missedRate: 0 },
    telesales:    { team: "telesales",    calls: 0, answered: 0, missed: 0, inbound: 0, outbound: 0, talkSeconds: 0, handlingSeconds: 0, answerRate: 0, missedRate: 0 },
  };
  for (const a of agentRows) {
    const t = teams[a.team];
    t.calls += a.total; t.answered += a.answered; t.missed += a.missed;
    t.inbound += a.inbound; t.outbound += a.outbound;
    t.talkSeconds += a.talkSeconds; t.handlingSeconds += a.handlingSeconds;
  }
  for (const t of Object.values(teams)) {
    t.answerRate = t.calls ? (t.answered / t.calls) * 100 : 0;
    t.missedRate = t.calls ? (t.missed / t.calls) * 100 : 0;
  }

  // ---- Conversion (telesales only) ----
  // Formula: completed telesales orders / answered telesales calls * 100
  const telesalesAgents = agentRows.filter((a) => a.team === "telesales");
  const teleAgentIds = new Set(telesalesAgents.map((a) => a.agentId));
  const teleOrders = orders.filter((o) => teleAgentIds.has(o.agent_id));

  const overall = {
    answered: telesalesAgents.reduce((s, a) => s + a.answered, 0),
    orders: teleOrders.length,
    completed: teleOrders.filter((o) => o.status === "Completed").length,
    cancelled: teleOrders.filter((o) => o.status === "Cancelled").length,
    pending: teleOrders.filter((o) => o.status === "Pending").length,
    cash: teleOrders.filter((o) => o.order_type === "Cash").length,
    wasfaty: teleOrders.filter((o) => o.order_type === "Wasfaty").length,
    revenue: teleOrders.reduce((s, o) => s + num(o.invoice_value), 0),
    conversionRate: 0,
    revenuePerCall: 0,
    revenuePerOrder: 0,
  };
  overall.conversionRate = overall.answered ? (overall.completed / overall.answered) * 100 : 0;
  overall.revenuePerCall = overall.answered ? overall.revenue / overall.answered : 0;
  overall.revenuePerOrder = overall.orders ? overall.revenue / overall.orders : 0;

  const perAgentConv: ConversionRow[] = telesalesAgents.map((a) => {
    const os = orders.filter((o) => o.agent_id === a.agentId);
    const completed = os.filter((o) => o.status === "Completed").length;
    const row: ConversionRow = {
      agentId: a.agentId, name: a.name, ext: a.ext,
      answered: a.answered,
      ordersTotal: os.length,
      ordersCompleted: completed,
      ordersCancelled: os.filter((o) => o.status === "Cancelled").length,
      ordersPending: os.filter((o) => o.status === "Pending").length,
      ordersCash: os.filter((o) => o.order_type === "Cash").length,
      ordersWasfaty: os.filter((o) => o.order_type === "Wasfaty").length,
      revenue: os.reduce((s, o) => s + num(o.invoice_value), 0),
      conversionRate: a.answered ? (completed / a.answered) * 100 : 0,
      revenuePerCall: a.answered ? os.reduce((s, o) => s + num(o.invoice_value), 0) / a.answered : 0,
      revenuePerOrder: os.length ? os.reduce((s, o) => s + num(o.invoice_value), 0) / os.length : 0,
    };
    return row;
  }).sort((a, b) => b.conversionRate - a.conversionRate);

  // per-day conversion (telesales)
  const dayCompleted = new Map<string, number>();
  for (const o of teleOrders) {
    if (o.status !== "Completed") continue;
    dayCompleted.set(o.order_date, (dayCompleted.get(o.order_date) ?? 0) + 1);
  }
  // answered by telesales per day: pro-rate day.answered by tele share
  const teleShare = totals.answered ? teams.telesales.answered / Math.max(1, totals.answered) : 0;
  const perDay = [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date)).map((d) => {
    const answered = Math.round(d.answered * teleShare);
    const completed = dayCompleted.get(d.date) ?? 0;
    return { date: d.date, answered, completed, rate: answered ? (completed / answered) * 100 : 0 };
  });

  // Ensure hour 0..23
  const byHour: HourBucket[] = [];
  for (let h = 0; h < 24; h++) byHour.push(hourMap.get(h) ?? { hour: h, total: 0, answered: 0, inbound: 0, outbound: 0 });

  return {
    totals,
    agents: agentRows,
    byDay: [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
    byHour,
    teamCompare: Object.values(teams),
    conversion: { overall, perAgent: perAgentConv, perDay },
    unmatched: {
      records: unmatchedRecords,
      extensions: [...unmatchedExt.entries()].map(([ext, count]) => ({ ext, count }))
        .sort((a, b) => b.count - a.count).slice(0, 25),
    },
  };
}
