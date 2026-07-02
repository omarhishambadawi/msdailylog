/**
 * Yeastar P-Series OpenAPI client (server-only).
 *
 * Responsibilities:
 *   - Read credentials from env at request time (never at module scope).
 *   - Obtain an access_token via POST /openapi/v1.0/get_token.
 *   - Refresh proactively via POST /openapi/v1.0/refresh_token when the
 *     access token is within REFRESH_SKEW_MS of expiry.
 *   - Serialize concurrent auth requests inside a single Worker isolate
 *     using an in-flight promise (single-flight).
 *   - Provide `yeastarFetch()` — a thin authenticated GET helper that
 *     appends `access_token=` to the URL and retries once on HTTP 401.
 *
 * Cache scope: process memory only. A cold start re-authenticates. This is
 * intentional to keep the surface area minimal; the PBX allows session
 * reuse across the token lifetime (~30 min).
 */

const TOKEN_PATH = "/openapi/v1.0/get_token";
const REFRESH_PATH = "/openapi/v1.0/refresh_token";
const REFRESH_SKEW_MS = 60_000; // refresh 60s before expiry
// Yeastar docs require User-Agent: OpenAPI — PBX rejects other UAs with errcode -1 / FAILURE.
const UA = "OpenAPI";

export interface YeastarEnv {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
}

export interface TokenState {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number; // epoch ms
  refreshExpiresAt: number;
  obtainedAt: number;
}

export function readEnv(): YeastarEnv | null {
  const raw = process.env.YEASTAR_BASE_URL?.trim();
  const clientId = process.env.YEASTAR_CLIENT_ID?.trim();
  const clientSecret = process.env.YEASTAR_CLIENT_SECRET?.trim();
  if (!raw || !clientId || !clientSecret) return null;
  const trimmed = raw.replace(/\/+$/, "");
  const baseUrl = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return { baseUrl, clientId, clientSecret };
}

export function isConfigured(): boolean {
  return readEnv() !== null;
}

// ---- module cache -----------------------------------------------------------
let token: TokenState | null = null;
let inFlight: Promise<TokenState> | null = null;

export function _resetForTests() { token = null; inFlight = null; }

// ---- low-level HTTP ---------------------------------------------------------

interface JsonResponse<T = any> { httpStatus: number; body: string; json: T | null; }

async function postJson<T = any>(url: string, payload: unknown, signal?: AbortSignal): Promise<JsonResponse<T>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": UA },
    body: JSON.stringify(payload),
    signal,
  });
  const body = await res.text().catch(() => "");
  let json: T | null = null;
  try { json = body ? (JSON.parse(body) as T) : null; } catch { /* non-JSON */ }
  return { httpStatus: res.status, body, json };
}

// ---- auth flows -------------------------------------------------------------

async function requestNewToken(env: YeastarEnv): Promise<TokenState> {
  const url = `${env.baseUrl}${TOKEN_PATH}`;
  console.log("[yeastar] POST /get_token");
  const { httpStatus, body, json } = await postJson<any>(url, {
    username: env.clientId,
    password: env.clientSecret,
  });
  if (httpStatus !== 200 || !json || json.errcode !== 0 || !json.access_token) {
    throw new YeastarAuthError(
      `get_token failed: HTTP ${httpStatus} errcode=${json?.errcode ?? "n/a"} errmsg=${json?.errmsg ?? "n/a"}`,
      { httpStatus, errcode: json?.errcode ?? null, errmsg: json?.errmsg ?? null, bodyPreview: body.slice(0, 300) },
    );
  }
  const now = Date.now();
  const state: TokenState = {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    accessExpiresAt: now + Number(json.access_token_expire_time ?? 1800) * 1000,
    refreshExpiresAt: now + Number(json.refresh_token_expire_time ?? 86400) * 1000,
    obtainedAt: now,
  };
  console.log(`[yeastar] get_token OK; access lifetime=${Math.round((state.accessExpiresAt - now) / 1000)}s`);
  return state;
}

async function refreshToken(env: YeastarEnv, current: TokenState): Promise<TokenState> {
  const url = `${env.baseUrl}${REFRESH_PATH}`;
  console.log("[yeastar] POST /refresh_token");
  const { httpStatus, json } = await postJson<any>(url, { refresh_token: current.refreshToken });
  if (httpStatus !== 200 || !json || json.errcode !== 0 || !json.access_token) {
    console.warn(`[yeastar] refresh failed (HTTP ${httpStatus} errcode=${json?.errcode ?? "n/a"}); falling back to /get_token`);
    return requestNewToken(env);
  }
  const now = Date.now();
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? current.refreshToken,
    accessExpiresAt: now + Number(json.access_token_expire_time ?? 1800) * 1000,
    refreshExpiresAt: now + Number(json.refresh_token_expire_time ?? 86400) * 1000,
    obtainedAt: now,
  };
}

export class YeastarAuthError extends Error {
  details: { httpStatus: number; errcode: number | null; errmsg: string | null; bodyPreview: string };
  constructor(msg: string, details: YeastarAuthError["details"]) {
    super(msg);
    this.name = "YeastarAuthError";
    this.details = details;
  }
}

// ---- public: getAccessToken -------------------------------------------------

export interface AuthResult { token: TokenState; source: "cache" | "refresh" | "new"; }

export async function getAccessToken(): Promise<AuthResult> {
  const env = readEnv();
  if (!env) throw new Error("Yeastar not configured (missing env vars)");

  const now = Date.now();
  if (token && token.accessExpiresAt - now > REFRESH_SKEW_MS) {
    return { token, source: "cache" };
  }

  if (inFlight) {
    const t = await inFlight;
    return { token: t, source: "cache" };
  }

  const canRefresh = !!token && token.refreshExpiresAt - now > 5_000;
  inFlight = (async () => {
    try {
      const next = canRefresh ? await refreshToken(env, token!) : await requestNewToken(env);
      token = next;
      return next;
    } finally {
      inFlight = null;
    }
  })();

  const next = await inFlight;
  return { token: next, source: canRefresh ? "refresh" : "new" };
}

// ---- public: yeastarFetch ---------------------------------------------------

/**
 * Authenticated GET against the Yeastar OpenAPI. `path` must start with `/`.
 * `query` params are URL-encoded; `access_token` is appended automatically.
 * On HTTP 401 / errcode 10003 (Session Expired), token is invalidated and
 * the request is retried exactly once.
 */
export async function yeastarFetch<T = any>(
  path: string,
  query: Record<string, string | number | undefined> = {},
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ httpStatus: number; json: T | null; body: string }> {
  const env = readEnv();
  if (!env) throw new Error("Yeastar not configured");

  const buildUrl = (accessToken: string) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") qs.set(k, String(v));
    qs.set("access_token", accessToken);
    return `${env.baseUrl}${path}?${qs.toString()}`;
  };

  const doOnce = async (): Promise<{ httpStatus: number; json: T | null; body: string; retryAuth: boolean }> => {
    const { token: t } = await getAccessToken();
    const timeout = opts.timeoutMs ?? 25_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const signal = opts.signal ?? controller.signal;
    try {
      const res = await fetch(buildUrl(t.accessToken), {
        method: "GET",
        headers: { Accept: "application/json", "User-Agent": UA },
        signal,
      });
      const body = await res.text().catch(() => "");
      let json: T | null = null;
      try { json = body ? (JSON.parse(body) as T) : null; } catch { /* non-JSON */ }
      const errcode = (json as any)?.errcode;
      const retryAuth = res.status === 401 || errcode === 10003 || errcode === 10004;
      return { httpStatus: res.status, json, body, retryAuth };
    } finally {
      clearTimeout(timer);
    }
  };

  let out = await doOnce();
  if (out.retryAuth) {
    console.warn("[yeastar] auth-expired signal received; invalidating cache and retrying once");
    token = null;
    out = await doOnce();
  }
  return { httpStatus: out.httpStatus, json: out.json, body: out.body };
}

export function tokenSnapshot() {
  if (!token) return null;
  return {
    obtainedAt: new Date(token.obtainedAt).toISOString(),
    accessExpiresAt: new Date(token.accessExpiresAt).toISOString(),
    refreshExpiresAt: new Date(token.refreshExpiresAt).toISOString(),
    remainingAccessSec: Math.max(0, Math.floor((token.accessExpiresAt - Date.now()) / 1000)),
    remainingRefreshSec: Math.max(0, Math.floor((token.refreshExpiresAt - Date.now()) / 1000)),
  };
}
