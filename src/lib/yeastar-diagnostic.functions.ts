import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function assertAdmin(ctx: { supabase: any; userId: string }) {
  // Owner and admin have identical administrative privileges.
  const { data, error } = await ctx.supabase.rpc("is_administrator", {
    _user_id: ctx.userId,
  });
  if (error) {
    console.error("[authz] is_administrator RPC error", { userId: ctx.userId, error: error.message });
    throw new Error("Forbidden: authorization check failed");
  }
  if (!data) {
    // Fetch role for debugging (owner/admin/etc.)
    const { data: roleRow } = await ctx.supabase
      .from("user_roles").select("role").eq("user_id", ctx.userId).maybeSingle();
    console.warn("[authz] non-administrator access attempt", { userId: ctx.userId, role: roleRow?.role ?? null });
    throw new Error("Forbidden: administrator access required (owner or admin)");
  }
  console.log("[authz] administrator access granted", { userId: ctx.userId });
}

/**
 * Phase 1 diagnostic — isolated Yeastar smoke test (auth + CDR). Admin only.
 */
export const yeastarPhase1Probe = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context as any);
    const started = Date.now();
    const { fetchCdr, isYeastarConfigured } = await import("@/lib/yeastar.server");
    if (!isYeastarConfigured()) {
      return { configured: false as const, message: "Yeastar env vars not set." };
    }
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const from = iso(yesterday);
    const to = iso(now);

    try {
      const { records, diagnostic, timings } = await fetchCdr(from, to);
      return {
        configured: true as const,
        ok: true as const,
        window: { from, to },
        authSource: diagnostic.authSource,
        getTokenCalled: diagnostic.getTokenCalled,
        remainingTokenLifetimeSec: diagnostic.remainingTokenLifetimeSec,
        httpStatus: diagnostic.httpStatus,
        totalFetched: timings.totalFetched,
        totalMs: Date.now() - started,
        first10: records.slice(0, 10),
      };
    } catch (err) {
      const anyErr = err as any;
      return {
        configured: true as const,
        ok: false as const,
        window: { from, to },
        error: anyErr?.message ?? String(err),
        diagnostic: anyErr?.diagnostic ?? null,
        totalMs: Date.now() - started,
      };
    }
  });

/**
 * Phase 1.5 diagnostic — one authentication pass with full trace. Admin only.
 */
export const yeastarAuthDiagnostic = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context as any);
    const { collectAuthDiagnostic, isYeastarConfigured } = await import("@/lib/yeastar.server");
    if (!isYeastarConfigured()) {
      return { configured: false as const, message: "Yeastar env vars not set." };
    }
    const diag = await collectAuthDiagnostic();
    return { configured: true as const, ...diag, at: new Date().toISOString() };
  });

/**
 * TEST D helper: shrink cached access token expiry to force refresh path. Admin only.
 */
export const yeastarForceExpire = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context as any);
    const { forceExpireAccessToken } = await import("@/lib/yeastar.server");
    return forceExpireAccessToken(60);
  });

/**
 * Config-only diagnostic. Reads env vars lazily inside the handler at request
 * time and returns booleans only — no secret values are exposed.
 */
export const yeastarConfigDiagnostic = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context as any);
    const baseUrlLoaded = !!process.env.YEASTAR_BASE_URL;
    const clientIdLoaded = !!process.env.YEASTAR_CLIENT_ID;
    const clientSecretLoaded = !!process.env.YEASTAR_CLIENT_SECRET;
    return {
      baseUrlLoaded,
      clientIdLoaded,
      clientSecretLoaded,
      source: "process.env (Cloudflare Worker runtime)",
      loadedAtRuntime: true,
      at: new Date().toISOString(),
    };
  });
