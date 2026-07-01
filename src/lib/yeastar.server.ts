/**
 * Yeastar P-Series PBX API integration (server-only).
 *
 * Auth: OAuth2-style client_credentials — POST {base}/openapi/v1.0/get_token
 *   body: { username: <client_id>, password: <client_secret> }
 *   response: { errcode, errmsg, access_token, refresh_token, expire_time }
 * CDR:  GET  {base}/openapi/v1.0/cdr/list?access_token=...&start_time=...&end_time=...
 *   response: { errcode, errmsg, total_number, cdr_list: [...] }
 *
 * A token is cached in-process until 30s before expiry to avoid re-authenticating
 * on every dashboard load. Credentials are read from environment variables only.
 */

interface TokenState {
  token: string;
  expiresAt: number; // epoch ms
}

let cachedToken: TokenState | null = null;

const FETCH_TIMEOUT_MS = 12_000;

async function timedFetch(url: string, init?: RequestInit): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

function requireEnv() {
  const base = process.env.YEASTAR_BASE_URL?.replace(/\/+$/, "");
  const id = process.env.YEASTAR_CLIENT_ID;
  const secret = process.env.YEASTAR_CLIENT_SECRET;
  if (!base || !id || !secret) return null;
  return { base, id, secret };
}

export function isYeastarConfigured(): boolean {
  return !!requireEnv();
}

async function getAccessToken(): Promise<string> {
  const env = requireEnv();
  if (!env) throw new Error("Yeastar not configured");
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt - 30_000 > now) return cachedToken.token;

  const res = await timedFetch(`${env.base}/openapi/v1.0/get_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: env.id, password: env.secret }),
  });
  if (!res.ok) throw new Error(`Yeastar auth ${res.status}`);
  const json: any = await res.json();
  if (json.errcode !== 0 || !json.access_token) {
    throw new Error(`Yeastar auth error: ${json.errmsg ?? "unknown"}`);
  }
  const ttlSec = Number(json.expire_time ?? 1800);
  cachedToken = { token: json.access_token, expiresAt: now + ttlSec * 1000 };
  return cachedToken.token;
}

export interface YeastarCdrRecord {
  call_id: string;
  time_start: string; // "YYYY-MM-DD HH:mm:ss"
  call_from: string;
  call_to: string;
  src_name?: string;
  dst_name?: string;
  src_number?: string;
  dst_number?: string;
  extension?: string;
  extension_number?: string;
  call_type?: string; // "Inbound" | "Outbound" | "Internal"
  status?: string; // "ANSWERED" | "NO ANSWER" | "BUSY" | "FAILED"
  duration?: number;
  talk_duration?: number;
}

const fmtDate = (d: string) => `${d} 00:00:00`;
const fmtDateEnd = (d: string) => `${d} 23:59:59`;

/**
 * Fetch CDR records for a date range. Yeastar limits per-page results,
 * so we paginate. Dates in `YYYY-MM-DD` format.
 */
export async function fetchCdr(fromDate: string, toDate: string): Promise<YeastarCdrRecord[]> {
  const env = requireEnv();
  if (!env) return [];
  const token = await getAccessToken();
  const results: YeastarCdrRecord[] = [];
  const pageSize = 500;
  let page = 1;
  // Hard safety cap: 20 pages = 10k records
  while (page <= 20) {
    const url = new URL(`${env.base}/openapi/v1.0/cdr/list`);
    url.searchParams.set("access_token", token);
    url.searchParams.set("start_time", fmtDate(fromDate));
    url.searchParams.set("end_time", fmtDateEnd(toDate));
    url.searchParams.set("page", String(page));
    url.searchParams.set("page_size", String(pageSize));
    const res = await timedFetch(url.toString());
    if (!res.ok) throw new Error(`Yeastar CDR ${res.status}`);
    const json: any = await res.json();
    if (json.errcode !== 0) throw new Error(`Yeastar CDR error: ${json.errmsg ?? "unknown"}`);
    const rows: YeastarCdrRecord[] = json.cdr_list ?? [];
    results.push(...rows);
    if (rows.length < pageSize) break;
    page += 1;
  }
  return results;
}

// -------- Aggregation helpers (pure, testable, no I/O) --------

export interface AgentCallStats {
  extension: string;
  agentName: string;
  total: number;
  answered: number;
  missed: number;
  inbound: number;
  outbound: number;
}

export interface CallStatsSummary {
  configured: boolean;
  total: number;
  answered: number;
  missed: number;
  inbound: number;
  outbound: number;
  byTeam: { customerCare: number; telesales: number };
  byAgent: AgentCallStats[];
}

const ANSWERED_STATUSES = new Set(["ANSWERED", "Answered", "answered"]);

export interface AgentDirectoryEntry {
  extension: string;
  fullName: string;
  team: "customer_care" | "telesales" | null;
}

export function aggregateCdr(
  records: YeastarCdrRecord[],
  agents: AgentDirectoryEntry[],
  filter?: { team?: "customer_care" | "telesales"; extension?: string },
): CallStatsSummary {
  const dir = new Map(agents.map((a) => [String(a.extension), a]));

  const byAgent = new Map<string, AgentCallStats>();
  let total = 0, answered = 0, missed = 0, inbound = 0, outbound = 0;
  let cc = 0, ts = 0;

  for (const r of records) {
    const ext = String(r.extension ?? r.extension_number ?? r.src_number ?? r.dst_number ?? "").trim();
    if (!ext) continue;
    const meta = dir.get(ext);
    if (filter?.team && meta?.team !== filter.team) continue;
    if (filter?.extension && ext !== filter.extension) continue;

    total += 1;
    const isAnswered = r.status ? ANSWERED_STATUSES.has(r.status) : (r.talk_duration ?? 0) > 0;
    if (isAnswered) answered += 1; else missed += 1;
    const isOutbound = (r.call_type ?? "").toLowerCase().includes("outbound");
    if (isOutbound) outbound += 1;
    else inbound += 1;

    if (meta?.team === "customer_care") cc += 1;
    else if (meta?.team === "telesales") ts += 1;

    const row = byAgent.get(ext) ?? {
      extension: ext,
      agentName: meta?.fullName ?? `Ext ${ext}`,
      total: 0, answered: 0, missed: 0, inbound: 0, outbound: 0,
    };
    row.total += 1;
    if (isAnswered) row.answered += 1; else row.missed += 1;
    if (isOutbound) row.outbound += 1; else row.inbound += 1;
    byAgent.set(ext, row);
  }

  return {
    configured: true,
    total, answered, missed, inbound, outbound,
    byTeam: { customerCare: cc, telesales: ts },
    byAgent: Array.from(byAgent.values()).sort((a, b) => b.total - a.total),
  };
}
