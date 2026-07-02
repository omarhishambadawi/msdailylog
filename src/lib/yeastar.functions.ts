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
 * Aggregated Yeastar call statistics, scoped to a fixed Extension Whitelist
 * (see EXTENSION_WHITELIST in yeastar.server.ts). Any PBX extension not on
 * the whitelist is excluded from every metric.
 */
export const getYeastarCallStats = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => inputSchema.parse(input))
  .handler(async ({ data, context }) => {
    const {
      fetchCdr, aggregateCdr, isYeastarConfigured, diagnoseYeastar,
      getTeamExtensions, normalizeExt, EXTENSION_WHITELIST,
    } = await import("@/lib/yeastar.server");
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

    const teamExt = getTeamExtensions();

    // Team scoping from whitelist (admin extension 4000 is never included).
    const teamsInScope: Array<"customer_care" | "telesales"> =
      data.team === "all" ? ["customer_care", "telesales"] : [data.team];
    const allowedExtensions: string[] = [];
    const extensionTeamMap: Record<string, "customer_care" | "telesales"> = {};
    for (const t of teamsInScope) {
      for (const e of teamExt.groups[t].extensions) {
        allowedExtensions.push(e.number);
        extensionTeamMap[e.number] = t;
      }
    }

    // Directory built ONLY from the whitelist. Match platform profiles by
    // agent_code so real full names come through when available.
    const { supabase } = context;
    const { data: profiles } = await supabase
      .from("profiles")
      .select("id,full_name,agent_code");
    const profileByCode = new Map(
      (profiles ?? [])
        .filter((p: any) => !!p.agent_code)
        .map((p: any) => [normalizeExt(p.agent_code), p]),
    );

    const allowedSet = new Set(allowedExtensions);
    const directory = EXTENSION_WHITELIST
      .filter((w) => w.role === "customer_care" || w.role === "telesales")
      .filter((w) => allowedSet.has(normalizeExt(w.extension)))
      .map((w) => {
        const ext = normalizeExt(w.extension);
        const p = profileByCode.get(ext);
        return {
          extension: ext,
          fullName: (p?.full_name as string | undefined) || w.fullName,
          team: w.role as "customer_care" | "telesales",
        };
      });

    let extensionFilter: string | undefined;
    if (data.agentId) {
      const match = (profiles ?? []).find((p: any) => p.id === data.agentId);
      if (match?.agent_code) {
        const code = normalizeExt(match.agent_code);
        if (allowedSet.has(code)) extensionFilter = code;
      }
    }

    try {
      console.log(`[Yeastar] filter → from=${data.from} to=${data.to} team=${data.team} agentId=${data.agentId ?? "all"} extensionFilter=${extensionFilter ?? "none"} allowedExtensions=[${allowedExtensions.join(", ")}]`);
      const { records, diagnostic: cdrDiag } = await fetchCdr(data.from, data.to);
      const agg = aggregateCdr(records, directory, {
        team: data.team === "all" ? undefined : data.team,
        extension: extensionFilter,
        allowedExtensions,
        extensionTeamMap,
      });
      console.log(`[Yeastar] window=${data.from}..${data.to} pbxReturned=${records.length} usedAfterFilter=${agg.total} mappedAgents=${directory.length} allowedExt=${allowedExtensions.length}`);
      return {
        ...agg,
        diagnostic: diag,
        cdrDiagnostic: cdrDiag,
        agentDirectory: directory,
        groups: teamExt.groups,
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
 * Validator: shows the fixed Extension Whitelist and how each whitelisted
 * extension maps back to a platform profile's `agent_code`.
 */
export const getYeastarExtensionMapping = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const {
      isYeastarConfigured, diagnoseYeastar, getTeamExtensions,
      normalizeExt, EXTENSION_WHITELIST,
    } = await import("@/lib/yeastar.server");
    if (!isYeastarConfigured()) return { configured: false as const };
    const diag = await diagnoseYeastar();
    if (!diag.ok) return { configured: true as const, diagnostic: diag };

    const { supabase } = context;
    const [{ data: profiles }, { data: roles }] = await Promise.all([
      supabase.from("profiles").select("id,full_name,agent_code"),
      supabase.from("user_roles").select("user_id,role"),
    ]);
    const roleMap = new Map((roles ?? []).map((r: any) => [r.user_id, r.role]));
    const agents = (profiles ?? []).map((p: any) => ({
      id: p.id,
      fullName: p.full_name ?? "",
      agentCodeRaw: p.agent_code == null ? null : String(p.agent_code),
      agentCode: p.agent_code ? normalizeExt(p.agent_code) : null,
      role: roleMap.get(p.id) ?? null,
    }));
    const agentsByCode = new Map(
      agents.filter((a) => a.agentCode).map((a) => [a.agentCode!, a]),
    );

    const teamExt = getTeamExtensions();
    const pbxExtensions = teamExt.all;

    // Log per-agent comparison for debugging.
    for (const a of agents) {
      const hit = a.agentCode ? pbxExtensions.find((e) => e.number === a.agentCode) : undefined;
      console.log(`[Yeastar mapping] agent="${a.fullName}" raw="${a.agentCodeRaw ?? ""}" normalized="${a.agentCode ?? ""}" → ${hit ? `MATCH ext=${hit.number} team=${hit.team}` : "NO MATCH"}`);
    }

    // Rows: one row per whitelisted extension, showing the matched agent.
    const whitelistRows = EXTENSION_WHITELIST.map((w) => {
      const ext = normalizeExt(w.extension);
      const codeToMatch = normalizeExt(w.agentCode);
      const matched = agentsByCode.get(codeToMatch) ?? null;
      return {
        pbxNumber: ext,
        pbxName: w.fullName,
        role: w.role,
        expectedAgentCode: w.agentCode,
        matchedAgentName: matched?.fullName ?? null,
        matchedAgentId: matched?.id ?? null,
        matches: !!matched,
      };
    });

    const matched = whitelistRows.filter((r) => r.matches);
    const unmatched = whitelistRows.filter((r) => !r.matches);

    return {
      configured: true as const,
      whitelist: EXTENSION_WHITELIST,
      counts: {
        whitelist: EXTENSION_WHITELIST.length,
        customerCare: EXTENSION_WHITELIST.filter((w) => w.role === "customer_care").length,
        telesales: EXTENSION_WHITELIST.filter((w) => w.role === "telesales").length,
        admin: EXTENSION_WHITELIST.filter((w) => w.role === "admin").length,
        platformAgents: agents.length,
        matched: matched.length,
        unmatched: unmatched.length,
      },
      whitelistRows,
    };
  });
