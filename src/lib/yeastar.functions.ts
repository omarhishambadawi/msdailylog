import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const inputSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  team: z.enum(["customer_care", "telesales", "all"]).default("all"),
  agentId: z.string().uuid().optional(),
});

/**
 * Cached "allowed agents" set — built from the Users table (active users
 * whose role is customer_care or telesales) and refreshed every 10 minutes.
 * Keeping this cache in-module avoids a DB round-trip on every dashboard
 * render.
 */
interface CachedAgent {
  id: string;
  fullName: string;
  extension: string; // normalized agent_code
  team: "customer_care" | "telesales";
}
interface AllowedAgentsCache {
  builtAt: number;
  agents: CachedAgent[];
  extensions: Set<string>;
  byExtension: Map<string, CachedAgent>;
  byId: Map<string, CachedAgent>;
}
const ALLOWED_TTL_MS = 10 * 60_000;
let allowedCache: AllowedAgentsCache | null = null;

async function getAllowedAgents(
  supabase: any,
  normalizeExt: (v: unknown) => string,
): Promise<AllowedAgentsCache> {
  if (allowedCache && Date.now() - allowedCache.builtAt < ALLOWED_TTL_MS) {
    return allowedCache;
  }
  const t0 = Date.now();
  // profiles + user_roles join, filtered to active customer_care / telesales
  // users with a non-null agent_code.
  const { data: rows, error } = await supabase
    .from("profiles")
    .select("id, full_name, agent_code, active, user_roles!inner(role)")
    .eq("active", true)
    .not("agent_code", "is", null)
    .in("user_roles.role", ["customer_care", "telesales"]);
  if (error) throw new Error(`Failed to load active agents: ${error.message}`);
  const agents: CachedAgent[] = [];
  for (const r of rows ?? []) {
    const ext = normalizeExt(r.agent_code);
    if (!ext) continue;
    const role = Array.isArray(r.user_roles) ? r.user_roles[0]?.role : r.user_roles?.role;
    if (role !== "customer_care" && role !== "telesales") continue;
    agents.push({ id: r.id, fullName: r.full_name ?? `Ext ${ext}`, extension: ext, team: role });
  }
  const extensions = new Set(agents.map((a) => a.extension));
  const byExtension = new Map(agents.map((a) => [a.extension, a]));
  const byId = new Map(agents.map((a) => [a.id, a]));
  allowedCache = { builtAt: Date.now(), agents, extensions, byExtension, byId };
  console.log(`[Yeastar] allowedExtensions rebuilt in ${Date.now() - t0}ms → [${[...extensions].join(", ")}]`);
  return allowedCache;
}

/**
 * Aggregated Yeastar call statistics.
 *
 * Pipeline (measured end-to-end):
 *   1. Auth   – cached PBX access token (reused until expiry)
 *   2. Users  – active platform users → allowedExtensions Set (10-min cache)
 *   3. CDR    – requested only for the selected date range; every record
 *               whose extension is not in the Set is discarded inline
 *   4. KPI    – computed only from the filtered records
 */
export const getYeastarCallStats = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => inputSchema.parse(input))
  .handler(async ({ data, context }) => {
    const t0 = Date.now();
    const { fetchCdr, isYeastarConfigured, diagnoseYeastar, normalizeExt } =
      await import("@/lib/yeastar.server");
    const emptyStats = {
      total: 0, answered: 0, missed: 0, inbound: 0, outbound: 0,
      byTeam: { customerCare: 0, telesales: 0 },
      byAgent: [] as Array<{
        extension: string; agentName: string;
        total: number; missed: number; answered: number; inbound: number; outbound: number;
      }>,
    };
    if (!isYeastarConfigured()) return { configured: false as const, ...emptyStats };

    const diag = await diagnoseYeastar();
    if (!diag.ok) {
      console.error("[Yeastar] diagnostic failed:", diag.category, diag.message);
      return { configured: true as const, diagnostic: diag, ...emptyStats };
    }

    // Step 2 — build allowedExtensions Set from active platform users.
    const tUsers = Date.now();
    const allowed = await getAllowedAgents(context.supabase, normalizeExt);
    const usersMs = Date.now() - tUsers;

    // Restrict to the requested team, if any.
    const teamsInScope: Array<"customer_care" | "telesales"> =
      data.team === "all" ? ["customer_care", "telesales"] : [data.team];
    const teamSet = new Set(teamsInScope);
    const scopedAgents = allowed.agents.filter((a) => teamSet.has(a.team));
    let scopedExtensions = new Set(scopedAgents.map((a) => a.extension));

    // Optional single-agent filter.
    let singleAgentExt: string | undefined;
    if (data.agentId) {
      const a = allowed.byId.get(data.agentId);
      if (a && scopedExtensions.has(a.extension)) {
        singleAgentExt = a.extension;
        scopedExtensions = new Set([a.extension]);
      }
    }

    if (scopedExtensions.size === 0) {
      console.warn(`[Yeastar] no active agents in scope for team=${data.team} agentId=${data.agentId ?? "all"} — returning empty stats`);
      return { configured: true as const, diagnostic: diag, ...emptyStats, cdrDiagnostic: undefined, agentDirectory: [] };
    }

    try {
      console.log(`[Yeastar] pipeline start → from=${data.from} to=${data.to} team=${data.team} agentId=${data.agentId ?? "all"} allowedExt=[${[...scopedExtensions].join(", ")}]`);

      // Step 3 — fetch CDR with inline filtering (records outside the Set
      // are dropped before they ever land in memory).
      const { records, diagnostic: cdrDiag, timings } =
        await fetchCdr(data.from, data.to, scopedExtensions);

      // Step 4 — compute KPIs only from the filtered records.
      const tKpi = Date.now();
      let total = 0, answered = 0, missed = 0, inbound = 0, outbound = 0;
      let cc = 0, ts = 0;
      const ANSWERED = new Set(["ANSWERED", "Answered", "answered"]);
      const byAgent = new Map<string, { extension: string; agentName: string; total: number; answered: number; missed: number; inbound: number; outbound: number }>();
      for (const r of records) {
        const ext = normalizeExt(r.extension ?? r.extension_number ?? r.src_number ?? r.dst_number ?? "");
        const agent = allowed.byExtension.get(ext);
        if (!agent) continue; // defence-in-depth (fetchCdr already filtered)
        if (singleAgentExt && ext !== singleAgentExt) continue;
        total += 1;
        const isAnswered = r.status ? ANSWERED.has(r.status) : (r.talk_duration ?? 0) > 0;
        if (isAnswered) answered += 1; else missed += 1;
        const isOutbound = (r.call_type ?? "").toLowerCase().includes("outbound");
        if (isOutbound) outbound += 1; else inbound += 1;
        if (agent.team === "customer_care") cc += 1; else ts += 1;
        const row = byAgent.get(ext) ?? {
          extension: ext, agentName: agent.fullName,
          total: 0, answered: 0, missed: 0, inbound: 0, outbound: 0,
        };
        row.total += 1;
        if (isAnswered) row.answered += 1; else row.missed += 1;
        if (isOutbound) row.outbound += 1; else row.inbound += 1;
        byAgent.set(ext, row);
      }
      const kpiMs = Date.now() - tKpi;
      const totalMs = Date.now() - t0;
      console.log(
        `[Yeastar] timings ms — total=${totalMs} auth=${timings.authMs} users=${usersMs} cdr=${timings.requestMs} filter=${timings.filterMs} kpi=${kpiMs} · fetched=${timings.totalFetched} kept=${timings.keptAfterFilter} mappedAgents=${scopedAgents.length}`,
      );

      return {
        configured: true as const,
        total, answered, missed, inbound, outbound,
        byTeam: { customerCare: cc, telesales: ts },
        byAgent: Array.from(byAgent.values()).sort((a, b) => b.total - a.total),
        diagnostic: diag,
        cdrDiagnostic: cdrDiag,
        agentDirectory: scopedAgents.map((a) => ({ extension: a.extension, fullName: a.fullName, team: a.team })),
        timings: { totalMs, authMs: timings.authMs, usersMs, cdrMs: timings.requestMs, filterMs: timings.filterMs, kpiMs, fetched: timings.totalFetched, kept: timings.keptAfterFilter },
      };
    } catch (err) {
      const anyErr = err as any;
      const cdrDiag = anyErr?.diagnostic as Awaited<ReturnType<typeof diagnoseYeastar>> | undefined;
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[Yeastar] CDR fetch failed:", msg);
      return {
        configured: true as const,
        diagnostic: cdrDiag ?? { ...diag, ok: false, category: "http_error" as const, message: `CDR request failed: ${msg}` },
        ...emptyStats,
      };
    }
  });

/**
 * Validator: shows every active platform agent (customer_care / telesales)
 * that will be used for analytics, based on the same 10-min-cached set.
 */
export const getYeastarExtensionMapping = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { isYeastarConfigured, diagnoseYeastar, normalizeExt } =
      await import("@/lib/yeastar.server");
    if (!isYeastarConfigured()) return { configured: false as const };
    const diag = await diagnoseYeastar();
    if (!diag.ok) return { configured: true as const, diagnostic: diag };

    const allowed = await getAllowedAgents(context.supabase, normalizeExt);
    const whitelistRows = allowed.agents.map((a) => ({
      pbxNumber: a.extension,
      pbxName: a.fullName,
      role: a.team,
      expectedAgentCode: a.extension,
      matchedAgentName: a.fullName,
      matchedAgentId: a.id,
      matches: true,
    }));

    return {
      configured: true as const,
      whitelist: allowed.agents.map((a) => ({
        extension: a.extension, fullName: a.fullName, role: a.team, agentCode: a.extension,
      })),
      counts: {
        whitelist: allowed.agents.length,
        customerCare: allowed.agents.filter((a) => a.team === "customer_care").length,
        telesales: allowed.agents.filter((a) => a.team === "telesales").length,
        admin: 0,
        platformAgents: allowed.agents.length,
        matched: allowed.agents.length,
        unmatched: 0,
      },
      whitelistRows,
    };
  });
