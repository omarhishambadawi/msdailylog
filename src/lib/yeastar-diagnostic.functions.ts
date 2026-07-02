import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Phase 1 diagnostic — isolated Yeastar smoke test (auth + CDR).
 */
export const yeastarPhase1Probe = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
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
 * Phase 1.5 diagnostic — one authentication pass with full trace.
 * Does NOT fetch CDR. Safe to call repeatedly to verify cache reuse.
 */
export const yeastarAuthDiagnostic = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { collectAuthDiagnostic, isYeastarConfigured } = await import("@/lib/yeastar.server");
    if (!isYeastarConfigured()) {
      return { configured: false as const, message: "Yeastar env vars not set." };
    }
    const diag = await collectAuthDiagnostic();
    return { configured: true as const, ...diag, at: new Date().toISOString() };
  });

/**
 * TEST D helper: shrink the cached access token's remaining lifetime to force
 * the next auth call into the refresh path (no new PBX session).
 */
export const yeastarForceExpire = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { forceExpireAccessToken } = await import("@/lib/yeastar.server");
    return forceExpireAccessToken(60);
  });

