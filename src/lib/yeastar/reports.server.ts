/**
 * Yeastar Call Analytics — OpenAPI-only implementation.
 *
 * Single documented data source:
 *   GET /openapi/v1.0/cdr/list
 *     ?page=<n>&page_size=100
 *     &sort_by=time_start&order_by=desc
 *     &start_time=yyyy-MM-dd HH:mm:ss
 *     &end_time=yyyy-MM-dd HH:mm:ss
 *
 * We do NOT touch /api/v2.0/*, websessions, cookies, or PBX admin credentials.
 * The endpoint is authenticated with the OpenAPI access_token appended by
 * `yeastarFetch()` (see ./client.server.ts).
 *
 * Attribution model
 * -----------------
 * Every CDR row exposes `call_from` / `call_to` (either an extension number
 * or an external phone number) plus `call_type`. We compute an "extension
 * side" per row:
 *   - Inbound  : the extension is on `call_to`
 *   - Outbound : the extension is on `call_from`
 *   - Internal : both sides may be extensions; each side is credited once
 *
 * A row is kept only if its extension side matches an ext_num in
 * `yeastar_extension_map` (filtered by the requested team). Everything else
 * is silently ignored — including calls that never touched a mapped agent.
 *
 * KPI definitions
 * ---------------
 *   total       = rows attributed to a mapped extension
 *   answered    = talk_duration > 0  OR  status == "ANSWERED"
 *   missed      = total - answered
 *   inbound     = rows classified Inbound
 *   outbound    = rows classified Outbound
 *   answerRate  = answered / total          (percentage, 1 decimal)
 *   missedRate  = missed  / total           (percentage, 1 decimal)
 *   talkTimeSec = sum of talk_duration on answered rows
 *
 * Pagination is capped at MAX_PAGES to keep worker cost bounded; if the
 * window overflows we surface `truncated: true` in the result.
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
    avgTalkSec: number;
  };
  mapping: {
    mappedExtensions: number;
    missingOnPbx: string[];
    unmappedFromPbx: string[];
  };
  cdr: {
    endpoint: string;
    pagesFetched: number;
    rowsFetched: number;
    rowsAttributed: number;
    truncated: boolean;
    pageSize: number;
    maxPages: number;
  };
  elapsedMs: number;
}

const CDR_PATH = "/openapi/v1.0/cdr/list";
const PAGE_SIZE = 100;
const MAX_PAGES = 200; // 20 000 rows / window — enough for a day at high volume

// ---- helpers ---------------------------------------------------------------

function pad(n: number) { return String(n).padStart(2, "0"); }

/** Yeastar CDR expects PBX-local "yyyy-MM-dd HH:mm:ss". */
function fmtStart(iso: string): string { return `${iso} 00:00:00`; }
function fmtEnd(iso: string): string { return `${iso} 23:59:59`; }

interface RawCdr {
  id?: string | number;
  uuid?: string;
  time_start?: string;
  call_from?: string;
  call_to?: string;
  src?: string; dst?: string;
  src_name?: string; dst_name?: string;
  call_type?: string;
  status?: string;
  talk_duration?: number | string;
  talking?: number | string;
  duration?: number | string;
  billsec?: number | string;
}
interface CdrPage {
  errcode?: number; errmsg?: string;
  total_number?: number;
  cdr_list?: RawCdr[];
  data?: RawCdr[];
  list?: RawCdr[];
}

function pickList(json: CdrPage | null): RawCdr[] {
  if (!json) return [];
  return json.cdr_list ?? json.data ?? json.list ?? [];
}

function toNum(v: unknown): number {
  if (v == null || v === "") return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function isExtensionish(s: string | undefined | null): boolean {
  // Yeastar internal extensions are short numeric strings (2–7 digits).
  if (!s) return false;
  return /^\d{2,7}$/.test(s);
}

type Direction = "Inbound" | "Outbound" | "Internal" | "Other";

function classify(row: RawCdr): Direction {
  const t = String(row.call_type ?? "").toLowerCase();
  if (t.includes("inbound")) return "Inbound";
  if (t.includes("outbound")) return "Outbound";
  if (t.includes("internal")) return "Internal";
  // Fallback: infer from ext-shape of both sides.
  const from = row.call_from ?? row.src ?? "";
  const to = row.call_to ?? row.dst ?? "";
  const fromExt = isExtensionish(from);
  const toExt = isExtensionish(to);
  if (fromExt && toExt) return "Internal";
  if (!fromExt && toExt) return "Inbound";
  if (fromExt && !toExt) return "Outbound";
  return "Other";
}

function isAnswered(row: RawCdr): boolean {
  const talk = toNum(row.talk_duration ?? row.talking ?? row.billsec);
  if (talk > 0) return true;
  const s = String(row.status ?? "").toUpperCase();
  return s === "ANSWERED";
}

function talkSec(row: RawCdr): number {
  return toNum(row.talk_duration ?? row.talking ?? row.billsec);
}

// ---- pagination ------------------------------------------------------------

async function fetchAllCdr(from: string, to: string): Promise<{ rows: RawCdr[]; pages: number; truncated: boolean }> {
  const out: RawCdr[] = [];
  let pages = 0;
  let truncated = false;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { httpStatus, json, body } = await yeastarFetch<CdrPage>(CDR_PATH, {
      page, page_size: PAGE_SIZE,
      sort_by: "time_start", order_by: "desc",
      start_time: fmtStart(from),
      end_time: fmtEnd(to),
    });
    if (httpStatus !== 200 || !json || json.errcode !== 0) {
      throw new Error(`${CDR_PATH} failed page=${page}: HTTP ${httpStatus} errcode=${json?.errcode ?? "n/a"} errmsg=${json?.errmsg ?? "n/a"} body=${body.slice(0, 200)}`);
    }
    const list = pickList(json);
    pages = page;
    out.push(...list);
    if (list.length < PAGE_SIZE) break;
    if (page === MAX_PAGES) { truncated = true; break; }
  }
  return { rows: out, pages, truncated };
}

// ---- aggregation -----------------------------------------------------------

interface Bucket {
  total: number; answered: number; missed: number;
  inbound: number; outbound: number;
  inboundAnswered: number; outboundAnswered: number;
  talkTimeSec: number;
}
function emptyBucket(): Bucket {
  return { total: 0, answered: 0, missed: 0, inbound: 0, outbound: 0, inboundAnswered: 0, outboundAnswered: 0, talkTimeSec: 0 };
}
function credit(b: Bucket, row: RawCdr, direction: "Inbound" | "Outbound") {
  const answered = isAnswered(row);
  b.total += 1;
  if (answered) { b.answered += 1; b.talkTimeSec += talkSec(row); }
  else b.missed += 1;
  if (direction === "Inbound") {
    b.inbound += 1;
    if (answered) b.inboundAnswered += 1;
  } else {
    b.outbound += 1;
    if (answered) b.outboundAnswered += 1;
  }
}

interface Attribution {
  ext_num: string;
  direction: "Inbound" | "Outbound";
}

/**
 * Returns the mapped-extension sides of a CDR row. A row can produce 0, 1, or
 * 2 attributions (0 when neither side is a mapped extension, 2 for internal
 * calls between two mapped agents).
 */
function attribute(row: RawCdr, mappedNums: Set<string>): Attribution[] {
  const from = row.call_from ?? row.src ?? "";
  const to = row.call_to ?? row.dst ?? "";
  const dir = classify(row);
  const acc: Attribution[] = [];
  switch (dir) {
    case "Inbound":
      if (mappedNums.has(to)) acc.push({ ext_num: to, direction: "Inbound" });
      break;
    case "Outbound":
      if (mappedNums.has(from)) acc.push({ ext_num: from, direction: "Outbound" });
      break;
    case "Internal":
      if (mappedNums.has(from)) acc.push({ ext_num: from, direction: "Outbound" });
      if (mappedNums.has(to)) acc.push({ ext_num: to, direction: "Inbound" });
      break;
    default:
      if (mappedNums.has(from)) acc.push({ ext_num: from, direction: "Outbound" });
      else if (mappedNums.has(to)) acc.push({ ext_num: to, direction: "Inbound" });
  }
  return acc;
}

// ---- public API ------------------------------------------------------------

export function resetReportProbeCache() { /* no-op; kept for API compatibility */ }

export async function fetchCallStatistics(opts: {
  from: string; to: string; team: TeamFilter; communicationType: CommunicationType;
}): Promise<CallStatsResult> {
  const started = Date.now();
  const ctx = await resolveMappingContext();

  // Mapped extension numbers to attribute against, respecting team filter.
  const mappedNums = new Set<string>();
  for (const [ext, row] of ctx.byExtNum) {
    if (opts.team !== "all" && row.team !== opts.team) continue;
    mappedNums.add(ext);
  }

  const perExt = new Map<string, Bucket>();
  let rowsAttributed = 0;

  const { rows: cdrRows, pages, truncated } = await fetchAllCdr(opts.from, opts.to);

  for (const row of cdrRows) {
    const atts = attribute(row, mappedNums);
    for (const a of atts) {
      if (opts.communicationType !== "All" && a.direction !== opts.communicationType) continue;
      let b = perExt.get(a.ext_num);
      if (!b) { b = emptyBucket(); perExt.set(a.ext_num, b); }
      credit(b, row, a.direction);
      rowsAttributed += 1;
    }
  }

  const rows: CallStatsRow[] = [];
  for (const [ext_num, b] of perExt) {
    const mapped = ctx.byExtNum.get(ext_num);
    if (!mapped) continue;
    rows.push({
      ext_num,
      ext_name: mapped.agent_name || ext_num,
      group: mapped.team,
      agent_code: mapped.agent_code ?? ext_num,
      total: b.total,
      answered: b.answered,
      missed: b.missed,
      inbound: b.inbound,
      outbound: b.outbound,
      inboundAnswered: b.inboundAnswered,
      outboundAnswered: b.outboundAnswered,
      answerRate: b.total > 0 ? Math.round((b.answered / b.total) * 1000) / 10 : 0,
      talkTimeSec: b.talkTimeSec,
    });
  }
  rows.sort((a, b) => b.total - a.total);

  const sum = rows.reduce(
    (acc, r) => {
      acc.total += r.total; acc.answered += r.answered; acc.missed += r.missed;
      acc.inbound += r.inbound; acc.outbound += r.outbound; acc.talkTimeSec += r.talkTimeSec;
      return acc;
    },
    { total: 0, answered: 0, missed: 0, inbound: 0, outbound: 0, talkTimeSec: 0 },
  );
  const totals = {
    total: sum.total, answered: sum.answered, missed: sum.missed,
    inbound: sum.inbound, outbound: sum.outbound,
    answerRate: sum.total > 0 ? Math.round((sum.answered / sum.total) * 1000) / 10 : 0,
    missedRate: sum.total > 0 ? Math.round((sum.missed / sum.total) * 1000) / 10 : 0,
    avgTalkSec: sum.answered > 0 ? Math.round(sum.talkTimeSec / sum.answered) : 0,
  };

  console.log(`[yeastar cdr] window=${opts.from}..${opts.to} pages=${pages} cdrRows=${cdrRows.length} attributed=${rowsAttributed} mapped=${mappedNums.size} truncated=${truncated}`);

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
    cdr: {
      endpoint: CDR_PATH,
      pagesFetched: pages,
      rowsFetched: cdrRows.length,
      rowsAttributed,
      truncated,
      pageSize: PAGE_SIZE,
      maxPages: MAX_PAGES,
    },
    elapsedMs: Date.now() - started,
  };
}

// ---- daily volume ----------------------------------------------------------

export interface DailyPoint {
  date: string;
  total: number; answered: number; missed: number;
  inbound: number; outbound: number;
}

function dayKey(iso: string): string { return iso.slice(0, 10); }

/**
 * Reuses the same CDR pull as fetchCallStatistics — we walk the window once
 * and bucket per day. No extra network calls per day.
 */
export async function fetchDailyVolume(opts: {
  from: string; to: string; team: TeamFilter; communicationType: CommunicationType;
}): Promise<DailyPoint[]> {
  const ctx = await resolveMappingContext();
  const mappedNums = new Set<string>();
  for (const [ext, row] of ctx.byExtNum) {
    if (opts.team !== "all" && row.team !== opts.team) continue;
    mappedNums.add(ext);
  }
  if (mappedNums.size === 0) return [];

  const { rows: cdrRows } = await fetchAllCdr(opts.from, opts.to);

  const byDay = new Map<string, DailyPoint>();
  for (const row of cdrRows) {
    const atts = attribute(row, mappedNums);
    if (atts.length === 0) continue;
    const day = dayKey(String(row.time_start ?? ""));
    if (!day) continue;
    let p = byDay.get(day);
    if (!p) { p = { date: day, total: 0, answered: 0, missed: 0, inbound: 0, outbound: 0 }; byDay.set(day, p); }
    for (const a of atts) {
      if (opts.communicationType !== "All" && a.direction !== opts.communicationType) continue;
      const answered = isAnswered(row);
      p.total += 1;
      if (answered) p.answered += 1; else p.missed += 1;
      if (a.direction === "Inbound") p.inbound += 1; else p.outbound += 1;
    }
  }

  return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// Backwards-compat exports (older callers).
export const lastReportProbes: never[] = [];
export type ReportProbe = never;
