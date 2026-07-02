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
  refreshToken?: string;
  refreshExpiresAt?: number; // epoch ms
}

// Module-level cache; shared across requests in the same worker isolate.
let cachedToken: TokenState | null = null;
let cachedCredFingerprint: string | null = null;
let inflightAuth: Promise<YeastarDiagnostic> | null = null;

function credFingerprint(): string {
  // Short, non-reversible fingerprint of the current credentials so that
  // rotating YEASTAR_CLIENT_SECRET automatically invalidates any cached token
  // minted from the previous secret.
  const raw = `${process.env.YEASTAR_CLIENT_ID ?? ""}::${process.env.YEASTAR_CLIENT_SECRET ?? ""}`;
  let h = 0;
  for (let i = 0; i < raw.length; i++) h = ((h << 5) - h + raw.charCodeAt(i)) | 0;
  return String(h);
}

function ensureCredsFresh(): void {
  const fp = credFingerprint();
  if (cachedCredFingerprint !== fp) {
    if (cachedToken) console.log("[Yeastar] credentials changed — clearing cached token");
    cachedToken = null;
    cachedCredFingerprint = fp;
  }
}


function tokenStatus(): string {
  if (!cachedToken) return "none";
  const remainingMs = cachedToken.expiresAt - Date.now();
  const valid = remainingMs > 30_000;
  return `${valid ? "valid" : "expired"} (remaining=${Math.max(0, Math.floor(remainingMs / 1000))}s, refresh=${cachedToken.refreshToken ? "yes" : "no"})`;
}

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
    // Never retry auth failures, invalid credentials, IP allowlist rejections,
    // or MAX LIMITATION EXCEEDED — retrying just burns more sessions.
    return ["timeout", "network", "dns", "http_error"].includes(diag.category);
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/MAX_LIMITATION|max limitation|60002/i.test(msg)) return false;
  return (
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

// Per Yeastar P-Series OpenAPI docs, the User-Agent header is REQUIRED.
// The docs use `User-Agent: OpenAPI` as the example value.
const USER_AGENT = "OpenAPI";
const PROBE_ENDPOINT = "/openapi/v1.0/extension/list";


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
    | "max_limitation"
    | "http_error"
    | "probe_failed"
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
  probe?: {
    endpoint: string;
    httpStatus?: number;
    errcode?: number;
    errmsg?: string;
    ok: boolean;
    body?: string;
  };
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

/**
 * Run a full probe using the current cached token. Does NOT request a new
 * token. Returns an "ok" diagnostic on success, or a `probe_failed` diagnostic
 * otherwise. The caller decides whether to re-auth.
 */
async function probeWithCachedToken(env: { base: string }, endpoint: string): Promise<YeastarDiagnostic> {
  const token = cachedToken!.token;
  const probeUrl = `${env.base}${PROBE_ENDPOINT}?access_token=${encodeURIComponent(token)}&page=1&page_size=1&sort_by=id&order_by=asc`;
  let probeStatus: number | undefined;
  let probeBody = "";
  let probeJson: any = null;
  try {
    const p = await timedFetch(probeUrl, {
      method: "GET",
      headers: { "Accept": "application/json", "User-Agent": USER_AGENT },
    });
    probeStatus = p.status;
    probeBody = await p.text().catch(() => "");
    try { probeJson = probeBody ? JSON.parse(probeBody) : null; } catch { /* non-JSON */ }
  } catch (err) {
    const { category, message } = classifyNetworkError(err);
    return {
      ok: false, category, baseUrl: env.base, endpoint, userAgent: USER_AGENT,
      message: `Probe request to ${PROBE_ENDPOINT} failed: ${message}`,
      probe: { endpoint: PROBE_ENDPOINT, ok: false, body: message },
    };
  }
  const probeOk = probeStatus === 200 && probeJson?.errcode === 0;
  if (!probeOk) {
    return {
      ok: false, category: "probe_failed", baseUrl: env.base, endpoint, userAgent: USER_AGENT,
      httpStatus: probeStatus,
      message: `Probe endpoint ${PROBE_ENDPOINT} returned HTTP ${probeStatus}${probeJson?.errcode != null ? ` (errcode ${probeJson.errcode}: ${probeJson.errmsg ?? ""})` : ""}.`,
      hint: "Verify the API app on the PBX has the required permissions (Extension, CDR).",
      probe: { endpoint: PROBE_ENDPOINT, httpStatus: probeStatus, errcode: probeJson?.errcode, errmsg: probeJson?.errmsg, ok: false, body: probeBody.slice(0, 500) },
    };
  }
  const remainingSec = Math.max(0, Math.floor((cachedToken!.expiresAt - Date.now()) / 1000));
  return {
    ok: true, category: "ok", baseUrl: env.base, endpoint, userAgent: USER_AGENT,
    httpStatus: 200, errcode: 0,
    message: `Reused cached access token (valid for ~${remainingSec}s). Probe ${PROBE_ENDPOINT} returned HTTP 200.`,
    probe: { endpoint: PROBE_ENDPOINT, httpStatus: 200, errcode: 0, ok: true },
  };
}

function mapAuthErrcode(env: { base: string }, endpoint: string, httpStatus: number, bodyText: string, json: any): YeastarDiagnostic {
  const errcode = json?.errcode;
  const errmsg = json?.errmsg;
  const base = { ok: false as const, baseUrl: env.base, endpoint, userAgent: USER_AGENT, httpStatus, responseBody: bodyText, errcode, errmsg };
  switch (errcode) {
    case 70087:
      return { ...base, category: "ip_forbidden",
        message: `IP forbidden (errcode 70087): ${errmsg ?? "PBX rejected the server IP."}`,
        hint: "Allowlist the Lovable server IP in Yeastar → Settings → PBX → General → API (or set it to Any)." };
    case 60002:
      return { ...base, category: "max_limitation",
        message: `MAX LIMITATION EXCEEDED (errcode 60002): the PBX has hit the concurrent session cap for this API app.`,
        hint: "Wait ~30 minutes for existing sessions to expire, or open Yeastar → Integrations → API and re-issue the Client Secret to invalidate old sessions. Once resolved, cached tokens will be reused instead of creating new sessions." };
    case 40002:
      return { ...base, category: "invalid_client_secret",
        message: `Invalid parameters (errcode 40002): ${errmsg ?? ""}. Verify the Client Secret is copied exactly from the PBX API app.` };
    case 40004:
    case 40005:
    case 40011:
      return { ...base, category: "invalid_client_id",
        message: `Invalid Client ID (errcode ${errcode}): ${errmsg ?? ""}.` };
    default:
      return { ...base, category: "authentication",
        message: `Authentication failed${errcode != null ? ` (errcode ${errcode})` : ""}: ${errmsg ?? "no access_token returned"}.` };
  }
}

/**
 * POST /openapi/v1.0/refresh_token — exchange a refresh token for a new
 * access token WITHOUT consuming a new API-app session slot.
 */
async function refreshAccessToken(env: { base: string }): Promise<YeastarDiagnostic | null> {
  if (!cachedToken?.refreshToken) return null;
  if (cachedToken.refreshExpiresAt && cachedToken.refreshExpiresAt < Date.now()) return null;
  const endpoint = `${env.base}/openapi/v1.0/refresh_token`;
  console.log(`[yeastar auth] refreshing access token via ${endpoint}`);
  let res: Response;
  try {
    res = await timedFetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify({ refresh_token: cachedToken.refreshToken }),
    });
  } catch (err) {
    const { category, message } = classifyNetworkError(err);
    console.warn("[yeastar auth] refresh transport failure:", category, message);
    return null;
  }
  const bodyText = await res.text().catch(() => "");
  let json: any = null;
  try { json = bodyText ? JSON.parse(bodyText) : null; } catch { /* non-JSON */ }
  if (!res.ok || json?.errcode !== 0 || !json?.access_token) {
    console.warn(`[yeastar auth] refresh failed HTTP ${res.status} errcode=${json?.errcode} errmsg=${json?.errmsg}`);
    return null;
  }
  const ttlSec = Number(json.access_token_expire_time ?? json.expire_time ?? 1800);
  const refreshTtlSec = Number(json.refresh_token_expire_time ?? 0);
  cachedToken = {
    token: json.access_token,
    expiresAt: Date.now() + ttlSec * 1000,
    refreshToken: json.refresh_token ?? cachedToken.refreshToken,
    refreshExpiresAt: refreshTtlSec > 0 ? Date.now() + refreshTtlSec * 1000 : cachedToken.refreshExpiresAt,
  };
  console.log(`[yeastar auth] refresh succeeded; new token TTL ${ttlSec}s`);
  return {
    ok: true, category: "ok", baseUrl: env.base, endpoint, userAgent: USER_AGENT,
    httpStatus: 200, errcode: 0,
    message: `Refreshed access token (valid for ${ttlSec}s) without opening a new session.`,
  };
}

/**
 * Request a brand-new access token. Deduplicated: concurrent callers share
 * a single in-flight request so a dashboard load with N parallel widgets
 * cannot burn N sessions.
 */
async function requestNewToken(env: { base: string; id: string; secret: string }): Promise<YeastarDiagnostic> {
  if (inflightAuth) {
    console.log("[yeastar auth] joining in-flight get_token request");
    return inflightAuth;
  }
  const endpoint = `${env.base}/openapi/v1.0/get_token`;
  inflightAuth = (async (): Promise<YeastarDiagnostic> => {
    console.log(`[yeastar auth] POST ${endpoint} (cache=${tokenStatus()})`);
    let res: Response;
    try {
      res = await timedFetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json", "User-Agent": USER_AGENT },
        body: JSON.stringify({ username: env.id, password: env.secret }),
      });
    } catch (err) {
      const { category, message } = classifyNetworkError(err);
      console.error("[yeastar auth] transport failure:", category, message);
      return { ok: false, category, baseUrl: env.base, endpoint, userAgent: USER_AGENT, message };
    }
    const bodyText = await res.text().catch(() => "");
    const httpStatus = res.status;
    console.log(`[yeastar auth] HTTP ${httpStatus} body=${bodyText.slice(0, 300)}`);
    if (httpStatus === 404) {
      return { ok: false, category: "invalid_endpoint", baseUrl: env.base, endpoint, userAgent: USER_AGENT,
        httpStatus, responseBody: bodyText,
        message: "Endpoint not found (HTTP 404). Verify the Base URL." };
    }
    let json: any = null;
    try { json = bodyText ? JSON.parse(bodyText) : null; } catch { /* non-JSON */ }
    if (!res.ok) {
      return { ok: false, category: "http_error", baseUrl: env.base, endpoint, userAgent: USER_AGENT,
        httpStatus, responseBody: bodyText, message: `PBX returned HTTP ${httpStatus}.` };
    }
    if (json && json.errcode === 0 && json.access_token) {
      const ttlSec = Number(json.access_token_expire_time ?? json.expire_time ?? 1800);
      const refreshTtlSec = Number(json.refresh_token_expire_time ?? 0);
      cachedToken = {
        token: json.access_token,
        expiresAt: Date.now() + ttlSec * 1000,
        refreshToken: json.refresh_token,
        refreshExpiresAt: refreshTtlSec > 0 ? Date.now() + refreshTtlSec * 1000 : undefined,
      };
      console.log(`[yeastar auth] new session acquired; TTL access=${ttlSec}s refresh=${refreshTtlSec}s`);
      return {
        ok: true, category: "ok", baseUrl: env.base, endpoint, userAgent: USER_AGENT,
        httpStatus, errcode: 0,
        message: `Authentication successful. Token valid for ${ttlSec}s.`,
      };
    }
    return mapAuthErrcode(env, endpoint, httpStatus, bodyText, json);
  })();
  try {
    return await inflightAuth;
  } finally {
    inflightAuth = null;
  }
}

/**
 * Diagnostic entry point used by the UI and the CDR fetcher.
 *
 * Order of operations:
 *   1. If a cached access token is still valid, probe with it. On success we
 *      never touch /get_token — this prevents burning API-app sessions.
 *   2. If cache is expired but we still have a valid refresh token, refresh
 *      (no new session slot) and probe.
 *   3. Only as a last resort do we call POST /get_token.
 */
export async function diagnoseYeastar(): Promise<YeastarDiagnostic> {
  const env = requireEnv();
  if (!env) {
    return {
      ok: false, category: "not_configured", baseUrl: null, endpoint: null, userAgent: USER_AGENT,
      message: "Yeastar is not configured. Missing YEASTAR_BASE_URL, YEASTAR_CLIENT_ID, or YEASTAR_CLIENT_SECRET.",
    };
  }
  ensureCredsFresh();
  const authEndpoint = `${env.base}/openapi/v1.0/get_token`;
  console.log(`[yeastar diag] cache=${tokenStatus()}`);

  // 1. Reuse cached token.
  if (cachedToken && cachedToken.expiresAt - 30_000 > Date.now()) {
    console.log("[yeastar diag] reusing cached access token (no /get_token call)");
    const probed = await probeWithCachedToken(env, authEndpoint);
    if (probed.ok) return probed;
    // Cached token was rejected by the PBX (revoked, restarted, etc.).
    console.warn("[yeastar diag] cached token rejected by probe; clearing cache");
    cachedToken = null;
  }

  // 2. Try refresh_token if we have one.
  if (cachedToken?.refreshToken) {
    const refreshed = await refreshAccessToken(env);
    if (refreshed?.ok) {
      const probed = await probeWithCachedToken(env, authEndpoint);
      if (probed.ok) return probed;
    }
    cachedToken = null;
  }

  // 3. Request a fresh token (single-flight).
  const authDiag = await requestNewToken(env);
  if (!authDiag.ok) return authDiag;
  const probed = await probeWithCachedToken(env, authEndpoint);
  if (!probed.ok) cachedToken = null;
  return probed;
}

async function getAccessToken(): Promise<string> {
  const env = requireEnv();
  if (!env) throw new Error("Yeastar not configured");
  ensureCredsFresh();
  if (cachedToken && cachedToken.expiresAt - 30_000 > Date.now()) {
    console.log(`[yeastar token] cache hit (${tokenStatus()})`);
    return cachedToken.token;
  }
  console.log(`[yeastar token] cache miss (${tokenStatus()}) — authenticating`);
  const diag = await diagnoseYeastar();
  if (!diag.ok || !cachedToken) {
    const err: any = new Error(`YEASTAR_DIAG:${JSON.stringify(diag)}`);
    err.diagnostic = diag;
    throw err;
  }
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

export interface CdrDiagnostic {
  endpoint: string;
  requestUrl: string; // access_token masked
  queryParams: Record<string, string>;
  timeRange: { start: string; end: string };
  pbxTimezone?: string;
  httpStatus?: number;
  errcode?: number;
  errmsg?: string;
  totalNumber?: number;
  recordsReturned: number;
  rawResponsePreview: string;
  extensionsSample?: Array<{ number: string; name?: string }>;
}

async function fetchPbxTimezone(base: string, token: string): Promise<string | undefined> {
  try {
    const url = `${base}/openapi/v1.0/pbx_info?access_token=${encodeURIComponent(token)}`;
    const res = await timedFetch(url, { headers: { "Accept": "application/json", "User-Agent": USER_AGENT } });
    const j: any = await res.json().catch(() => null);
    return j?.pbx_info?.time_zone ?? j?.time_zone ?? j?.data?.time_zone;
  } catch { return undefined; }
}

export async function fetchAllExtensions(): Promise<Array<{ number: string; name?: string; status?: string }>> {
  const env = requireEnv();
  if (!env) return [];
  const token = await getAccessToken();
  const out: Array<{ number: string; name?: string; status?: string }> = [];
  const pageSize = 100;
  for (let page = 1; page <= 20; page++) {
    const url = `${env.base}/openapi/v1.0/extension/list?access_token=${encodeURIComponent(token)}&page=${page}&page_size=${pageSize}&sort_by=number&order_by=asc`;
    const res = await timedFetch(url, { headers: { "Accept": "application/json", "User-Agent": USER_AGENT } });
    const j: any = await res.json().catch(() => null);
    const list: any[] = j?.extension_list ?? j?.data?.extension_list ?? [];
    for (const e of list) {
      out.push({ number: normalizeExt(e.number ?? e.extension), name: e.name ?? e.caller_id_name, status: e.status });
    }
    if (list.length < pageSize) break;
  }
  return out.filter((e) => e.number);
}

async function fetchExtensionsSample(base: string, token: string): Promise<Array<{ number: string; name?: string }>> {
  try {
    const url = `${base}/openapi/v1.0/extension/list?access_token=${encodeURIComponent(token)}&page=1&page_size=100&sort_by=number&order_by=asc`;
    const res = await timedFetch(url, { headers: { "Accept": "application/json", "User-Agent": USER_AGENT } });
    const j: any = await res.json().catch(() => null);
    const list: any[] = j?.extension_list ?? j?.data?.extension_list ?? [];
    return list.map((e) => ({ number: normalizeExt(e.number ?? e.extension), name: e.name ?? e.caller_id_name }));
  } catch { return []; }
}

// -------- Extension Groups (operational teams) --------
//
// Analytics is scoped to two Extension Groups configured on the PBX.
// Any extension NOT in one of these groups (Default_All_Extensions,
// personal extensions, DIDs, external numbers) is excluded.

export const EXTENSION_GROUP_NAMES = {
  customer_care: "Customer_Care_Emp.",
  telesales: "Telesales_Emp.",
} as const;

export type TeamKey = "customer_care" | "telesales";

/**
 * Normalize an extension identifier for comparison.
 * - to string · strip zero-width/BOM · trim · strip surrounding quotes · lowercase
 */
export function normalizeExt(v: unknown): string {
  return String(v ?? "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .toLowerCase();
}

export interface GroupExtension { number: string; name?: string; status?: string }
export interface TeamExtensionResult {
  groups: Record<TeamKey, { name: string; found: boolean; extensions: GroupExtension[] }>;
  missingGroups: string[];
  all: Array<GroupExtension & { team: TeamKey }>;
  availableGroups: Array<{ id?: string; name: string; memberCount: number }>;
}

async function fetchGroupMembers(base: string, token: string, group: any): Promise<GroupExtension[]> {
  let members: any[] =
    group?.member_list ?? group?.members ?? group?.extension_list ??
    group?.member_extension_list ?? group?.extension_members ?? [];
  if ((members?.length ?? 0) === 0 && group?.id != null) {
    try {
      const detUrl = `${base}/openapi/v1.0/extension_group/get?access_token=${encodeURIComponent(token)}&id=${encodeURIComponent(group.id)}`;
      const detRes = await timedFetch(detUrl, { headers: { Accept: "application/json", "User-Agent": USER_AGENT } });
      const detJson: any = await detRes.json().catch(() => null);
      const g2 = detJson?.extension_group ?? detJson?.data ?? detJson;
      members =
        g2?.member_list ?? g2?.members ?? g2?.extension_list ??
        g2?.member_extension_list ?? g2?.extension_members ?? [];
    } catch (e) {
      console.warn(`[yeastar groups] extension_group/get failed for id=${group.id}:`, e instanceof Error ? e.message : e);
    }
  }
  const exts: GroupExtension[] = [];
  for (const m of members ?? []) {
    if (m == null) continue;
    if (typeof m === "string" || typeof m === "number") {
      const num = normalizeExt(m);
      if (num) exts.push({ number: num });
    } else {
      const num = normalizeExt(m.number ?? m.extension ?? m.ext ?? m.extension_number ?? m.id);
      if (num) exts.push({ number: num, name: m.name ?? m.caller_id_name, status: m.status });
    }
  }
  return exts;
}

export async function fetchTeamExtensions(): Promise<TeamExtensionResult> {
  const env = requireEnv();
  if (!env) throw new Error("Yeastar not configured");
  const token = await getAccessToken();

  const listUrl = `${env.base}/openapi/v1.0/extension_group/list?access_token=${encodeURIComponent(token)}&page=1&page_size=200`;
  const listRes = await timedFetch(listUrl, { headers: { Accept: "application/json", "User-Agent": USER_AGENT } });
  const listBody = await listRes.text().catch(() => "");
  let listJson: any = null;
  try { listJson = listBody ? JSON.parse(listBody) : null; } catch { /* non-JSON */ }
  const rawGroups: any[] =
    listJson?.extension_group_list ?? listJson?.data ?? listJson?.list ?? listJson?.groups ?? [];
  console.log(`[yeastar groups] extension_group/list HTTP ${listRes.status} count=${rawGroups.length} names=[${rawGroups.map((g: any) => g?.name).join(", ")}]`);

  const availableGroups = rawGroups.map((g: any) => ({
    id: g?.id, name: String(g?.name ?? ""),
    memberCount: (g?.member_list ?? g?.members ?? g?.extension_list ?? g?.member_extension_list ?? []).length,
  }));

  const findGroup = (name: string) =>
    rawGroups.find((g: any) => normalizeExt(g?.name) === normalizeExt(name));

  const result: TeamExtensionResult = {
    groups: {
      customer_care: { name: EXTENSION_GROUP_NAMES.customer_care, found: false, extensions: [] },
      telesales:     { name: EXTENSION_GROUP_NAMES.telesales,     found: false, extensions: [] },
    },
    missingGroups: [],
    all: [],
    availableGroups,
  };

  for (const key of ["customer_care", "telesales"] as const) {
    const wanted = EXTENSION_GROUP_NAMES[key];
    const grp = findGroup(wanted);
    if (!grp) {
      result.missingGroups.push(wanted);
      console.warn(`[yeastar groups] MISSING group "${wanted}"`);
      continue;
    }
    result.groups[key].found = true;
    const exts = await fetchGroupMembers(env.base, token, grp);
    result.groups[key].extensions = exts;
    for (const e of exts) result.all.push({ ...e, team: key });
    console.log(`[yeastar groups] "${wanted}" resolved ${exts.length} members: [${exts.map((e) => e.number).join(", ")}]`);
  }
  return result;
}

/**
 * Fetch CDR records for a date range. Yeastar limits per-page results,
 * so we paginate. Dates in `YYYY-MM-DD` format.
 */
export async function fetchCdr(
  fromDate: string,
  toDate: string,
): Promise<{ records: YeastarCdrRecord[]; diagnostic: CdrDiagnostic }> {
  const env = requireEnv();
  const endpoint = `${env!.base}/openapi/v1.0/cdr/list`;
  const start = fmtDate(fromDate);
  const end = fmtDateEnd(toDate);
  const diagnostic: CdrDiagnostic = {
    endpoint,
    requestUrl: "",
    queryParams: { start_time: start, end_time: end, page: "1", page_size: "500" },
    timeRange: { start, end },
    recordsReturned: 0,
    rawResponsePreview: "",
  };
  if (!env) return { records: [], diagnostic };
  const token = await getAccessToken();
  diagnostic.pbxTimezone = await fetchPbxTimezone(env.base, token);
  const results: YeastarCdrRecord[] = [];
  const pageSize = 500;
  let page = 1;
  while (page <= 20) {
    const currentPage = page;
    const rows = await withRetry(`cdr page ${currentPage}`, async () => {
      // Build query string manually so spaces are encoded as %20 (not '+').
      // Some Yeastar firmware rejects '+' inside start_time / end_time and
      // silently returns the full unfiltered CDR set.
      const qs =
        `access_token=${encodeURIComponent(token)}` +
        `&start_time=${encodeURIComponent(start)}` +
        `&end_time=${encodeURIComponent(end)}` +
        `&page=${currentPage}` +
        `&page_size=${pageSize}` +
        `&sort_by=time` +
        `&order_by=desc`;
      const fullUrl = `${endpoint}?${qs}`;
      const masked = fullUrl.replace(encodeURIComponent(token), "***MASKED***");
      if (currentPage === 1) diagnostic.requestUrl = masked;
      console.log(`[yeastar cdr] GET ${masked}`);
      const res = await timedFetch(fullUrl, {
        headers: { "Accept": "application/json", "User-Agent": USER_AGENT },
      });
      const bodyText = await res.text().catch(() => "");
      if (currentPage === 1) {
        diagnostic.httpStatus = res.status;
        diagnostic.rawResponsePreview = bodyText.slice(0, 1500);
      }
      console.log(`[yeastar cdr] page ${currentPage} HTTP ${res.status} bytes=${bodyText.length}`);
      if (!res.ok) throw new Error(`Yeastar CDR HTTP ${res.status}: ${bodyText.slice(0, 200)}`);
      let json: any = null;
      try { json = JSON.parse(bodyText); } catch { throw new Error(`Yeastar CDR non-JSON response: ${bodyText.slice(0, 200)}`); }
      if (currentPage === 1) {
        diagnostic.errcode = json?.errcode;
        diagnostic.errmsg = json?.errmsg;
        diagnostic.totalNumber = json?.total_number;
      }
      if (json.errcode !== 0) {
        if (json.errcode === 70087) throw new Error("IP_FORBIDDEN: PBX rejected the server IP.");
        throw new Error(`Yeastar CDR error ${json.errcode}: ${json.errmsg ?? "unknown"}`);
      }
      // Yeastar firmware inconsistency: some builds return `cdr_list`, others
      // return `data`. Accept both, plus a couple of legacy fallbacks.
      const rawList =
        json.cdr_list ?? json.data ?? json.cdr ?? json.list ?? json.result ?? [];
      const list: any[] = Array.isArray(rawList) ? rawList : [];
      if (currentPage === 1) {
        console.log(
          `[yeastar cdr] parse: Array.isArray(data)=${Array.isArray(json.data)} ` +
          `data.length=${Array.isArray(json.data) ? json.data.length : "n/a"} ` +
          `typeof data=${typeof json.data} ` +
          `cdr_list.length=${Array.isArray(json.cdr_list) ? json.cdr_list.length : "n/a"} ` +
          `chosen_field=${json.cdr_list ? "cdr_list" : json.data ? "data" : "other"} ` +
          `records_in_page=${list.length} total_number=${json.total_number}`,
        );
        if (list.length > 0) {
          console.log(`[yeastar cdr] first record: ${JSON.stringify(list[0]).slice(0, 500)}`);
        }
      }
      // Normalize field names across firmware variants so the aggregator
      // works regardless of the wire format.
      return list.map((r: any) => ({
        call_id: String(r.call_id ?? r.uid ?? r.id ?? ""),
        time_start: r.time_start ?? r.time ?? r.start_time ?? "",
        call_from: r.call_from ?? r.src_number ?? r.from ?? "",
        call_to: r.call_to ?? r.dst_number ?? r.to ?? "",
        src_name: r.src_name,
        dst_name: r.dst_name,
        src_number: r.src_number ?? r.call_from,
        dst_number: r.dst_number ?? r.call_to,
        extension: r.extension ?? r.extension_number ?? r.src_extension ?? r.dst_extension,
        extension_number: r.extension_number ?? r.extension,
        call_type: r.call_type ?? r.type ?? r.communication_type,
        status: r.status ?? r.call_status ?? r.disposition,
        duration: Number(r.duration ?? 0),
        talk_duration: Number(r.talk_duration ?? r.billsec ?? 0),
      })) as YeastarCdrRecord[];
    });
    results.push(...rows);
    if (rows.length < pageSize) break;
    page += 1;
  }
  diagnostic.recordsReturned = results.length;
  if (results.length === 0) {
    diagnostic.extensionsSample = (await fetchExtensionsSample(env.base, token)).slice(0, 25);
  }
  console.log(`[yeastar cdr] window=${start}..${end} tz=${diagnostic.pbxTimezone ?? "?"} records=${results.length} total_number=${diagnostic.totalNumber}`);
  return { records: results, diagnostic };
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
