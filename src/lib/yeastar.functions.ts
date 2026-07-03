/**
 * Yeastar server functions.
 *
 * Diagnostics + mapping management require administrator role. Analytics
 * require an authenticated user; PBX data is never persisted.
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

// ---- Extension mapping ------------------------------------------------------

export const yeastarMappingList = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context as any);
    const { loadMappingRows } = await import("@/lib/yeastar/mapping.server");
    const rows = await loadMappingRows(true);
    return { rows };
  });

export const yeastarMappingDiagnostic = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context as any);
    const { resolveMappingContext } = await import("@/lib/yeastar/mapping.server");
    try {
      const ctx = await resolveMappingContext(true);
      const byTeam = { customer_care: 0, telesales: 0 };
      for (const r of ctx.byExtNum.values()) byTeam[r.team]++;
      return {
        ok: true as const,
        mappedExtensions: ctx.byExtNum.size,
        byTeam,
        pbxResolved: ctx.extNumToId.size,
        missingOnPbx: ctx.missingOnPbx,
        unmappedFromPbx: ctx.unmappedFromPbx,
        fetchedAt: ctx.fetchedAt,
      };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

const importSchema = z.object({
  csv: z.string().min(1),
  replace: z.boolean().default(true),
});

export const yeastarMappingImport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => importSchema.parse(d))
  .handler(async ({ context, data }) => {
    await assertAdmin(context as any);
    const { parseMappingCsv, resetMappingCache } = await import("@/lib/yeastar/mapping.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { rows, errors } = parseMappingCsv(data.csv);
    if (rows.length === 0) return { ok: false as const, inserted: 0, errors, message: "No valid rows" };

    // Deduplicate by ext_num (keep last).
    const dedup = new Map<string, typeof rows[number]>();
    for (const r of rows) dedup.set(r.ext_num, r);
    const payload = [...dedup.values()].map((r) => ({
      ext_num: r.ext_num,
      agent_name: r.agent_name,
      team: r.team,
      agent_code: r.ext_num, // Extension Number IS the Agent Code
      active: true,
      updated_at: new Date().toISOString(),
    }));

    if (data.replace) {
      const { error: delErr } = await supabaseAdmin.from("yeastar_extension_map").delete().neq("ext_num", "__none__");
      if (delErr) return { ok: false as const, error: `clear failed: ${delErr.message}`, inserted: 0, errors };
    }
    const { error: upErr } = await supabaseAdmin
      .from("yeastar_extension_map")
      .upsert(payload, { onConflict: "ext_num" });
    if (upErr) return { ok: false as const, error: `upsert failed: ${upErr.message}`, inserted: 0, errors };
    resetMappingCache();
    return { ok: true as const, inserted: payload.length, errors };
  });

// ---- Analytics --------------------------------------------------------------

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
      const filtered = data.agentCode
        ? { ...result, rows: result.rows.filter((r) => (r.agent_code ?? r.ext_num) === data.agentCode) }
        : result;
      if (data.agentCode) {
        const sum = filtered.rows.reduce(
          (acc, r) => ({
            total: acc.total + r.total,
            answered: acc.answered + r.answered,
            missed: acc.missed + r.missed,
            inbound: acc.inbound + r.inbound,
            outbound: acc.outbound + r.outbound,
            talkTimeSec: acc.talkTimeSec + r.talkTimeSec,
          }),
          { total: 0, answered: 0, missed: 0, inbound: 0, outbound: 0, talkTimeSec: 0 },
        );
        filtered.totals = {
          total: sum.total, answered: sum.answered, missed: sum.missed,
          inbound: sum.inbound, outbound: sum.outbound,
          answerRate: sum.total > 0 ? Math.round((sum.answered / sum.total) * 1000) / 10 : 0,
          missedRate: sum.total > 0 ? Math.round((sum.missed / sum.total) * 1000) / 10 : 0,
          avgTalkSec: sum.answered > 0 ? Math.round(sum.talkTimeSec / sum.answered) : 0,
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
