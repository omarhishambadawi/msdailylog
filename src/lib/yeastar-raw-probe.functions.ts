import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * TEMPORARY DIAGNOSTIC — does NOT touch production auth/cache/analytics code.
 *
 * Performs a fresh /get_token then two raw GETs:
 *   GET /openapi/v1.0/extension/list
 *   GET /openapi/v1.0/cdr/list?page=1&page_size=1
 * Returns full URL (token masked), method, status, raw body, errcode, errmsg.
 */
async function assertAdmin(ctx: { supabase: any; userId: string }) {
  const { data, error } = await ctx.supabase.rpc("is_administrator", { _user_id: ctx.userId });
  if (error || !data) throw new Error("Forbidden: administrator access required");
}

interface RawCallResult {
  url: string;
  method: string;
  status: number | null;
  body: string;
  errcode: number | null;
  errmsg: string | null;
  networkError?: string;
}

async function rawGet(url: string, tokenToMask: string): Promise<RawCallResult> {
  const masked = url.replace(encodeURIComponent(tokenToMask), "***TOKEN***").replace(tokenToMask, "***TOKEN***");
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json", "User-Agent": "OpenAPI" },
    });
    const body = await res.text().catch(() => "");
    let errcode: number | null = null;
    let errmsg: string | null = null;
    try {
      const j = JSON.parse(body);
      errcode = typeof j?.errcode === "number" ? j.errcode : null;
      errmsg = typeof j?.errmsg === "string" ? j.errmsg : null;
    } catch { /* non-JSON */ }
    return { url: masked, method: "GET", status: res.status, body, errcode, errmsg };
  } catch (err) {
    return {
      url: masked,
      method: "GET",
      status: null,
      body: "",
      errcode: null,
      errmsg: null,
      networkError: err instanceof Error ? err.message : String(err),
    };
  }
}

export const yeastarRawProbe = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context as any);

    const base = process.env.YEASTAR_BASE_URL?.replace(/\/+$/, "");
    const id = process.env.YEASTAR_CLIENT_ID;
    const secret = process.env.YEASTAR_CLIENT_SECRET;
    if (!base || !id || !secret) {
      return { ok: false as const, error: "Yeastar env vars not set." };
    }
    const baseUrl = /^https?:\/\//i.test(base) ? base : `https://${base}`;

    // Fresh /get_token — isolated, does NOT touch cached token state.
    const tokenUrl = `${baseUrl}/openapi/v1.0/get_token`;
    let accessToken = "";
    let tokenRaw = "";
    let tokenStatus: number | null = null;
    let tokenErrcode: number | null = null;
    let tokenErrmsg: string | null = null;
    try {
      const r = await fetch(tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "OpenAPI" },
        body: JSON.stringify({ username: id, password: secret }),
      });
      tokenStatus = r.status;
      tokenRaw = await r.text().catch(() => "");
      try {
        const j = JSON.parse(tokenRaw);
        tokenErrcode = typeof j?.errcode === "number" ? j.errcode : null;
        tokenErrmsg = typeof j?.errmsg === "string" ? j.errmsg : null;
        accessToken = j?.access_token ?? "";
      } catch { /* ignore */ }
    } catch (err) {
      return {
        ok: false as const,
        step: "get_token",
        tokenUrl,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    if (!accessToken) {
      return {
        ok: false as const,
        step: "get_token",
        tokenUrl,
        tokenStatus,
        tokenErrcode,
        tokenErrmsg,
        tokenBodyPreview: tokenRaw.slice(0, 500),
      };
    }

    const tok = `access_token=${encodeURIComponent(accessToken)}`;
    const extUrl = `${baseUrl}/openapi/v1.0/extension/list?${tok}&page=1&page_size=1&sort_by=id&order_by=asc`;

    // Isolate which parameter causes errcode -3 by trying combinations.
    const cdrVariants: Record<string, string> = {
      minimal: `${baseUrl}/openapi/v1.0/cdr/list?${tok}&page=1&page_size=1`,
      with_time_string: `${baseUrl}/openapi/v1.0/cdr/list?${tok}&page=1&page_size=1&start_time=${encodeURIComponent("2026-07-01 00:00:00")}&end_time=${encodeURIComponent("2026-07-02 23:59:59")}`,
      with_time_epoch: `${baseUrl}/openapi/v1.0/cdr/list?${tok}&page=1&page_size=1&start_time=${Math.floor(Date.now()/1000) - 86400}&end_time=${Math.floor(Date.now()/1000)}`,
      with_time_ddmmyyyy: `${baseUrl}/openapi/v1.0/cdr/list?${tok}&page=1&page_size=1&start_time=${encodeURIComponent("01/07/2026 00:00:00")}&end_time=${encodeURIComponent("02/07/2026 23:59:59")}`,
      with_number: `${baseUrl}/openapi/v1.0/cdr/list?${tok}&page=1&page_size=1&number=4006`,
      with_sort_time: `${baseUrl}/openapi/v1.0/cdr/list?${tok}&page=1&page_size=1&sort_by=time&order_by=desc`,
      with_sort_id: `${baseUrl}/openapi/v1.0/cdr/list?${tok}&page=1&page_size=1&sort_by=id&order_by=desc`,
      full_prod: `${baseUrl}/openapi/v1.0/cdr/list?${tok}&start_time=${encodeURIComponent("2026-07-01 00:00:00")}&end_time=${encodeURIComponent("2026-07-02 23:59:59")}&number=4006&page=1&page_size=500&sort_by=time&order_by=desc`,
    };
    const [extRes, ...cdrEntries] = await Promise.all([
      rawGet(extUrl, accessToken),
      ...Object.entries(cdrVariants).map(([, u]) => rawGet(u, accessToken)),
    ]);
    const cdrResults: Record<string, RawCallResult> = {};
    Object.keys(cdrVariants).forEach((k, i) => { cdrResults[k] = cdrEntries[i]; });
    const cdrRes = cdrResults.minimal;

    // Truncate raw bodies to keep the payload manageable in the UI.
    const cap = (s: string) => (s.length > 4000 ? s.slice(0, 4000) + "…[truncated]" : s);
    extRes.body = cap(extRes.body);
    cdrRes.body = cap(cdrRes.body);

    return {
      ok: true as const,
      baseUrl,
      tokenStep: {
        url: tokenUrl,
        method: "POST",
        status: tokenStatus,
        errcode: tokenErrcode,
        errmsg: tokenErrmsg,
        tokenObtained: true,
      },
      extensionList: extRes,
      cdrList: cdrRes,
      at: new Date().toISOString(),
    };
  });
