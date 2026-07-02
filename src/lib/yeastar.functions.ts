/**
 * Yeastar server functions.
 *
 * Diagnostics require administrator role. Analytics require an authenticated
 * user (dashboard permission is checked client-side; RLS-free by design since
 * PBX data is not stored anywhere).
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
    const { getAccessToken, isConfigured, tokenSnapshot, YeastarAuthError } = await import("@/lib/yeastar/client.server");
    if (!isConfigured()) return { ok: false as const, configured: false as const };
    try {
      const started = Date.now();
      const { source } = await getAccessToken();
      return { ok: true as const, configured: true as const, source, elapsedMs: Date.now() - started, token: tokenSnapshot(), at: new Date().toISOString() };
    } catch (err) {
      const anyErr = err as any;
      if (anyErr instanceof YeastarAuthError) return { ok: false as const, configured: true as const, error: anyErr.message, details: anyErr.details };
      return { ok: false as const, configured: true as const, error: anyErr?.message ?? String(err) };
    }
  });

export const yeastarGroupsDiagnostic = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context as any);
    const { resolveExtensionGroups } = await import("@/lib/yeastar/groups.server");
    try {
      const data = await resolveExtensionGroups(true);
      return { ok: true as const, ...data };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

const analyticsInput = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  team: z.enum(["all", "customer_care", "telesales"]).default("all"),
  communicationType: z.enum(["All", "Inbound", "Outbound"]).default("All"),
  agentCode: z.string().optional(),
});

export const yeastarCallAnalytics = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => analyticsInput.parse(data))
  .handler(async ({ data }) => {
    const { fetchCallStatistics } = await import("@/lib/yeastar/reports.server");
    const { isConfigured } = await import("@/lib/yeastar/client.server");
    if (!isConfigured()) return { ok: false as const, configured: false as const, error: "Yeastar not configured" };
    try {
      const result = await fetchCallStatistics({
        from: data.from, to: data.to,
        team: data.team, communicationType: data.communicationType,
      });
      // Agent scoping: if a specific agent_code is supplied, keep only that extension.
      const filtered = data.agentCode
        ? { ...result, rows: result.rows.filter((r) => r.ext_num === data.agentCode) }
        : result;
      if (data.agentCode) {
        const sum = filtered.rows.reduce(
          (acc, r) => ({ total: acc.total + r.total, answered: acc.answered + r.answered, missed: acc.missed + r.missed, inbound: acc.inbound + r.inbound, outbound: acc.outbound + r.outbound }),
          { total: 0, answered: 0, missed: 0, inbound: 0, outbound: 0 },
        );
        filtered.totals = {
          ...sum,
          answerRate: sum.total > 0 ? Math.round((sum.answered / sum.total) * 1000) / 10 : 0,
          missedRate: sum.total > 0 ? Math.round((sum.missed / sum.total) * 1000) / 10 : 0,
        };
      }
      return { ok: true as const, configured: true as const, ...filtered };
    } catch (err) {
      return { ok: false as const, configured: true as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

export const yeastarDailyVolume = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => analyticsInput.parse(data))
  .handler(async ({ data }) => {
    const { fetchDailyVolume } = await import("@/lib/yeastar/reports.server");
    const { isConfigured } = await import("@/lib/yeastar/client.server");
    if (!isConfigured()) return { ok: false as const, series: [] };
    try {
      const series = await fetchDailyVolume({ from: data.from, to: data.to, team: data.team, communicationType: data.communicationType });
      return { ok: true as const, series };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err), series: [] as any[] };
    }
  });
