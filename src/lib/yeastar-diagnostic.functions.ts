import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Phase 1 diagnostic — isolated Yeastar smoke test.
 *
 * Does ONLY:
 *   1. Authenticate once (reuses the shared cached token — never mints a
 *      new PBX session if a valid access/refresh token is available).
 *   2. Request CDR for the last 24 hours (single unfiltered request via the
 *      shared fetchCdr, but capped by page_size).
 *   3. Return the first 10 records verbatim.
 *
 * No mapping. No Supabase user join. No extension filtering.
 * No analytics. No caching changes. No retries beyond the shared code path.
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
      // fetchCdr with no allowedExtensions → single unfiltered call.
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
