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

import { supabaseAdmin } from "@/integrations/supabase/client.server";

interface TokenState {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number; // epoch ms
  refreshExpiresAt?: number; // epoch ms
}

type TokenSource =
  | "Cached Access Token"
  | "Persistent Cache"
  | "Refreshed Token"
  | "New Authentication";

interface TokenResult {
  accessToken: string;
  source: TokenSource;
  remainingMs: number;
  getTokenCalled: boolean;
}

// Refresh the access token when less than 5 minutes remain, rather than
// waiting until the final seconds. Gives every request plenty of headroom.
const REFRESH_SKEW_MS = 5 * 60_000;

// Minimum backoff after an errcode 60002 auth failure. Doubles on repeat
// failures up to `MAX_AUTH_BLOCK_MS`.
const MIN_AUTH_BLOCK_MS = 5 * 60_000;
const MAX_AUTH_BLOCK_MS = 30 * 60_000;

// How long a single Worker may hold the distributed auth lease. It only needs
// to cover one /get_token round-trip; expiry auto-releases it on crash.
const AUTH_LEASE_SEC = 15;

// Level-1 (in-isolate memory) cache. Level-2 is the yeastar_token_cache table.
let cachedToken: TokenState | null = null;
let cachedCredFingerprint: string | null = null;
let inflightAuth: Promise<TokenResult> | null = null;
let authBlockedUntil = 0;
let lastAuthFailure: YeastarDiagnostic | null = null;
let consecutiveAuthFailures = 0;

// Unique identifier per Worker isolate — lazy-initialized on first use.
// Cloudflare Workers disallow crypto.randomUUID() / Math.random() at module
// scope ("Disallowed operation called within global scope"), so we defer
// generation until the first request handler runs.
let WORKER_ID: string | null = null;
function getOrInitWorkerId(): string {
  if (WORKER_ID) return WORKER_ID;
  WORKER_ID = (typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `w-${Math.random().toString(36).slice(2)}-${Date.now()}`);
  return WORKER_ID;
}

// Per-call trace flags, reset at the entry of getAccessTokenInfo and read by
// the diagnostic route after the call completes.
interface AuthTrace { refreshTokenCalled: boolean; leaseAcquired: boolean; }
let lastAuthTrace: AuthTrace = { refreshTokenCalled: false, leaseAcquired: false };
export function getWorkerId(): string { return getOrInitWorkerId(); }
export function getLastAuthTrace(): AuthTrace { return { ...lastAuthTrace }; }
export function getCachedCredFingerprint(): string { return credFingerprint(); }
export function getAuthBlockedUntilIso(): string | null {
  return authBlockedUntil > Date.now() ? new Date(authBlockedUntil).toISOString() : null;
}
/**
 * TEST HELPER: shrink the in-memory access token's expiry so that the next
 * getAccessTokenInfo() call falls into the refresh path (< REFRESH_SKEW_MS
 * remaining) without invalidating the refresh token. Also updates the
 * persistent row so other isolates see the same shortened expiry.
 */
export async function forceExpireAccessToken(remainingSec = 60): Promise<{ ok: boolean; note: string }> {
  const newExpiresAt = Date.now() + remainingSec * 1000;
  if (cachedToken) {
    cachedToken = { ...cachedToken, expiresAt: newExpiresAt };
  } else {
    const row = await loadPersistentToken();
    if (row && hydrateFromPersistent(row, credFingerprint())) {
      cachedToken = { ...cachedToken!, expiresAt: newExpiresAt };
    } else {
      return { ok: false, note: "No cached or persistent token to expire." };
    }
  }
  try {
    await supabaseAdmin
      .from("yeastar_token_cache")
      .update({ expires_at: new Date(newExpiresAt).toISOString() })
      .eq("id", "singleton");
  } catch { /* best-effort */ }
  return { ok: true, note: `Access token expiry shortened to ${remainingSec}s from now.` };
}

export async function readPersistentTokenSnapshot() {
  const row = await loadPersistentToken();
  if (!row) return null;
  const expiresAtMs = Date.parse(row.expires_at);
  return {
    hasAccessToken: !!row.access_token,
    hasRefreshToken: !!row.refresh_token,
    expiresAt: row.expires_at,
    refreshExpiresAt: row.refresh_expires_at,
    credFingerprint: row.cred_fingerprint,
    authBlockedUntil: row.auth_blocked_until,
    ageSec: Math.max(0, Math.floor((Date.now() - (expiresAtMs - 30 * 60_000)) / 1000)),
    expiresInSec: Math.floor((expiresAtMs - Date.now()) / 1000),
  };
}

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
    authBlockedUntil = 0;
    lastAuthFailure = null;
    cachedCredFingerprint = fp;
  }
}


function tokenStatus(): string {
  if (!cachedToken) return "none";
  const remainingMs = cachedToken.expiresAt - Date.now();
  const valid = remainingMs > 30_000;
  const refreshRemainingMs = cachedToken.refreshExpiresAt ? cachedToken.refreshExpiresAt - Date.now() : 0;
  return `${valid ? "valid" : "expired"} (remaining=${Math.max(0, Math.floor(remainingMs / 1000))}s, refresh=${cachedToken.refreshToken ? `${Math.max(0, Math.floor(refreshRemainingMs / 1000))}s` : "none"})`;
}

function isAccessTokenValid(): boolean {
  return !!cachedToken?.accessToken && cachedToken.expiresAt - REFRESH_SKEW_MS > Date.now();
}

function isRefreshTokenValid(): boolean {
  return !!cachedToken?.refreshToken && (!cachedToken.refreshExpiresAt || cachedToken.refreshExpiresAt - REFRESH_SKEW_MS > Date.now());
}

function remainingAccessMs(): number {
  return Math.max(0, (cachedToken?.expiresAt ?? 0) - Date.now());
}

function logTokenSource(source: TokenSource, getTokenCalled: boolean): void {
  console.log(
    `[yeastar auth] token source=${source}; remaining=${Math.floor(remainingAccessMs() / 1000)}s; get_token_called=${getTokenCalled}; cache=${tokenStatus()}`,
  );
}

function parseExpiryMs(json: any, absoluteKeys: string[], ttlKeys: string[], fallbackTtlSec?: number): number | undefined {
  for (const key of absoluteKeys) {
    const raw = json?.[key];
    if (raw == null || raw === "") continue;
    if (typeof raw === "string" && /[-:T]/.test(raw)) {
      const parsed = Date.parse(raw);
      if (Number.isFinite(parsed)) return parsed;
    }
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) {
      if (n < 10_000_000) return Date.now() + n * 1000;
      return n > 10_000_000_000 ? n : n * 1000;
    }
  }
  for (const key of ttlKeys) {
    const n = Number(json?.[key]);
    if (Number.isFinite(n) && n > 0) return Date.now() + n * 1000;
  }
  return fallbackTtlSec ? Date.now() + fallbackTtlSec * 1000 : undefined;
}

function cacheAuthFailure(diag: YeastarDiagnostic): void {
  lastAuthFailure = diag;
  if (diag.category === "max_limitation" || diag.errcode === 60002) {
    consecutiveAuthFailures += 1;
    const backoff = Math.min(MAX_AUTH_BLOCK_MS, MIN_AUTH_BLOCK_MS * Math.pow(2, consecutiveAuthFailures - 1));
    authBlockedUntil = Date.now() + backoff;
    console.error(`[yeastar auth] errcode 60002 (attempt ${consecutiveAuthFailures}); blocking /get_token for ${Math.round(backoff / 60_000)} min. Existing cached tokens (if any) will still be reused.`);
    void persistBlock(new Date(authBlockedUntil), diag.message).catch(() => { /* best-effort */ });
  }
}

// -------- Persistent (Supabase) token cache --------
//
// Level-2 cache: survives Worker cold starts and is shared across all
// Cloudflare isolates. Level-1 is `cachedToken` above.
//
// A short-lived lease column (auth_lock_holder / auth_lock_expires_at) is used
// as a distributed lock so that only one Worker at a time performs /get_token
// or /refresh_token, preventing thundering-herd auth on cold deploys.

interface PersistentTokenRow {
  access_token: string;
  refresh_token: string | null;
  expires_at: string;
  refresh_expires_at: string | null;
  cred_fingerprint: string;
  auth_blocked_until: string | null;
}

async function loadPersistentToken(): Promise<PersistentTokenRow | null> {
  try {
    const { data, error } = await supabaseAdmin
      .from("yeastar_token_cache")
      .select("access_token, refresh_token, expires_at, refresh_expires_at, cred_fingerprint, auth_blocked_until")
      .eq("id", "singleton")
      .maybeSingle();
    if (error) { console.warn("[yeastar persist] load failed:", error.message); return null; }
    return (data as PersistentTokenRow) ?? null;
  } catch (err) {
    console.warn("[yeastar persist] load exception:", err instanceof Error ? err.message : err);
    return null;
  }
}

async function persistToken(state: TokenState, fingerprint: string): Promise<void> {
  try {
    const { error } = await supabaseAdmin
      .from("yeastar_token_cache")
      .upsert({
        id: "singleton",
        access_token: state.accessToken,
        refresh_token: state.refreshToken ?? null,
        expires_at: new Date(state.expiresAt).toISOString(),
        refresh_expires_at: state.refreshExpiresAt ? new Date(state.refreshExpiresAt).toISOString() : null,
        cred_fingerprint: fingerprint,
        auth_blocked_until: null,
        last_error: null,
      });
    if (error) console.warn("[yeastar persist] write failed:", error.message);
    else console.log("[yeastar persist] token written to Supabase (expires in " + Math.floor((state.expiresAt - Date.now()) / 1000) + "s)");
  } catch (err) {
    console.warn("[yeastar persist] write exception:", err instanceof Error ? err.message : err);
  }
}

async function persistBlock(blockedUntil: Date, errorMessage: string): Promise<void> {
  try {
    await supabaseAdmin
      .from("yeastar_token_cache")
      .update({ auth_blocked_until: blockedUntil.toISOString(), last_error: errorMessage })
      .eq("id", "singleton");
  } catch { /* best-effort */ }
}

/**
 * Try to acquire the distributed auth lease. Returns the persistent token
 * snapshot when the lease is granted (so we can double-check whether another
 * Worker already refreshed the token while we were waiting). Returns null if
 * another Worker currently holds the lease.
 */
async function tryClaimAuthLease(): Promise<PersistentTokenRow | null> {
  try {
    const { data, error } = await supabaseAdmin.rpc("yeastar_try_claim_auth_lease", {
      _holder: getOrInitWorkerId(),
      _lease_sec: AUTH_LEASE_SEC,
    });
    if (error) { console.warn("[yeastar lease] claim failed:", error.message); return null; }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.lease_acquired) return null;
    return row as PersistentTokenRow;
  } catch (err) {
    console.warn("[yeastar lease] claim exception:", err instanceof Error ? err.message : err);
    return null;
  }
}

async function releaseAuthLease(): Promise<void> {
  try {
    await supabaseAdmin.rpc("yeastar_release_auth_lease", { _holder: getOrInitWorkerId() });
  } catch { /* best-effort */ }
}

function hydrateFromPersistent(row: PersistentTokenRow, fingerprint: string): boolean {
  if (row.cred_fingerprint !== fingerprint) return false;
  if (!row.access_token) return false;
  cachedToken = {
    accessToken: row.access_token,
    refreshToken: row.refresh_token ?? undefined,
    expiresAt: Date.parse(row.expires_at),
    refreshExpiresAt: row.refresh_expires_at ? Date.parse(row.refresh_expires_at) : undefined,
  };
  if (row.auth_blocked_until) {
    const blockedUntilMs = Date.parse(row.auth_blocked_until);
    if (blockedUntilMs > Date.now()) authBlockedUntil = blockedUntilMs;
  }
  return true;
}



function blockedAuthDiagnostic(): YeastarDiagnostic | null {
  if (!lastAuthFailure || Date.now() >= authBlockedUntil) return null;
  const retryInSec = Math.ceil((authBlockedUntil - Date.now()) / 1000);
  return {
    ...lastAuthFailure,
    message: `${lastAuthFailure.message} Authentication is paused for ${retryInSec}s to avoid a retry loop.`,
  };
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
  const token = cachedToken!.accessToken;
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
  if (!isRefreshTokenValid()) return null;
  const endpoint = `${env.base}/openapi/v1.0/refresh_token`;
  lastAuthTrace.refreshTokenCalled = true;
  console.log(`[yeastar auth] POST /refresh_token (no new PBX session; cache=${tokenStatus()})`);
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
    const diag = mapAuthErrcode(env, endpoint, res.status, bodyText, json);
    cacheAuthFailure(diag);
    console.warn(`[yeastar auth] refresh failed HTTP ${res.status} errcode=${json?.errcode ?? "n/a"} errmsg=${json?.errmsg ?? "n/a"}; no /get_token fallback while refresh token is unexpired`);
    return diag;
  }
  const expiresAt = parseExpiryMs(json, ["expires_at", "access_token_expires_at"], ["access_token_expire_time", "expire_time"], 1800)!;
  const refreshExpiresAt = parseExpiryMs(json, ["refresh_expires_at", "refresh_token_expires_at"], ["refresh_token_expire_time"]);
  cachedToken = {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? cachedToken.refreshToken,
    expiresAt,
    refreshExpiresAt: refreshExpiresAt ?? cachedToken.refreshExpiresAt,
  };
  lastAuthFailure = null;
  authBlockedUntil = 0;
  consecutiveAuthFailures = 0;
  await persistToken(cachedToken, credFingerprint());
  logTokenSource("Refreshed Token", false);
  const ttlSec = Math.floor(remainingAccessMs() / 1000);
  return {
    ok: true, category: "ok", baseUrl: env.base, endpoint, userAgent: USER_AGENT,
    httpStatus: 200, errcode: 0,
    message: `Refreshed access token (valid for ${ttlSec}s) without opening a new session.`,
  };
}


/**
 * Request a brand-new access token. This is only called by the shared
 * authentication lock after both cached access and refresh tokens are unusable.
 */
async function requestNewToken(env: { base: string; id: string; secret: string }): Promise<YeastarDiagnostic> {
  const endpoint = `${env.base}/openapi/v1.0/get_token`;
  const blocked = blockedAuthDiagnostic();
  if (blocked) return blocked;
  console.log(`[yeastar auth] POST /get_token (NEW PBX SESSION; cache=${tokenStatus()})`);
  let res: Response;
  try {
    res = await timedFetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify({ username: env.id, password: env.secret }),
    });
  } catch (err) {
    const { category, message } = classifyNetworkError(err);
    console.error("[yeastar auth] get_token transport failure:", category, message);
    return { ok: false, category, baseUrl: env.base, endpoint, userAgent: USER_AGENT, message };
  }
  const bodyText = await res.text().catch(() => "");
  const httpStatus = res.status;
  let json: any = null;
  try { json = bodyText ? JSON.parse(bodyText) : null; } catch { /* non-JSON */ }
  console.log(`[yeastar auth] get_token HTTP ${httpStatus} errcode=${json?.errcode ?? "n/a"} errmsg=${json?.errmsg ?? "n/a"}`);
  if (httpStatus === 404) {
    return { ok: false, category: "invalid_endpoint", baseUrl: env.base, endpoint, userAgent: USER_AGENT,
      httpStatus, responseBody: bodyText,
      message: "Endpoint not found (HTTP 404). Verify the Base URL." };
  }
  if (!res.ok) {
    if (json?.errcode != null) {
      const diag = mapAuthErrcode(env, endpoint, httpStatus, bodyText, json);
      cacheAuthFailure(diag);
      return diag;
    }
    return { ok: false, category: "http_error", baseUrl: env.base, endpoint, userAgent: USER_AGENT,
      httpStatus, responseBody: bodyText, message: `PBX returned HTTP ${httpStatus}.` };
  }
  if (json && json.errcode === 0 && json.access_token) {
    const expiresAt = parseExpiryMs(json, ["expires_at", "access_token_expires_at"], ["access_token_expire_time", "expire_time"], 1800)!;
    const refreshExpiresAt = parseExpiryMs(json, ["refresh_expires_at", "refresh_token_expires_at"], ["refresh_token_expire_time"]);
    cachedToken = {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt,
      refreshExpiresAt,
    };
    lastAuthFailure = null;
    authBlockedUntil = 0;
    consecutiveAuthFailures = 0;
    await persistToken(cachedToken, credFingerprint());
    logTokenSource("New Authentication", true);
    const ttlSec = Math.floor(remainingAccessMs() / 1000);
    return {
      ok: true, category: "ok", baseUrl: env.base, endpoint, userAgent: USER_AGENT,
      httpStatus, errcode: 0,
      message: `Authentication successful. Token valid for ${ttlSec}s.`,
    };
  }

  const diag = mapAuthErrcode(env, endpoint, httpStatus, bodyText, json);
  cacheAuthFailure(diag);
  return diag;
}

async function getAccessTokenInfo(): Promise<TokenResult> {
  const env = requireEnv();
  if (!env) throw new Error("Yeastar not configured");
  lastAuthTrace = { refreshTokenCalled: false, leaseAcquired: false };
  ensureCredsFresh();

  // ---- Tier 1: in-isolate memory ----
  if (isAccessTokenValid()) {
    logTokenSource("Cached Access Token", false);
    return {
      accessToken: cachedToken!.accessToken,
      source: "Cached Access Token",
      remainingMs: remainingAccessMs(),
      getTokenCalled: false,
    };
  }

  // Coalesce concurrent callers in the same isolate onto a single auth op.
  if (inflightAuth) {
    console.log(`[yeastar auth] joining shared in-flight authentication request (cache=${tokenStatus()})`);
    return inflightAuth;
  }

  inflightAuth = (async (): Promise<TokenResult> => {
    ensureCredsFresh();

    if (isAccessTokenValid()) {
      logTokenSource("Cached Access Token", false);
      return { accessToken: cachedToken!.accessToken, source: "Cached Access Token", remainingMs: remainingAccessMs(), getTokenCalled: false };
    }

    // ---- Tier 2: Supabase persistent cache (survives cold starts / isolate churn) ----
    const persistedBeforeLease = await loadPersistentToken();
    if (persistedBeforeLease && hydrateFromPersistent(persistedBeforeLease, credFingerprint()) && isAccessTokenValid()) {
      logTokenSource("Persistent Cache", false);
      return { accessToken: cachedToken!.accessToken, source: "Persistent Cache", remainingMs: remainingAccessMs(), getTokenCalled: false };
    }

    // Local block window (memory) — check before hitting the network.
    const blockedLocal = blockedAuthDiagnostic();
    if (blockedLocal) {
      const err: any = new Error(`YEASTAR_DIAG:${JSON.stringify(blockedLocal)}`);
      err.diagnostic = blockedLocal;
      throw err;
    }

    // ---- Distributed lease: only one Worker can hit /refresh_token or /get_token ----
    let leaseRow: PersistentTokenRow | null = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      leaseRow = await tryClaimAuthLease();
      if (leaseRow) { lastAuthTrace.leaseAcquired = true; break; }
      console.log(`[yeastar lease] another Worker holds the auth lease; waiting (attempt ${attempt + 1}/6)`);
      await sleep(500 + Math.floor(Math.random() * 500));
      // While waiting, another isolate may have written a fresh token.
      const snap = await loadPersistentToken();
      if (snap && hydrateFromPersistent(snap, credFingerprint()) && isAccessTokenValid()) {
        logTokenSource("Persistent Cache", false);
        return { accessToken: cachedToken!.accessToken, source: "Persistent Cache", remainingMs: remainingAccessMs(), getTokenCalled: false };
      }
    }
    if (!leaseRow) {
      const diag: YeastarDiagnostic = {
        ok: false, category: "authentication", baseUrl: env.base,
        endpoint: `${env.base}/openapi/v1.0/get_token`, userAgent: USER_AGENT,
        message: "Timed out waiting for the distributed authentication lease; another Worker is refreshing.",
      };
      const err: any = new Error(`YEASTAR_DIAG:${JSON.stringify(diag)}`);
      err.diagnostic = diag;
      throw err;
    }

    try {
      // Re-check the row we got with the lease — a concurrent Worker may have
      // written a fresh token seconds ago.
      if (hydrateFromPersistent(leaseRow, credFingerprint()) && isAccessTokenValid()) {
        logTokenSource("Persistent Cache", false);
        return { accessToken: cachedToken!.accessToken, source: "Persistent Cache", remainingMs: remainingAccessMs(), getTokenCalled: false };
      }

      // Honor a persisted 60002 block set by another Worker.
      if (leaseRow.auth_blocked_until) {
        const blockedUntilMs = Date.parse(leaseRow.auth_blocked_until);
        if (blockedUntilMs > Date.now()) {
          authBlockedUntil = blockedUntilMs;
          const retryInSec = Math.ceil((blockedUntilMs - Date.now()) / 1000);
          const diag: YeastarDiagnostic = {
            ok: false, category: "max_limitation", baseUrl: env.base,
            endpoint: `${env.base}/openapi/v1.0/get_token`, userAgent: USER_AGENT,
            errcode: 60002,
            message: `Authentication paused for ${retryInSec}s (persistent 60002 block from another Worker).`,
          };
          const err: any = new Error(`YEASTAR_DIAG:${JSON.stringify(diag)}`);
          err.diagnostic = diag;
          throw err;
        }
      }

      // Try refresh first (no new PBX session).
      if (isRefreshTokenValid()) {
        const refreshed = await refreshAccessToken(env);
        if (refreshed?.ok && cachedToken?.accessToken) {
          return { accessToken: cachedToken.accessToken, source: "Refreshed Token", remainingMs: remainingAccessMs(), getTokenCalled: false };
        }
        const diag = refreshed ?? {
          ok: false as const, category: "authentication" as const,
          baseUrl: env.base, endpoint: `${env.base}/openapi/v1.0/refresh_token`, userAgent: USER_AGENT,
          message: "Refresh token request failed; refusing to open a new PBX session while the refresh token is still valid.",
        };
        const err: any = new Error(`YEASTAR_DIAG:${JSON.stringify(diag)}`);
        err.diagnostic = diag;
        throw err;
      }

      // Last resort: brand-new /get_token (one PBX session consumed).
      const authDiag = await requestNewToken(env);
      if (!authDiag.ok || !cachedToken?.accessToken) {
        const err: any = new Error(`YEASTAR_DIAG:${JSON.stringify(authDiag)}`);
        err.diagnostic = authDiag;
        throw err;
      }
      return { accessToken: cachedToken.accessToken, source: "New Authentication", remainingMs: remainingAccessMs(), getTokenCalled: true };
    } finally {
      await releaseAuthLease();
    }
  })();

  try {
    return await inflightAuth;
  } finally {
    inflightAuth = null;
  }
}

/**
 * Phase 1.5 diagnostic: run one authentication pass and expose full trace.
 */
export async function collectAuthDiagnostic() {
  const startedAt = Date.now();
  let auth: TokenResult | null = null;
  let error: string | null = null;
  try {
    auth = await getAccessTokenInfo();
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const trace = getLastAuthTrace();
  const snap = await readPersistentTokenSnapshot();
  return {
    workerId: WORKER_ID,
    authSource: auth?.source ?? "Blocked",
    getTokenCalled: auth?.getTokenCalled ?? false,
    refreshTokenCalled: trace.refreshTokenCalled,
    leaseAcquired: trace.leaseAcquired,
    tokenRemainingSec: auth ? Math.floor(auth.remainingMs / 1000) : 0,
    credFingerprint: credFingerprint(),
    authBlockedUntil: getAuthBlockedUntilIso(),
    persistent: snap,
    elapsedMs: Date.now() - startedAt,
    error,
  };
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
  console.log(`[yeastar diag] shared auth check start (cache=${tokenStatus()})`);

  try {
    const auth = await getAccessTokenInfo();
    const probed = await probeWithCachedToken(env, authEndpoint);
    if (probed.ok) {
      return {
        ...probed,
        message: `${probed.message} Auth source: ${auth.source}; remaining token lifetime ~${Math.floor(auth.remainingMs / 1000)}s; /get_token called: ${auth.getTokenCalled ? "yes" : "no"}.`,
      };
    }
    // Diagnostics should never invalidate an otherwise time-valid token or
    // authenticate again. A failed probe reports reachability/permission only.
    console.warn(`[yeastar diag] probe failed after shared auth source=${auth.source}; preserving token cache; no re-authentication`);
    return probed;
  } catch (err) {
    const diag = (err as any)?.diagnostic as YeastarDiagnostic | undefined;
    if (diag) return diag;
    const { category, message } = classifyNetworkError(err);
    return { ok: false, category, baseUrl: env.base, endpoint: authEndpoint, userAgent: USER_AGENT, message };
  }
}

async function getAccessToken(): Promise<string> {
  const auth = await getAccessTokenInfo();
  return auth.accessToken;
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
  authSource?: TokenSource;
  remainingTokenLifetimeSec?: number;
  getTokenCalled?: boolean;
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

// -------- Extension Whitelist (fixed configuration) --------
//
// The current Yeastar firmware does not expose Extension Groups through the
// OpenAPI, so team membership is stored here as a fixed whitelist instead.
// Edit this list to add/remove agents without touching analytics logic.

export type TeamKey = "customer_care" | "telesales";

export interface WhitelistEntry {
  extension: string;
  fullName: string;
  role: "admin" | "customer_care" | "telesales";
  agentCode: string;
}

export const EXTENSION_WHITELIST: WhitelistEntry[] = [
  { extension: "4000", fullName: "Omar Badawi",     role: "admin",         agentCode: "Owner" },
  { extension: "4002", fullName: "Dalia Basyouni",  role: "customer_care", agentCode: "4002" },
  { extension: "4003", fullName: "Rahaf Kassem",    role: "customer_care", agentCode: "4003" },
  { extension: "4004", fullName: "Rana Amin",       role: "customer_care", agentCode: "4004" },
  { extension: "4005", fullName: "Shams Rafiq",     role: "customer_care", agentCode: "4005" },
  { extension: "4006", fullName: "Fadwa Shawky",    role: "customer_care", agentCode: "4006" },
  { extension: "1000", fullName: "Ahmed Mousad",    role: "telesales",     agentCode: "1000" },
  { extension: "1001", fullName: "Kamr Elsayed",    role: "telesales",     agentCode: "1001" },
];

/** Normalize an extension identifier for comparison. */
export function normalizeExt(v: unknown): string {
  return String(v ?? "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .toLowerCase();
}

export interface GroupExtension { number: string; name?: string; status?: string }
export interface TeamExtensionResult {
  groups: Record<TeamKey, { name: string; found: true; extensions: GroupExtension[] }>;
  all: Array<GroupExtension & { team: TeamKey }>;
}

/** Returns the whitelist extensions grouped by team. Admin (4000) is
 *  intentionally excluded from team stats but remains in EXTENSION_WHITELIST
 *  for future admin reporting. */
export function getTeamExtensions(): TeamExtensionResult {
  const customer_care: GroupExtension[] = [];
  const telesales: GroupExtension[] = [];
  const all: Array<GroupExtension & { team: TeamKey }> = [];
  for (const w of EXTENSION_WHITELIST) {
    if (w.role === "customer_care") {
      const e: GroupExtension = { number: normalizeExt(w.extension), name: w.fullName };
      customer_care.push(e);
      all.push({ ...e, team: "customer_care" });
    } else if (w.role === "telesales") {
      const e: GroupExtension = { number: normalizeExt(w.extension), name: w.fullName };
      telesales.push(e);
      all.push({ ...e, team: "telesales" });
    }
  }
  return {
    groups: {
      customer_care: { name: "Customer Care", found: true, extensions: customer_care },
      telesales:     { name: "Telesales",     found: true, extensions: telesales },
    },
    all,
  };
}


/**
 * Fetch CDR records for a date range. Yeastar limits per-page results,
 * so we paginate. Dates in `YYYY-MM-DD` format.
 */
export async function fetchCdr(
  fromDate: string,
  toDate: string,
  allowedExtensions?: Set<string>,
): Promise<{ records: YeastarCdrRecord[]; diagnostic: CdrDiagnostic; timings: { authMs: number; requestMs: number; filterMs: number; totalFetched: number; keptAfterFilter: number } }> {
  const env = requireEnv();
  const endpoint = `${env!.base}/openapi/v1.0/cdr/list`;
  const start = fmtDate(fromDate);
  const end = fmtDateEnd(toDate);
  console.log(`[yeastar cdr] applying dashboard date range: from=${fromDate} to=${toDate} → start_time="${start}" end_time="${end}"`);
  const diagnostic: CdrDiagnostic = {
    endpoint,
    requestUrl: "",
    queryParams: { start_time: start, end_time: end, page: "1", page_size: "500" },
    timeRange: { start, end },
    recordsReturned: 0,
    rawResponsePreview: "",
  };
  const timings = { authMs: 0, requestMs: 0, filterMs: 0, totalFetched: 0, keptAfterFilter: 0 };
  if (!env) return { records: [], diagnostic, timings };
  const tAuth = Date.now();
  const auth = await getAccessTokenInfo();
  const token = auth.accessToken;
  timings.authMs = Date.now() - tAuth;
  diagnostic.authSource = auth.source;
  diagnostic.remainingTokenLifetimeSec = Math.floor(auth.remainingMs / 1000);
  diagnostic.getTokenCalled = auth.getTokenCalled;

  const parseRow = (r: any): YeastarCdrRecord => ({
    call_id: String(r.call_id ?? r.uid ?? r.id ?? ""),
    time_start: r.time_start ?? r.time ?? r.start_time ?? "",
    call_from: r.call_from ?? r.src_number ?? r.from ?? "",
    call_to: r.call_to ?? r.dst_number ?? r.to ?? "",
    src_name: r.src_name,
    dst_name: r.dst_name,
    src_number: r.src_number ?? r.call_from,
    dst_number: r.dst_number ?? r.call_to,
    extension: r.extension ?? r.extension_number,
    extension_number: r.extension_number ?? r.extension,
    call_type: r.call_type ?? r.type ?? r.communication_type,
    status: r.status ?? r.call_status ?? r.disposition,
    duration: Number(r.duration ?? 0),
    talk_duration: Number(r.talk_duration ?? r.billsec ?? 0),
  });

  // Fetch one extension's CDR pages. Uses Yeastar's server-side `number`
  // filter so the PBX only returns records for this extension — dramatically
  // smaller payload than a full unfiltered scan of tens of thousands of rows.
  const fetchForExtension = async (ext: string): Promise<YeastarCdrRecord[]> => {
    const out: YeastarCdrRecord[] = [];
    const pageSize = 500;
    for (let page = 1; page <= 20; page++) {
      const qs =
        `access_token=${encodeURIComponent(token)}` +
        `&start_time=${encodeURIComponent(start)}` +
        `&end_time=${encodeURIComponent(end)}` +
        `&number=${encodeURIComponent(ext)}` +
        `&page=${page}` +
        `&page_size=${pageSize}` +
        `&sort_by=time` +
        `&order_by=desc`;
      const fullUrl = `${endpoint}?${qs}`;
      const masked = fullUrl.replace(encodeURIComponent(token), "***MASKED***");
      if (page === 1 && !diagnostic.requestUrl) diagnostic.requestUrl = masked;
      const res = await timedFetch(fullUrl, { headers: { "Accept": "application/json", "User-Agent": USER_AGENT } });
      const bodyText = await res.text().catch(() => "");
      if (page === 1 && !diagnostic.httpStatus) {
        diagnostic.httpStatus = res.status;
        diagnostic.rawResponsePreview = bodyText.slice(0, 1500);
      }
      if (!res.ok) throw new Error(`Yeastar CDR HTTP ${res.status}: ${bodyText.slice(0, 200)}`);
      let json: any = null;
      try { json = JSON.parse(bodyText); } catch { throw new Error(`Yeastar CDR non-JSON response: ${bodyText.slice(0, 200)}`); }
      if (page === 1) {
        diagnostic.errcode ??= json?.errcode;
        diagnostic.errmsg ??= json?.errmsg;
      }
      if (json.errcode !== 0) {
        if (json.errcode === 70087) throw new Error("IP_FORBIDDEN: PBX rejected the server IP.");
        throw new Error(`Yeastar CDR error ${json.errcode}: ${json.errmsg ?? "unknown"}`);
      }
      const rawList = json.cdr_list ?? json.data ?? json.cdr ?? json.list ?? json.result ?? [];
      const list: any[] = Array.isArray(rawList) ? rawList : [];
      timings.totalFetched += list.length;
      // Tag every record with the extension we queried so aggregation is
      // trivial (records don't always carry a top-level `extension` field).
      for (const r of list) {
        const rec = parseRow(r);
        rec.extension = ext;
        out.push(rec);
      }
      console.log(`[yeastar cdr] ext=${ext} page=${page} records=${list.length}`);
      if (list.length < pageSize) break;
    }
    return out;
  };

  const tReq = Date.now();
  let results: YeastarCdrRecord[] = [];
  if (allowedExtensions && allowedExtensions.size > 0) {
    // Parallel fan-out — one small request per whitelisted extension.
    const exts = [...allowedExtensions];
    console.log(`[yeastar cdr] fan-out ${exts.length} extensions in parallel: [${exts.join(", ")}]`);
    const chunks = await Promise.all(exts.map((e) => withRetry(`cdr ext ${e}`, () => fetchForExtension(e))));
    results = chunks.flat();
  } else {
    // Fallback: unfiltered scan (only used when caller passed no whitelist).
    console.warn("[yeastar cdr] no allowedExtensions provided — falling back to unfiltered scan");
    results = await withRetry("cdr unfiltered", () => fetchForExtension(""));
  }
  timings.requestMs = Date.now() - tReq;
  timings.keptAfterFilter = results.length;
  diagnostic.recordsReturned = results.length;
  diagnostic.totalNumber = results.length;
  if (results.length === 0 && !allowedExtensions) {
    diagnostic.extensionsSample = (await fetchExtensionsSample(env.base, token)).slice(0, 25);
  }
  console.log(`[yeastar cdr] window=${start}..${end} fetched=${timings.totalFetched} kept=${timings.keptAfterFilter} auth=${timings.authMs}ms req=${timings.requestMs}ms source=${auth.source} remaining=${diagnostic.remainingTokenLifetimeSec}s get_token_called=${auth.getTokenCalled}`);
  return { records: results, diagnostic, timings };
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
  filter?: {
    team?: "customer_care" | "telesales";
    extension?: string;
    /** normalized list of extensions permitted to appear in the analytics */
    allowedExtensions?: string[];
    /** number -> team, used when the agent directory has no matching entry */
    extensionTeamMap?: Record<string, "customer_care" | "telesales">;
  },
): CallStatsSummary {
  const dir = new Map(agents.map((a) => [normalizeExt(a.extension), a]));
  const allowed = filter?.allowedExtensions
    ? new Set(filter.allowedExtensions.map((e) => normalizeExt(e)))
    : null;
  const teamMap = new Map(
    Object.entries(filter?.extensionTeamMap ?? {}).map(([k, v]) => [normalizeExt(k), v]),
  );

  const byAgent = new Map<string, AgentCallStats>();
  let total = 0, answered = 0, missed = 0, inbound = 0, outbound = 0;
  let cc = 0, ts = 0;

  for (const r of records) {
    const ext = normalizeExt(r.extension ?? r.extension_number ?? r.src_number ?? r.dst_number ?? "");
    if (!ext) continue;
    if (allowed && !allowed.has(ext)) continue;
    const meta = dir.get(ext);
    const team = meta?.team ?? teamMap.get(ext) ?? null;
    if (filter?.team && team !== filter.team) continue;
    if (filter?.extension && ext !== normalizeExt(filter.extension)) continue;

    total += 1;
    const isAnswered = r.status ? ANSWERED_STATUSES.has(r.status) : (r.talk_duration ?? 0) > 0;
    if (isAnswered) answered += 1; else missed += 1;
    const isOutbound = (r.call_type ?? "").toLowerCase().includes("outbound");
    if (isOutbound) outbound += 1;
    else inbound += 1;

    if (team === "customer_care") cc += 1;
    else if (team === "telesales") ts += 1;

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
