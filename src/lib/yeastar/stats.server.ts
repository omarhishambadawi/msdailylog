/**
 * Yeastar CDR aggregation — queue-aware.
 *
 * A queue call can hit multiple agents in sequence. Each attempt is its
 * own CDR row. We group rows by (linkedid || call_id || uid || new_id)
 * and treat the group as ONE call:
 *   - Group answered = any row ANSWERED
 *   - Group missed   = no row ANSWERED and duration > threshold (5s)
 *   - Group abandoned = no row ANSWERED and total ring < threshold
 *   - Per-agent missed = the agent's row is NO ANSWER, even if the group
 *     was later answered by someone else.
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
  internal: number;
  answered: number;
  missed: number;
  busy: number;
  failed: number;
  voicemail: number;
  talkSeconds: number;
  ringSeconds: number;
  handlingSeconds: number;
  longestSec: number;
  shortestSec: number;
  avgTalkSec: number;
  avgRingSec: number;
  avgHandlingSec: number;
  answerRate: number;
}

export interface CallTotals {
  total: number; inbound: number; outbound: number; internal: number;
  answered: number; missed: number; abandoned: number;
  busy: number; failed: number; voicemail: number;
  talkSeconds: number; ringSeconds: number; handlingSeconds: number;
  longestSec: number; shortestSec: number;
  avgTalkSec: number; avgRingSec: number; avgHandlingSec: number; avgDurationSec: number;
  answerRate: number; missedRate: number; abandonRate: number;
  activeAgents: number; callsPerAgent: number;
}

export interface HourBucket { hour: number; total: number; answered: number; missed: number; }
export interface DayBucket { date: string; total: number; answered: number; missed: number; abandoned: number; inbound: number; outbound: number; talkSeconds: number; ringSeconds: number; handlingSeconds: number; }
export interface HeatCell { date: string; hour: number; value: number; }

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
  conversionRate: number;      // ordersTotal / answered * 100
  completedConversion: number; // completed / answered
  cashConversion: number;
  wasfatyConversion: number;
  revenuePerCall: number;
  revenuePerOrder: number;
  ordersPerCall: number;
}

export interface AnalyticsResult {
  totals: CallTotals;
  agents: AgentCallStats[];
  byDay: DayBucket[];
  byHour: HourBucket[];         // 0..23
  heatmap: HeatCell[];          // date x hour
  teamCompare: TeamCompareRow[];
  missedBreakdown: { missed: number; abandoned: number; busy: number; failed: number; voicemail: number; noAnswer: number };
  conversion: {
    overall: {
      answered: number; orders: number; completed: number; cancelled: number; pending: number;
      cash: number; wasfaty: number; revenue: number;
      conversionRate: number; cashConversion: number; wasfatyConversion: number;
      revenuePerCall: number; revenuePerOrder: number; ordersPerCall: number;
    };
    perAgent: ConversionRow[];
    perDay: { date: string; answered: number; orders: number; rate: number }[];
    perMonth: { month: string; answered: number; orders: number; rate: number }[];
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

const isAnswered = (d?: string) => d === "ANSWERED";
const isNoAnswer = (d?: string) => d === "NO ANSWER";

function num(v: any) { return Number(v ?? 0); }

function groupKey(r: CdrRecord): string {
  return String(
    (r as any).linkedid ?? r.call_id ?? r.uid ?? r.new_id ?? r.id ??
    `${r.call_from_number ?? ""}-${r.call_to_number ?? ""}-${r.timestamp ?? ""}`,
  );
}

function agentExtFor(r: CdrRecord, includeInternal: boolean): string | null {
  const type = r.call_type;
  if (type === "Outbound") return r.call_from_number ?? null;
  if (type === "Inbound") return r.call_to_number ?? null;
  if (type === "Internal") return includeInternal ? (r.call_from_number ?? null) : null;
  return r.call_from_number ?? r.call_to_number ?? null;
}

function dayKey(ts: number | undefined, tzOffsetMin: number): string {
  if (typeof ts !== "number") return "—";
  const d = new Date(ts * 1000 + tzOffsetMin * 60_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
function monthKey(ts: number | undefined, tzOffsetMin: number): string {
  if (typeof ts !== "number") return "—";
  const d = new Date(ts * 1000 + tzOffsetMin * 60_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
function hourOf(ts: number | undefined, tzOffsetMin: number): number {
  if (typeof ts !== "number") return 0;
  const d = new Date(ts * 1000 + tzOffsetMin * 60_000);
  return d.getUTCHours();
}

/**
 * Legacy simple aggregator, retained for the dashboard's old call-center
 * component. Prefer aggregateAnalytics for the new module.
 */
export function aggregateAgentStats(
  records: CdrRecord[],
  agents: AgentRef[],
  opts: { includeInternal?: boolean; tzOffsetMin?: number } = {},
) {
  const r = aggregateAnalytics(records, agents, [], opts);
  return {
    agents: r.agents,
    totals: {
      total: r.totals.total, inbound: r.totals.inbound, outbound: r.totals.outbound,
      internal: r.totals.internal, answered: r.totals.answered, missed: r.totals.missed,
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
  opts: { includeInternal?: boolean; tzOffsetMin?: number } = {},
): AnalyticsResult {
  const includeInternal = opts.includeInternal ?? false;
  const tz = opts.tzOffsetMin ?? Number(process.env.YEASTAR_UTC_OFFSET_MINUTES ?? 180);

  const byExt = new Map<string, AgentRef>();
  for (const a of agents) if (a.ext) byExt.set(String(a.ext).trim(), a);
  const agentIds = new Set(agents.map((a) => a.id));

  // ---- Group by call for queue-aware global totals ----
  const groups = new Map<string, CdrRecord[]>();
  for (const r of records) {
    const k = groupKey(r);
    const arr = groups.get(k);
    if (arr) arr.push(r); else groups.set(k, [r]);
  }

  const totals: CallTotals = {
    total: 0, inbound: 0, outbound: 0, internal: 0,
    answered: 0, missed: 0, abandoned: 0,
    busy: 0, failed: 0, voicemail: 0,
    talkSeconds: 0, ringSeconds: 0, handlingSeconds: 0,
    longestSec: 0, shortestSec: 0,
    avgTalkSec: 0, avgRingSec: 0, avgHandlingSec: 0, avgDurationSec: 0,
    answerRate: 0, missedRate: 0, abandonRate: 0,
    activeAgents: 0, callsPerAgent: 0,
  };
  const missedBreakdown = { missed: 0, abandoned: 0, busy: 0, failed: 0, voicemail: 0, noAnswer: 0 };

  const dayMap = new Map<string, DayBucket>();
  const hourMap = new Map<number, HourBucket>();
  const heatMap = new Map<string, HeatCell>();
  let totalDurationSum = 0;
  let shortestSeen = Number.POSITIVE_INFINITY;

  for (const [, rows] of groups) {
    // Direction: majority (queue rings share direction anyway)
    const direction = rows[0].call_type ?? "Unknown";
    const anyAnswered = rows.some((r) => isAnswered(r.disposition));
    // Prefer answered row for timing, else last row
    const primary = rows.find((r) => isAnswered(r.disposition)) ?? rows[rows.length - 1];
    const talk = num(primary.talk_duration);
    const ring = Math.max(...rows.map((r) => num(r.ring_duration)));
    const duration = num(primary.duration) || (talk + ring);
    const handling = talk + ring;

    totals.total++;
    totalDurationSum += duration;
    if (direction === "Inbound") totals.inbound++;
    else if (direction === "Outbound") totals.outbound++;
    else if (direction === "Internal") totals.internal++;

    if (anyAnswered) {
      totals.answered++;
      totals.talkSeconds += talk;
      totals.ringSeconds += ring;
      totals.handlingSeconds += handling;
      if (handling > totals.longestSec) totals.longestSec = handling;
      if (handling > 0 && handling < shortestSeen) shortestSeen = handling;
    } else {
      // Categorize non-answered group
      const dispSet = new Set(rows.map((r) => r.disposition));
      if (dispSet.has("BUSY")) { totals.busy++; missedBreakdown.busy++; }
      else if (dispSet.has("FAILED")) { totals.failed++; missedBreakdown.failed++; }
      else if (dispSet.has("VOICEMAIL")) { totals.voicemail++; missedBreakdown.voicemail++; }
      else {
        // NO ANSWER: abandoned vs missed by ring duration
        if (direction === "Inbound" && ring < ABANDON_THRESHOLD_SEC) {
          totals.abandoned++; missedBreakdown.abandoned++;
        } else {
          totals.missed++; missedBreakdown.missed++;
        }
        missedBreakdown.noAnswer++;
      }
    }

    // Time buckets — use primary row's timestamp
    const ts = primary.timestamp;
    const dk = dayKey(ts, tz);
    const hr = hourOf(ts, tz);
    const day = dayMap.get(dk) ?? { date: dk, total: 0, answered: 0, missed: 0, abandoned: 0, inbound: 0, outbound: 0, talkSeconds: 0, ringSeconds: 0, handlingSeconds: 0 };
    day.total++;
    if (direction === "Inbound") day.inbound++;
    else if (direction === "Outbound") day.outbound++;
    if (anyAnswered) { day.answered++; day.talkSeconds += talk; day.ringSeconds += ring; day.handlingSeconds += handling; }
    else {
      const inb = direction === "Inbound";
      if (inb && ring < ABANDON_THRESHOLD_SEC) day.abandoned++;
      else day.missed++;
    }
    dayMap.set(dk, day);

    const hb = hourMap.get(hr) ?? { hour: hr, total: 0, answered: 0, missed: 0 };
    hb.total++;
    if (anyAnswered) hb.answered++; else hb.missed++;
    hourMap.set(hr, hb);

    const hk = `${dk}|${hr}`;
    const cell = heatMap.get(hk) ?? { date: dk, hour: hr, value: 0 };
    cell.value++;
    heatMap.set(hk, cell);
  }

  totals.avgTalkSec = totals.answered ? totals.talkSeconds / totals.answered : 0;
  totals.avgRingSec = totals.total ? totals.ringSeconds / Math.max(1, totals.answered) : 0;
  totals.avgHandlingSec = totals.answered ? totals.handlingSeconds / totals.answered : 0;
  totals.avgDurationSec = totals.total ? totalDurationSum / totals.total : 0;
  totals.shortestSec = shortestSeen === Number.POSITIVE_INFINITY ? 0 : shortestSeen;
  const denom = totals.inbound + totals.outbound;
  totals.answerRate = denom ? (totals.answered / denom) * 100 : 0;
  totals.missedRate = denom ? (totals.missed / denom) * 100 : 0;
  totals.abandonRate = totals.inbound ? (totals.abandoned / totals.inbound) * 100 : 0;

  // ---- Per-agent stats (from RAW rows so per-agent missed is correct) ----
  const blank = (a: AgentRef): AgentCallStats => ({
    agentId: a.id, name: a.name, ext: a.ext, team: a.team,
    total: 0, inbound: 0, outbound: 0, internal: 0,
    answered: 0, missed: 0, busy: 0, failed: 0, voicemail: 0,
    talkSeconds: 0, ringSeconds: 0, handlingSeconds: 0,
    longestSec: 0, shortestSec: Number.POSITIVE_INFINITY as any,
    avgTalkSec: 0, avgRingSec: 0, avgHandlingSec: 0, answerRate: 0,
  });
  const perAgent = new Map<string, AgentCallStats>();
  const unmatchedExt = new Map<string, number>();
  let unmatchedRecords = 0;

  for (const r of records) {
    const ext = agentExtFor(r, includeInternal);
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
    else if (r.call_type === "Internal") s.internal++;

    const talk = num(r.talk_duration);
    const ring = num(r.ring_duration);
    if (isAnswered(r.disposition)) {
      s.answered++;
      s.talkSeconds += talk;
      s.ringSeconds += ring;
      s.handlingSeconds += talk + ring;
      const handling = talk + ring;
      if (handling > s.longestSec) s.longestSec = handling;
      if (handling > 0 && handling < (s.shortestSec as number)) s.shortestSec = handling;
    } else if (isNoAnswer(r.disposition)) s.missed++;
    else if (r.disposition === "BUSY") s.busy++;
    else if (r.disposition === "FAILED") s.failed++;
    else if (r.disposition === "VOICEMAIL") s.voicemail++;
  }

  const agentRows = [...perAgent.values()].map((s) => {
    const d = s.inbound + s.outbound;
    return {
      ...s,
      shortestSec: s.shortestSec === Number.POSITIVE_INFINITY ? 0 : (s.shortestSec as number),
      avgTalkSec: s.answered ? s.talkSeconds / s.answered : 0,
      avgRingSec: s.answered ? s.ringSeconds / s.answered : 0,
      avgHandlingSec: s.answered ? s.handlingSeconds / s.answered : 0,
      answerRate: d ? (s.answered / d) * 100 : 0,
    };
  }).sort((a, b) => b.total - a.total);

  totals.activeAgents = agentRows.length;
  totals.callsPerAgent = agentRows.length ? totals.total / agentRows.length : 0;

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
    const d = t.inbound + t.outbound;
    t.answerRate = d ? (t.answered / d) * 100 : 0;
    t.missedRate = d ? (t.missed / d) * 100 : 0;
  }

  // ---- Conversion (telesales only) ----
  const telesalesAgents = agentRows.filter((a) => a.team === "telesales");
  const answeredByAgent = new Map<string, number>();
  for (const a of telesalesAgents) answeredByAgent.set(a.agentId, a.answered);

  const teleOrders = orders.filter((o) => answeredByAgent.has(o.agent_id));
  const overall = {
    answered: 0, orders: teleOrders.length,
    completed: 0, cancelled: 0, pending: 0,
    cash: 0, wasfaty: 0, revenue: 0,
    conversionRate: 0, cashConversion: 0, wasfatyConversion: 0,
    revenuePerCall: 0, revenuePerOrder: 0, ordersPerCall: 0,
  };
  for (const [, a] of answeredByAgent) overall.answered += a;
  for (const o of teleOrders) {
    if (o.status === "Completed") overall.completed++;
    else if (o.status === "Cancelled") overall.cancelled++;
    else if (o.status === "Pending") overall.pending++;
    if (o.order_type === "Cash") overall.cash++;
    else if (o.order_type === "Wasfaty") overall.wasfaty++;
    overall.revenue += num(o.invoice_value);
  }
  overall.conversionRate = overall.answered ? (overall.orders / overall.answered) * 100 : 0;
  overall.cashConversion = overall.answered ? (overall.cash / overall.answered) * 100 : 0;
  overall.wasfatyConversion = overall.answered ? (overall.wasfaty / overall.answered) * 100 : 0;
  overall.revenuePerCall = overall.answered ? overall.revenue / overall.answered : 0;
  overall.revenuePerOrder = overall.orders ? overall.revenue / overall.orders : 0;
  overall.ordersPerCall = overall.answered ? overall.orders / overall.answered : 0;

  const perAgentConv: ConversionRow[] = telesalesAgents.map((a) => {
    const os = orders.filter((o) => o.agent_id === a.agentId);
    const r: ConversionRow = {
      agentId: a.agentId, name: a.name, ext: a.ext,
      answered: a.answered,
      ordersTotal: os.length,
      ordersCompleted: os.filter((o) => o.status === "Completed").length,
      ordersCancelled: os.filter((o) => o.status === "Cancelled").length,
      ordersPending: os.filter((o) => o.status === "Pending").length,
      ordersCash: os.filter((o) => o.order_type === "Cash").length,
      ordersWasfaty: os.filter((o) => o.order_type === "Wasfaty").length,
      revenue: os.reduce((s, o) => s + num(o.invoice_value), 0),
      conversionRate: 0, completedConversion: 0, cashConversion: 0, wasfatyConversion: 0,
      revenuePerCall: 0, revenuePerOrder: 0, ordersPerCall: 0,
    };
    if (a.answered > 0) {
      r.conversionRate = (r.ordersTotal / a.answered) * 100;
      r.completedConversion = (r.ordersCompleted / a.answered) * 100;
      r.cashConversion = (r.ordersCash / a.answered) * 100;
      r.wasfatyConversion = (r.ordersWasfaty / a.answered) * 100;
      r.revenuePerCall = r.revenue / a.answered;
      r.ordersPerCall = r.ordersTotal / a.answered;
    }
    r.revenuePerOrder = r.ordersTotal ? r.revenue / r.ordersTotal : 0;
    return r;
  }).sort((a, b) => b.conversionRate - a.conversionRate);

  // per-day / per-month conversion
  const dayAns = new Map<string, number>();
  for (const day of dayMap.values()) dayAns.set(day.date, day.answered);
  // approximate "answered by telesales per day" via team share
  const teleShare = totals.answered ? teams.telesales.answered / Math.max(1, totals.answered) : 0;
  const ordersPerDay = new Map<string, number>();
  const ordersPerMonth = new Map<string, number>();
  for (const o of teleOrders) {
    ordersPerDay.set(o.order_date, (ordersPerDay.get(o.order_date) ?? 0) + 1);
    const m = o.order_date.slice(0, 7);
    ordersPerMonth.set(m, (ordersPerMonth.get(m) ?? 0) + 1);
  }
  const perDay = [...new Set([...dayAns.keys(), ...ordersPerDay.keys()])].sort().map((date) => {
    const answered = Math.round((dayAns.get(date) ?? 0) * teleShare);
    const os = ordersPerDay.get(date) ?? 0;
    return { date, answered, orders: os, rate: answered ? (os / answered) * 100 : 0 };
  });
  const monthAns = new Map<string, number>();
  for (const [d, a] of dayAns) {
    const m = d.slice(0, 7);
    monthAns.set(m, (monthAns.get(m) ?? 0) + a);
  }
  const perMonth = [...new Set([...monthAns.keys(), ...ordersPerMonth.keys()])].sort().map((month) => {
    const answered = Math.round((monthAns.get(month) ?? 0) * teleShare);
    const os = ordersPerMonth.get(month) ?? 0;
    return { month, answered, orders: os, rate: answered ? (os / answered) * 100 : 0 };
  });

  // Ensure hour 0..23 exists
  const byHour: HourBucket[] = [];
  for (let h = 0; h < 24; h++) byHour.push(hourMap.get(h) ?? { hour: h, total: 0, answered: 0, missed: 0 });

  return {
    totals,
    agents: agentRows,
    byDay: [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
    byHour,
    heatmap: [...heatMap.values()],
    teamCompare: Object.values(teams),
    missedBreakdown,
    conversion: { overall, perAgent: perAgentConv, perDay, perMonth },
    unmatched: {
      records: unmatchedRecords,
      extensions: [...unmatchedExt.entries()].map(([ext, count]) => ({ ext, count }))
        .sort((a, b) => b.count - a.count).slice(0, 25),
    },
  };
}
