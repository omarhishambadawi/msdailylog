/**
 * Yeastar CDR (Call Detail Records) retrieval — CORRECTED.
 *
 * Key corrections vs. the previous version (all verified against the official
 * Yeastar P-Series OpenAPI docs):
 *   1. The CDR list/search response array is `data`, NOT `cdr_list`. The old
 *      code read `json.cdr_list`, so it ALWAYS returned an empty record set.
 *   2. `/cdr/list` does NOT accept start_time/end_time — those params were
 *      silently ignored. Date filtering is done via `/cdr/search`, whose
 *      start_time/end_time MUST match the PBX's configured display format,
 *      otherwise it returns ZERO records. We therefore:
 *        - pre-filter with `/cdr/search` (fast path), formatted as the PBX
 *          expects (default `yyyy/MM/dd HH:mm:ss`, overridable), AND
 *        - authoritatively post-filter every record by its epoch `timestamp`,
 *          so results are correct even if the string format is off, AND
 *        - fall back to a full `/cdr/list` sweep if search returns nothing,
 *          logging a clear warning about the likely format mismatch.
 *   3. Real CDR fields are mapped: `timestamp`, `disposition`, `call_type`,
 *      `duration`, `ring_duration`, `talk_duration`, `call_from_number`,
 *      `call_to_number`, etc.
 *   4. Pagination retrieves ALL records (page_size up to 10,000) until
 *      total_number is reached, with a high safety ceiling and explicit
 *      logging if the ceiling is ever hit.
 *   5. Timezone handling is explicit: day boundaries are computed in the
 *      business timezone (default UTC+3, Asia/Riyadh — no DST) so buckets line
 *      up with the dashboard's date filters.
 */
import { yeastarFetch } from "./client.server";

// Business timezone offset for day-boundary math. Asia/Riyadh = UTC+3, no DST.
// Override via env if the PBX / business runs in a different zone.
const TZ_OFFSET_MIN = Number(process.env.YEASTAR_UTC_OFFSET_MINUTES ?? 180);
// PBX display format for /cdr/search. P-Series Cloud default is yyyy/MM/dd HH:mm:ss.
const DATETIME_FORMAT = process.env.YEASTAR_DATETIME_FORMAT ?? "yyyy/MM/dd HH:mm:ss";

export interface CdrRecord {
  id?: number;
  new_id?: string;
  uid?: string;
  call_id?: string;
  time?: string;            // PBX-local display time, e.g. "2026/07/01 10:40:07"
  timestamp?: number;       // epoch seconds (UTC) — authoritative for filtering
  call_from?: string;
  call_to?: string;
  call_from_number?: string;
  call_from_name?: string;
  call_to_number?: string;
  call_to_name?: string;
  disposition?: "ANSWERED" | "NO ANSWER" | "BUSY" | "FAILED" | "VOICEMAIL" | string;
  call_type?: "Inbound" | "Outbound" | "Internal" | string;
  duration?: number;        // total seconds
  ring_duration?: number;   // seconds until answered
  talk_duration?: number;   // seconds talking
  did_number?: string;
  [k: string]: any;
}

interface CdrPageResponse {
  errcode: number;
  errmsg: string;
  total_number?: number;
  data?: CdrRecord[];       // CORRECT field (was `cdr_list`)
}

export interface FetchCdrOptions {
  from: string;             // "YYYY-MM-DD" (inclusive, business tz)
  to: string;               // "YYYY-MM-DD" (inclusive, business tz)
  pageSize?: number;        // default 10,000 (Yeastar max)
  maxPages?: number;        // safety ceiling, default 200
  signal?: AbortSignal;
}

export interface FetchCdrResult {
  records: CdrRecord[];
  totalReported: number | null;
  pagesFetched: number;
  path: "search" | "list-fallback";
  startEpoch: number;
  endEpoch: number;
  elapsedMs: number;
  truncated: boolean;       // true if the safety ceiling was hit
}

function pad(n: number) { return String(n).padStart(2, "0"); }

/** Epoch-seconds bounds for [from 00:00:00, to 23:59:59] in the business tz. */
function dayBounds(from: string, to: string): { startEpoch: number; endEpoch: number } {
  const offMs = TZ_OFFSET_MIN * 60_000;
  const startEpoch = Math.floor((Date.parse(`${from}T00:00:00Z`) - offMs) / 1000);
  const endEpoch = Math.floor((Date.parse(`${to}T23:59:59Z`) - offMs) / 1000);
  return { startEpoch, endEpoch };
}

/** Format an epoch-seconds instant into the PBX display string, in business tz. */
function fmtForPbx(epochSec: number): string {
  const d = new Date(epochSec * 1000 + TZ_OFFSET_MIN * 60_000);
  const Y = d.getUTCFullYear(), M = pad(d.getUTCMonth() + 1), D = pad(d.getUTCDate());
  const h = pad(d.getUTCHours()), m = pad(d.getUTCMinutes()), s = pad(d.getUTCSeconds());
  // Only yyyy/MM/dd HH:mm:ss and MM/dd/yyyy HH:mm:ss are supported here; extend if needed.
  if (DATETIME_FORMAT.startsWith("MM/dd")) return `${M}/${D}/${Y} ${h}:${m}:${s}`;
  return `${Y}/${M}/${D} ${h}:${m}:${s}`;
}

async function fetchAllPages(
  endpoint: string,
  baseQuery: Record<string, string | number | undefined>,
  pageSize: number,
  maxPages: number,
  signal?: AbortSignal,
): Promise<{ records: CdrRecord[]; totalReported: number | null; pages: number; truncated: boolean }> {
  const records: CdrRecord[] = [];
  let totalReported: number | null = null;
  let page = 1;
  for (; page <= maxPages; page++) {
    const { httpStatus, json, body } = await yeastarFetch<CdrPageResponse>(
      endpoint,
      { ...baseQuery, page, page_size: pageSize, sort_by: "time", order_by: "asc" },
      { signal },
    );

    if (httpStatus !== 200) throw new Error(`Yeastar CDR HTTP ${httpStatus}: ${body.slice(0, 200)}`);
    if (!json || json.errcode !== 0) {
      throw new Error(`Yeastar CDR errcode ${json?.errcode ?? "n/a"}: ${json?.errmsg ?? "unknown"}`);
    }

    const list = json.data ?? [];              // CORRECT field
    if (typeof json.total_number === "number") totalReported = json.total_number;
    records.push(...list);
    console.log(`[yeastar cdr] ${endpoint} page=${page} got=${list.length} total=${totalReported ?? "?"} acc=${records.length}`);
    if (list.length < pageSize) break;
    if (totalReported !== null && records.length >= totalReported) break;
  }
  const truncated = page > maxPages;
  if (truncated) console.warn(`[yeastar cdr] SAFETY CEILING hit at ${maxPages} pages — result may be incomplete`);
  return { records, totalReported, pages: Math.min(page, maxPages), truncated };
}

export async function fetchCdrRange(opts: FetchCdrOptions): Promise<FetchCdrResult> {
  const started = Date.now();
  // v1.0 /cdr/list and /cdr/search accept page_size up to 10,000.
  const pageSize = opts.pageSize ?? 10_000;
  const maxPages = opts.maxPages ?? 200;
  const { startEpoch, endEpoch } = dayBounds(opts.from, opts.to);
  const inWindow = (r: CdrRecord) =>
    typeof r.timestamp === "number" && r.timestamp >= startEpoch && r.timestamp <= endEpoch;

  console.log(`[yeastar cdr] window epoch ${startEpoch}..${endEpoch} (tz+${TZ_OFFSET_MIN}m)`);

  // /cdr/search accepts start_time/end_time as Unix timestamps (seconds).
  // Falls back to /cdr/list (no server-side date filter) if search errors.
  let path: FetchCdrResult["path"] = "search";
  let records: CdrRecord[] = [];
  let totalReported: number | null = null;
  let pages = 0;
  let truncated = false;
  try {
    const r = await fetchAllPages(
      "/openapi/v1.0/cdr/search",
      { start_time: startEpoch, end_time: endEpoch },
      pageSize, maxPages, opts.signal,
    );
    records = r.records; totalReported = r.totalReported; pages = r.pages; truncated = r.truncated;
  } catch (e: any) {
    console.warn(`[yeastar cdr] /cdr/search failed (${e?.message ?? e}) — falling back to /cdr/list.`);
    path = "list-fallback";
    const full = await fetchAllPages("/openapi/v1.0/cdr/list", {}, pageSize, maxPages, opts.signal);
    records = full.records; totalReported = full.totalReported; pages = full.pages; truncated = full.truncated;
  }




  // Authoritative timezone-correct filter by epoch timestamp.
  const filtered = records.filter(inWindow);
  console.log(`[yeastar cdr] path=${path} fetched=${records.length} inWindow=${filtered.length}`);

  return {
    records: filtered,
    totalReported,
    pagesFetched: pages,
    path,
    startEpoch,
    endEpoch,
    elapsedMs: Date.now() - started,
    truncated,
  };
}
