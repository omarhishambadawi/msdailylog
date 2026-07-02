/**
 * Yeastar diagnostic server functions (admin-only).
 * Thin wrappers over the client + CDR modules.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

async function assertAdmin(ctx: { supabase: any; userId: string }) {
  const { data, error } = await ctx.supabase.rpc("is_administrator", { _user_id: ctx.userId });
  if (error || !data) throw new Error("Forbidden: administrator access required");
}

export const yeastarConfigDiagnostic = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context as any);
    return {
      baseUrlLoaded: !!process.env.YEASTAR_BASE_URL,
      clientIdLoaded: !!process.env.YEASTAR_CLIENT_ID,
      clientSecretLoaded: !!process.env.YEASTAR_CLIENT_SECRET,
      source: "process.env (Cloudflare Worker runtime)",
      at: new Date().toISOString(),
    };
  });

export const yeastarAuthDiagnostic = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context as any);
    const { getAccessToken, isConfigured, tokenSnapshot, YeastarAuthError } =
      await import("@/lib/yeastar/client.server");
    if (!isConfigured()) return { ok: false as const, configured: false as const };
    try {
      const started = Date.now();
      const { source } = await getAccessToken();
      return {
        ok: true as const,
        configured: true as const,
        source,
        elapsedMs: Date.now() - started,
        token: tokenSnapshot(),
        at: new Date().toISOString(),
      };
    } catch (err) {
      const anyErr = err as any;
      if (anyErr instanceof YeastarAuthError) {
        return { ok: false as const, configured: true as const, error: anyErr.message, details: anyErr.details };
      }
      return { ok: false as const, configured: true as const, error: anyErr?.message ?? String(err) };
    }
  });

const cdrInput = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  limit: z.number().int().min(1).max(50).default(10),
});

export const yeastarCdrDiagnostic = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => cdrInput.parse(data))
  .handler(async ({ context, data }) => {
    await assertAdmin(context as any);
    const { fetchCdrRange } = await import("@/lib/yeastar/cdr.server");
    const { isConfigured } = await import("@/lib/yeastar/client.server");
    if (!isConfigured()) return { ok: false as const, configured: false as const };
    try {
      const result = await fetchCdrRange({ from: data.from, to: data.to, pageSize: 50, maxPages: 1 });
      return {
        ok: true as const,
        configured: true as const,
        window: { from: data.from, to: data.to },
        totalReported: result.totalReported,
        pagesFetched: result.pagesFetched,
        elapsedMs: result.elapsedMs,
        sample: result.records.slice(0, data.limit),
      };
    } catch (err) {
      return { ok: false as const, configured: true as const, error: err instanceof Error ? err.message : String(err) };
    }
  });
