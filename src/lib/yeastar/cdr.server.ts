/**
 * Yeastar CDR (Call Detail Records) retrieval.
 *
 * Uses `yeastarFetch()` for auth. Paginates GET /openapi/v1.0/cdr/list with a
 * concurrency-limited queue to respect Cloudflare Worker execution limits.
 */
import { yeastarFetch } from "./client.server";

export interface CdrRecord {
  id?: string | number;
  call_id?: string;
  time_start?: string;
  time_end?: string;
  call_from?: string;
  call_to?: string;
  src_number?: string;
  dst_number?: string;
  status?: string;
  talk_duration?: number;
  call_duration?: number;
  call_type?: string;
  [k: string]: any;
}

export interface CdrPageResponse {
  errcode: number;
  errmsg: string;
  total_number?: number;
  cdr_list?: CdrRecord[];
}

export interface FetchCdrOptions {
  from: string; // "YYYY-MM-DD"
  to: string;   // "YYYY-MM-DD"
  pageSize?: number; // default 500 (Yeastar max)
  maxPages?: number; // hard cap per query, default 20
  signal?: AbortSignal;
}

export interface FetchCdrResult {
  records: CdrRecord[];
  totalReported: number | null;
  pagesFetched: number;
  elapsedMs: number;
  timings: Array<{ page: number; records: number; ms: number }>;
}

export async function fetchCdrRange(opts: FetchCdrOptions): Promise<FetchCdrResult> {
  const started = Date.now();
  const pageSize = opts.pageSize ?? 500;
  const maxPages = opts.maxPages ?? 20;
  const start = `${opts.from} 00:00:00`;
  const end = `${opts.to} 23:59:59`;

  const timings: FetchCdrResult["timings"] = [];
  const records: CdrRecord[] = [];
  let totalReported: number | null = null;
  let page = 1;

  console.log(`[yeastar cdr] fetch start_time="${start}" end_time="${end}" pageSize=${pageSize}`);

  for (; page <= maxPages; page++) {
    const t0 = Date.now();
    const { httpStatus, json, body } = await yeastarFetch<CdrPageResponse>(
      "/openapi/v1.0/cdr/list",
      { start_time: start, end_time: end, page, page_size: pageSize, sort_by: "time", order_by: "desc" },
      { signal: opts.signal },
    );
    if (httpStatus !== 200) {
      throw new Error(`Yeastar CDR HTTP ${httpStatus}: ${body.slice(0, 200)}`);
    }
    if (!json || json.errcode !== 0) {
      throw new Error(`Yeastar CDR errcode ${json?.errcode ?? "n/a"}: ${json?.errmsg ?? "unknown"}`);
    }
    const list = json.cdr_list ?? [];
    if (typeof json.total_number === "number") totalReported = json.total_number;
    const ms = Date.now() - t0;
    timings.push({ page, records: list.length, ms });
    console.log(`[yeastar cdr] page=${page} records=${list.length} total=${totalReported ?? "?"} ${ms}ms`);
    records.push(...list);

    if (list.length < pageSize) break;
    if (totalReported !== null && records.length >= totalReported) break;
  }

  return { records, totalReported, pagesFetched: page, elapsedMs: Date.now() - started, timings };
}
