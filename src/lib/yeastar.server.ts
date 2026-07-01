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
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;

async function timedFetch(url: string, init?: RequestInit): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isRetriable(err: unknown): boolean {
  const diag = (err as any)?.diagnostic as YeastarDiagnostic | undefined;
  if (diag) {
    return ["timeout", "network", "dns", "ip_forbidden", "http_error"].includes(diag.category);
  }
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /IP_FORBIDDEN/i.test(msg) ||
    /abort/i.test(msg) ||
    /timeout/i.test(msg) ||
    /network/i.test(msg) ||
    /fetch failed/i.test(msg) ||
    /HTTP 5\d\d/.test(msg) ||
    /HTTP 429/.test(msg)
  );
}

async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === MAX_RETRIES - 1 || !isRetriable(err)) break;
      const delay = BASE_BACKOFF_MS * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
      console.warn(`[yeastar] ${label} attempt ${attempt + 1} failed, retrying in ${delay}ms:`, err instanceof Error ? err.message : err);
      await sleep(delay);
    }
  }
  throw lastErr;
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

const USER_AGENT = "Lovable-MSDailyLog/1.0 (+yeastar-integration)";

export interface YeastarDiagnostic {
  ok: boolean;
  category:
    | "ok"
    | "not_configured"
    | "dns"
    | "ssl_tls"
    | "timeout"
    | "network"
    | "invalid_endpoint"
    | "missing_headers"
    | "authentication"
    | "invalid_client_id"
    | "invalid_client_secret"
    | "ip_forbidden"
    | "http_error"
    | "unknown";
  baseUrl: string | null;
  endpoint: string | null;
  userAgent: string;
  httpStatus?: number;
  responseBody?: string;
  errcode?: number;
  errmsg?: string;
  message: string;
  hint?: string;
}

function classifyNetworkError(err: unknown): { category: YeastarDiagnostic["category"]; message: string } {
  const msg = err instanceof Error ? err.message : String(err);
  const cause = (err as any)?.cause?.code || (err as any)?.code || "";
  const s = `${msg} ${cause}`.toLowerCase();
  if (/abort|timeout/i.test(s)) return { category: "timeout", message: `Request timed out after ${FETCH_TIMEOUT_MS}ms` };
  if (/enotfound|eai_again|dns/i.test(s)) return { category: "dns", message: `DNS lookup failed: ${msg}` };
  if (/cert|ssl|tls|self.signed|unable to verify/i.test(s)) return { category: "ssl_tls", message: `SSL/TLS error: ${msg}` };
  if (/econnrefused|econnreset|network|fetch failed/i.test(s)) return { category: "network", message: `Network error: ${msg}` };
  return { category: "unknown", message: msg };
}

export async function diagnoseYeastar(): Promise<YeastarDiagnostic> {
  const env = requireEnv();
  if (!env) {
    return {
      ok: false, category: "not_configured", baseUrl: null, endpoint: null, userAgent: USER_AGENT,
      message: "Yeastar is not configured. Missing YEASTAR_BASE_URL, YEASTAR_CLIENT_ID, or YEASTAR_CLIENT_SECRET.",
    };
  }
  const endpoint = `${env.base}/openapi/v1.0/get_token`;
  const { createHash } = await import("crypto");
  const hashed = /^[a-f0-9]{32}$/i.test(env.secret) ? env.secret.toLowerCase() : createHash("md5").update(env.secret).digest("hex");

  let res: Response;
  try {
    res = await timedFetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({ username: env.id, password: hashed }),
    });
  } catch (err) {
    const { category, message } = classifyNetworkError(err);
    console.error("[yeastar diagnostic] transport failure:", category, message);
    return { ok: false, category, baseUrl: env.base, endpoint, userAgent: USER_AGENT, message };
  }

  const bodyText = await res.text().catch(() => "");
  const httpStatus = res.status;
  console.log(`[yeastar diagnostic] HTTP ${httpStatus} from ${endpoint}`);
  console.log(`[yeastar diagnostic] body: ${bodyText.slice(0, 500)}`);

  if (httpStatus === 404) {
    return { ok: false, category: "invalid_endpoint", baseUrl: env.base, endpoint, userAgent: USER_AGENT,
      httpStatus, responseBody: bodyText, message: "Endpoint not found (HTTP 404). Verify the Base URL and API version path." };
  }
  if (httpStatus === 400 && /user.?agent|header/i.test(bodyText)) {
    return { ok: false, category: "missing_headers", baseUrl: env.base, endpoint, userAgent: USER_AGENT,
      httpStatus, responseBody: bodyText, message: "PBX rejected the request headers." };
  }

  let json: any = null;
  try { json = bodyText ? JSON.parse(bodyText) : null; } catch { /* non-JSON */ }

  if (!res.ok) {
    return { ok: false, category: "http_error", baseUrl: env.base, endpoint, userAgent: USER_AGENT,
      httpStatus, responseBody: bodyText, message: `PBX returned HTTP ${httpStatus}.` };
  }

  if (json && json.errcode === 0 && json.access_token) {
    const ttlSec = Number(json.expire_time ?? 1800);
    cachedToken = { token: json.access_token, expiresAt: Date.now() + ttlSec * 1000 };
    return { ok: true, category: "ok", baseUrl: env.base, endpoint, userAgent: USER_AGENT,
      httpStatus, errcode: 0, message: `Authentication successful. Token valid for ${ttlSec}s.` };
  }

  const errcode = json?.errcode;
  const errmsg = json?.errmsg;
  const base = { ok: false as const, baseUrl: env.base, endpoint, userAgent: USER_AGENT, httpStatus, responseBody: bodyText, errcode, errmsg };
  switch (errcode) {
    case 70087:
      return { ...base, category: "ip_forbidden",
        message: `IP forbidden (errcode 70087): ${errmsg ?? "PBX rejected the server IP."}`,
        hint: "Allowlist the Lovable server IP in Yeastar → Settings → PBX → General → API (or set it to Any)." };
    case 40002:
      return { ...base, category: "invalid_client_secret",
        message: `Invalid parameters (errcode 40002): ${errmsg ?? ""}. Client Secret is likely wrong or not MD5-hashed correctly.`,
        hint: "Verify YEASTAR_CLIENT_SECRET matches the PBX API app secret." };
    case 40004:
    case 40005:
    case 40011:
      return { ...base, category: "invalid_client_id",
        message: `Invalid Client ID (errcode ${errcode}): ${errmsg ?? ""}.`,
        hint: "Verify YEASTAR_CLIENT_ID matches the PBX API app ID." };
    case 40001:
    case 40003:
      return { ...base, category: "authentication",
        message: `Authentication failed (errcode ${errcode}): ${errmsg ?? ""}.` };
    default:
      return { ...base, category: "authentication",
        message: `Authentication failed${errcode != null ? ` (errcode ${errcode})` : ""}: ${errmsg ?? "no access_token returned"}.` };
  }
}

async function getAccessToken(): Promise<string> {
  const env = requireEnv();
  if (!env) throw new Error("Yeastar not configured");
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt - 30_000 > now) return cachedToken.token;

  const token = await withRetry("auth", async () => {
    const diag = await diagnoseYeastar();
    if (!diag.ok || !cachedToken) {
      const err: any = new Error(`YEASTAR_DIAG:${JSON.stringify(diag)}`);
      err.diagnostic = diag;
      throw err;
    }
    return cachedToken.token;
  });
  return token;
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
    const currentPage = page;
    const rows = await withRetry(`cdr page ${currentPage}`, async () => {
      const url = new URL(`${env.base}/openapi/v1.0/cdr/list`);
      url.searchParams.set("access_token", token);
      url.searchParams.set("start_time", fmtDate(fromDate));
      url.searchParams.set("end_time", fmtDateEnd(toDate));
      url.searchParams.set("page", String(currentPage));
      url.searchParams.set("page_size", String(pageSize));
      const res = await timedFetch(url.toString());
      if (!res.ok) throw new Error(`Yeastar CDR HTTP ${res.status}`);
      const json: any = await res.json();
      if (json.errcode !== 0) {
        if (json.errcode === 70087) throw new Error("IP_FORBIDDEN: PBX rejected the server IP.");
        throw new Error(`Yeastar CDR error ${json.errcode}: ${json.errmsg ?? "unknown"}`);
      }
      return (json.cdr_list ?? []) as YeastarCdrRecord[];
    });
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
