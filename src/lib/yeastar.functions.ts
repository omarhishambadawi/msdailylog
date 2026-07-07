/**
 * Yeastar server functions.
 *
 * Config + auth diagnostics require administrator. Analytics require an
 * authenticated user with `view_dashboard`; non-admins are auto-scoped to
 * themselves. PBX data is never persisted.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

async function assertAdmin(ctx: { supabase: any; userId: string }) {
  const { data, error } = await ctx.supabase.rpc("is_administrator", { _user_id: ctx.userId });
  if (error || !data) throw new Error("Forbidden: administrator access required");
}

// ---- Configuration / auth diagnostics --------------------------------------

export const yeastarConfigDiagnostic = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context as any);
    return {
      baseUrlLoaded: !!process.env.YEASTAR_BASE_URL,
      clientIdLoaded: !!process.env.YEASTAR_CLIENT_ID,
      clientSecretLoaded: !!process.env.YEASTAR_CLIENT_SECRET,
      utcOffsetMinutes: Number(process.env.YEASTAR_UTC_OFFSET_MINUTES ?? 180),
      datetimeFormat: process.env.YEASTAR_DATETIME_FORMAT ?? "yyyy/MM/dd HH:mm:ss",
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

// ---- CDR probe (admin only) ------------------------------------------------

const cdrProbeInput = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const yeastarCdrProbe = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => cdrProbeInput.parse(d))
  .handler(async ({ context, data }) => {
    await assertAdmin(context as any);
    const { isConfigured } = await import("@/lib/yeastar/client.server");
    if (!isConfigured()) return { ok: false as const, configured: false as const };
    try {
      const { fetchCdrRange } = await import("@/lib/yeastar/cdr.server");
      const res = await fetchCdrRange({ from: data.from, to: data.to });
      return {
        ok: true as const,
        configured: true as const,
        path: res.path,
        totalReported: res.totalReported,
        fetched: res.records.length,
        truncated: res.truncated,
        pagesFetched: res.pagesFetched,
        elapsedMs: res.elapsedMs,
        sample: res.records.slice(0, 8).map((r) => ({
          time: r.time, timestamp: r.timestamp, call_type: r.call_type,
          disposition: r.disposition, call_from_number: r.call_from_number,
          call_to_number: r.call_to_number,
          talk_duration: r.talk_duration, ring_duration: r.ring_duration,
          duration: r.duration,
          // ID fields for grouping diagnosis
          id: (r as any).id, uid: (r as any).uid, new_id: (r as any).new_id,
          call_id: (r as any).call_id, linkedid: (r as any).linkedid,
          linked_id: (r as any).linked_id, pin_code: (r as any).pin_code,
          agent_ring_time: (r as any).agent_ring_time,
          wait_time: (r as any).wait_time,
        })),
      };
    } catch (err) {
      return { ok: false as const, configured: true as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

// ---- Agent mapping diagnostic (admin) --------------------------------------

export const yeastarAgentMappingDiagnostic = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => cdrProbeInput.parse(d))
  .handler(async ({ context, data }) => {
    await assertAdmin(context as any);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: profiles } = await supabaseAdmin
      .from("profiles")
      .select("id,full_name,agent_code,active");
    // yeastar_ext isn't in generated types yet; separate select cast.
    const { data: extRows } = await supabaseAdmin
      .from("profiles" as any)
      .select("id,yeastar_ext");
    const extMap = new Map<string, string | null>(
      ((extRows as any[]) ?? []).map((r) => [r.id, r.yeastar_ext ?? null]),
    );
    const { data: roles } = await supabaseAdmin.from("user_roles").select("user_id,role");
    const roleMap = new Map(((roles as any[]) ?? []).map((r) => [r.user_id, r.role as string]));

    const agents = ((profiles as any[]) ?? [])
      .filter((p) => p.active)
      .map((p) => ({ id: p.id, name: p.full_name, agent_code: p.agent_code ?? null, ext: extMap.get(p.id) ?? null, role: roleMap.get(p.id) ?? null }))
      .filter((p) => p.role === "customer_care" || p.role === "telesales");

    const missingExt = agents.filter((a) => !a.ext || !String(a.ext).trim());

    const { isConfigured } = await import("@/lib/yeastar/client.server");
    let topUnmatched: Array<{ ext: string; count: number }> = [];
    let cdrError: string | null = null;
    if (isConfigured()) {
      try {
        const { fetchCdrRange } = await import("@/lib/yeastar/cdr.server");
        const { records } = await fetchCdrRange({ from: data.from, to: data.to });
        const knownExts = new Set(
          agents
            .map((a) => String(a.ext ?? a.agent_code ?? "").trim())
            .filter(Boolean),
        );
        const counts = new Map<string, number>();
        for (const r of records) {
          const ext =
            r.call_type === "Outbound" ? r.call_from_number ?? null
            : r.call_type === "Inbound" ? r.call_to_number ?? null
            : r.call_from_number ?? r.call_to_number ?? null;
          if (!ext) continue;
          if (knownExts.has(String(ext).trim())) continue;
          counts.set(ext, (counts.get(ext) ?? 0) + 1);
        }
        topUnmatched = [...counts.entries()]
          .map(([ext, count]) => ({ ext, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 25);
      } catch (err) {
        cdrError = err instanceof Error ? err.message : String(err);
      }
    }

    return {
      ok: true as const,
      agentCount: agents.length,
      missingExt: missingExt.map((a) => ({ id: a.id, name: a.name, agent_code: a.agent_code })),
      topUnmatched,
      cdrError,
    };
  });

// ---- Analytics (dashboard) -------------------------------------------------

const statsInput = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  team: z.enum(["all", "customer_care", "telesales"]).default("all"),
  agentId: z.string().uuid().nullable().optional(),
});

const analyticsInput = statsInput.extend({
  jobId: z.string().min(1).max(80).optional(),
  direction: z.enum(["all", "Inbound", "Outbound"]).default("all"),
  status: z.enum(["all", "ANSWERED", "NO ANSWER", "BUSY", "FAILED", "VOICEMAIL"]).default("all"),
  includeOrders: z.boolean().default(true),
});

const CDR_CACHE_TTL_MS = 60_000;
const CDR_CACHE_MAX = 20;
const cdrCache = new Map<string, { at: number; promise: Promise<any> }>();

function evictCdrCache() {
  const now = Date.now();
  // TTL sweep
  for (const [k, v] of cdrCache) {
    if (now - v.at > CDR_CACHE_TTL_MS) cdrCache.delete(k);
  }
  // Size cap: drop oldest entries (Map preserves insertion order)
  while (cdrCache.size > CDR_CACHE_MAX) {
    const oldest = cdrCache.keys().next().value;
    if (oldest === undefined) break;
    cdrCache.delete(oldest);
  }
}

async function getCdrCached(from: string, to: string, jobId?: string) {
  evictCdrCache();
  const key = `${from}|${to}`;
  const now = Date.now();
  const hit = cdrCache.get(key);
  if (hit && now - hit.at < CDR_CACHE_TTL_MS) {
    if (jobId) {
      const p = await import("@/lib/yeastar/progress.server");
      hit.promise.then((cdr) => {
        p.updateJob(jobId, {
          status: "aggregating", page: 1, totalPages: 1,
          records: cdr.records.length, totalReported: cdr.totalReported,
          message: `Cached ${cdr.records.length.toLocaleString()} records — aggregating…`,
        }).catch(() => {});
      }).catch(() => {});
    }
    return hit.promise;
  }
  const { fetchCdrRange } = await import("@/lib/yeastar/cdr.server");
  const promise = fetchCdrRange({ from, to, jobId }).catch((e) => {
    cdrCache.delete(key);
    throw e;
  });
  cdrCache.set(key, { at: now, promise });
  if (cdrCache.size > CDR_CACHE_MAX) evictCdrCache();
  return promise;
}

async function loadAgents(_supabase: any) {
  // yeastar_ext and roles are read via the service-role client because
  // authenticated SELECT on profiles no longer exposes sensitive columns
  // ([H4]). This function is only reachable after a call-center permission
  // check upstream, so an admin read here is appropriate.
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const [{ data: profiles }, { data: extRows }, { data: roles }] = await Promise.all([
    supabaseAdmin.from("profiles").select("id,full_name,agent_code,active"),
    supabaseAdmin.from("profiles" as any).select("id,yeastar_ext"),
    supabaseAdmin.from("user_roles").select("user_id,role"),
  ]);

  const extMap = new Map<string, string | null>(((extRows as any[]) ?? []).map((r) => [r.id, r.yeastar_ext ?? null]));
  const roleMap = new Map<string, string>(((roles as any[]) ?? []).map((r) => [r.user_id, r.role as string]));
  return ((profiles as any[]) ?? [])
    .filter((p) => p.active)
    .map((p) => ({
      id: p.id as string,
      name: (p.full_name as string) ?? "Unknown",
      team: roleMap.get(p.id) as "customer_care" | "telesales" | undefined,
      ext: String(extMap.get(p.id) ?? p.agent_code ?? "").trim(),
    }))
    .filter((a) => a.team === "customer_care" || a.team === "telesales")
    .filter((a) => a.ext.length > 0) as Array<{ id: string; name: string; team: "customer_care" | "telesales"; ext: string }>;
}

// Note: legacy `getAgentCallStats` was removed (Prompt 1, item 1). Callers
// use `getCallCenterAnalytics` below which is the queue-aware, order-joined
// analytics engine.


/**
 * Full Call Center Analytics — queue-aware, order-joined.
 */
export const getCallCenterAnalytics = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => analyticsInput.parse(d))
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    const { isConfigured } = await import("@/lib/yeastar/client.server");
    if (!isConfigured()) return { ok: false as const, configured: false as const };

    const [{ data: canView }, { data: canAll }, { data: isAdmin }] = await Promise.all([
      supabase.rpc("has_permission", { _user_id: userId, _permission: "view_team_analytics" }),
      supabase.rpc("has_permission", { _user_id: userId, _permission: "view_all_agents" }),
      supabase.rpc("is_administrator", { _user_id: userId }),
    ]);
    if (!canView && !isAdmin) throw new Error("Forbidden: call analytics access required");
    const seesAll = !!canAll || !!isAdmin;

    const progress = data.jobId ? await import("@/lib/yeastar/progress.server") : null;
    if (progress && data.jobId) await progress.initJob(data.jobId);

    let agents = await loadAgents(supabase);

    if (data.team !== "all") agents = agents.filter((a) => a.team === data.team);
    if (!seesAll) agents = agents.filter((a) => a.id === userId);
    else if (data.agentId) agents = agents.filter((a) => a.id === data.agentId);

    try {
      const cdr = await getCdrCached(data.from, data.to, data.jobId);
      if (progress && data.jobId) await progress.updateJob(data.jobId, { status: "aggregating", message: "Computing analytics…", records: cdr.records.length });

      // [C2] Do NOT pre-filter raw rows by direction/status here — that would
      // strip ANSWERED legs and misclassify grouped queue calls. Filters are
      // applied inside aggregateAnalytics AFTER grouping + classification.
      const records = cdr.records as any[];

      // Load orders in the same window, for telesales conversion
      let orders: any[] = [];
      if (data.includeOrders) {
        const { data: ord } = await supabase
          .from("orders")
          .select("id,agent_id,order_date,status,order_type,invoice_value")
          .gte("order_date", data.from)
          .lte("order_date", data.to);
        orders = (ord as any[]) ?? [];
      }

      const { aggregateAnalytics } = await import("@/lib/yeastar/stats.server");
      const result = aggregateAnalytics(records, agents, orders, {
        direction: data.direction,
        status: data.status,
      });

      if (progress && data.jobId) await progress.finishJob(data.jobId, cdr.totalReported, cdr.records.length);

      return {
        ok: true as const, configured: true as const,
        window: { from: data.from, to: data.to, team: data.team, agentId: data.agentId ?? null, direction: data.direction, status: data.status },
        cdr: { path: cdr.path, totalReported: cdr.totalReported, fetched: cdr.records.length, filtered: result.totals.total, truncated: cdr.truncated, elapsedMs: cdr.elapsedMs },
        ...result,
      };

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (progress && data.jobId) await progress.failJob(data.jobId, msg);
      throw err;
    }
  });
