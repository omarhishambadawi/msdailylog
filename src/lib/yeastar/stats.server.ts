/**
 * Yeastar CDR -> per-agent call statistics (server-only, pure aggregation).
 *
 * Attribution rules (Yeastar P-Series CDR):
 *   - Outbound  -> the agent is `call_from_number` (the extension placing it).
 *   - Inbound   -> the agent is `call_to_number` (the extension that received
 *                  it). NOTE: for queue-distributed inbound calls, call_to_number
 *                  may be the QUEUE number (e.g. 6414), not the answering agent.
 *                  Those are attributed to the queue bucket, not an agent — see
 *                  LIMITATIONS in the accompanying report. Direct-to-extension
 *                  inbound calls attribute correctly.
 *   - Internal  -> attributed to `call_from_number` if it maps to an agent
 *                  (configurable; excluded from productivity KPIs by default).
 *
 * Only extensions that map to a known, active operational agent
 * (customer_care / telesales) are counted. All other extensions — admin/owner/
 * auditor accounts, queues, IVRs, ring groups, trunks, unknown numbers — are
 * excluded from the per-agent view and surfaced separately as "unmatched".
 */
import type { CdrRecord } from "./cdr.server";

export interface AgentRef {
  id: string;          // profiles.id (uuid)
  name: string;        // profiles.full_name
  ext: string;         // Yeastar extension (profiles.yeastar_ext or agent_code)
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
  missed: number;        // disposition NO ANSWER
  busy: number;
  failed: number;
  voicemail: number;
  talkSeconds: number;   // sum of talk_duration on answered calls
  answerRate: number;    // answered / (inbound+outbound) * 100
}

export interface CallStatsResult {
  agents: AgentCallStats[];
  totals: {
    total: number; inbound: number; outbound: number; internal: number;
    answered: number; missed: number; talkSeconds: number; answerRate: number;
  };
  unmatched: {
    records: number;                          // CDRs not attributed to any agent
    extensions: { ext: string; count: number }[]; // top unmatched extensions
  };
  byDay: { date: string; total: number; answered: number; missed: number }[];
}

const isAnswered = (d?: string) => d === "ANSWERED";
const isMissed = (d?: string) => d === "NO ANSWER";

/** Pick the agent-side extension for a CDR based on direction. */
function agentExtFor(r: CdrRecord, includeInternal: boolean): string | null {
  const type = r.call_type;
  if (type === "Outbound") return r.call_from_number ?? null;
  if (type === "Inbound") return r.call_to_number ?? null;
  if (type === "Internal") return includeInternal ? (r.call_from_number ?? null) : null;
  // Unknown type: best-effort, prefer the caller.
  return r.call_from_number ?? r.call_to_number ?? null;
}

function dayKey(ts: number | undefined, tzOffsetMin: number): string {
  if (typeof ts !== "number") return "—";
  const d = new Date(ts * 1000 + tzOffsetMin * 60_000);
  const Y = d.getUTCFullYear();
  const M = String(d.getUTCMonth() + 1).padStart(2, "0");
  const D = String(d.getUTCDate()).padStart(2, "0");
  return `${Y}-${M}-${D}`;
}

export function aggregateAgentStats(
  records: CdrRecord[],
  agents: AgentRef[],
  opts: { includeInternal?: boolean; tzOffsetMin?: number } = {},
): CallStatsResult {
  const includeInternal = opts.includeInternal ?? false;
  const tz = opts.tzOffsetMin ?? Number(process.env.YEASTAR_UTC_OFFSET_MINUTES ?? 180);

  const byExt = new Map<string, AgentRef>();
  for (const a of agents) if (a.ext) byExt.set(String(a.ext).trim(), a);

  const blank = (a: AgentRef): AgentCallStats => ({
    agentId: a.id, name: a.name, ext: a.ext, team: a.team,
    total: 0, inbound: 0, outbound: 0, internal: 0,
    answered: 0, missed: 0, busy: 0, failed: 0, voicemail: 0,
    talkSeconds: 0, answerRate: 0,
  });

  const stats = new Map<string, AgentCallStats>();
  const unmatchedExt = new Map<string, number>();
  let unmatchedRecords = 0;
  const dayMap = new Map<string, { total: number; answered: number; missed: number }>();

  for (const r of records) {
    const ext = agentExtFor(r, includeInternal);
    const agent = ext ? byExt.get(String(ext).trim()) : undefined;

    if (!agent) {
      unmatchedRecords++;
      if (ext) unmatchedExt.set(ext, (unmatchedExt.get(ext) ?? 0) + 1);
      continue;
    }

    let s = stats.get(agent.id);
    if (!s) { s = blank(agent); stats.set(agent.id, s); }

    s.total++;
    if (r.call_type === "Inbound") s.inbound++;
    else if (r.call_type === "Outbound") s.outbound++;
    else if (r.call_type === "Internal") s.internal++;

    if (isAnswered(r.disposition)) { s.answered++; s.talkSeconds += Number(r.talk_duration ?? 0); }
    else if (isMissed(r.disposition)) s.missed++;
    else if (r.disposition === "BUSY") s.busy++;
    else if (r.disposition === "FAILED") s.failed++;
    else if (r.disposition === "VOICEMAIL") s.voicemail++;

    // Daily trend counts only externally-facing calls (in/out), not internal.
    if (r.call_type === "Inbound" || r.call_type === "Outbound") {
      const k = dayKey(r.timestamp, tz);
      const d = dayMap.get(k) ?? { total: 0, answered: 0, missed: 0 };
      d.total++;
      if (isAnswered(r.disposition)) d.answered++;
      else if (isMissed(r.disposition)) d.missed++;
      dayMap.set(k, d);
    }
  }

  const agentRows = [...stats.values()].map((s) => {
    const denom = s.inbound + s.outbound;
    return { ...s, answerRate: denom > 0 ? (s.answered / denom) * 100 : 0 };
  }).sort((a, b) => b.total - a.total);

  const totals = agentRows.reduce(
    (t, s) => {
      t.total += s.total; t.inbound += s.inbound; t.outbound += s.outbound;
      t.internal += s.internal; t.answered += s.answered; t.missed += s.missed;
      t.talkSeconds += s.talkSeconds;
      return t;
    },
    { total: 0, inbound: 0, outbound: 0, internal: 0, answered: 0, missed: 0, talkSeconds: 0, answerRate: 0 },
  );
  const tDenom = totals.inbound + totals.outbound;
  totals.answerRate = tDenom > 0 ? (totals.answered / tDenom) * 100 : 0;

  const unmatchedExtensions = [...unmatchedExt.entries()]
    .map(([ext, count]) => ({ ext, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 25);

  const byDay = [...dayMap.entries()]
    .map(([date, v]) => ({ date, ...v }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return { agents: agentRows, totals, unmatched: { records: unmatchedRecords, extensions: unmatchedExtensions }, byDay };
}
