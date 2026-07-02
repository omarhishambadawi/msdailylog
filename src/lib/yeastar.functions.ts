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
 * Aggregated Yeastar call statistics, scoped to the two operational
 * Extension Groups ("Customer_Care_Emp." and "Telesales_Emp."). Any PBX
 * extension not in one of those groups (Default_All_Extensions, personal
 * extensions, DIDs, external numbers) is excluded from every metric.
 */
export const getYeastarCallStats = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => inputSchema.parse(input))
  .handler(async ({ data, context }) => {
    const {
      fetchCdr, aggregateCdr, isYeastarConfigured, diagnoseYeastar,
      fetchTeamExtensions, normalizeExt, EXTENSION_GROUP_NAMES,
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

    // Load Extension Groups first — analytics are gated on them existing.
    let teamExt;
    try {
      teamExt = await fetchTeamExtensions();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[Yeastar] extension_group/list failed:", msg);
      return {
        configured: true as const,
        diagnostic: { ...diag, ok: false, category: "http_error" as const, message: `Failed to load Extension Groups: ${msg}` },
        ...emptyStats,
      };
    }
    if (teamExt.missingGroups.length > 0) {
      return {
        configured: true as const,
        groupConfigError: {
          missing: teamExt.missingGroups,
          expected: [EXTENSION_GROUP_NAMES.customer_care, EXTENSION_GROUP_NAMES.telesales],
          available: teamExt.availableGroups.map((g) => g.name),
        },
        ...emptyStats,
      };
    }

    // Team scoping: allowed extensions + team map derived from groups.
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

    // Directory: platform agents whose agent_code is in the allowed set.
    const { supabase } = context;
    const [{ data: profiles }, { data: roles }] = await Promise.all([
      supabase.from("profiles").select("id,full_name,agent_code"),
      supabase.from("user_roles").select("user_id,role"),
    ]);
    const roleMap = new Map((roles ?? []).map((r: any) => [r.user_id, r.role]));
    const allowedSet = new Set(allowedExtensions.map((e) => normalizeExt(e)));
    const directory = (profiles ?? [])
      .filter((p: any) => !!p.agent_code)
      .map((p: any) => {
        const code = normalizeExt(p.agent_code);
        const team = extensionTeamMap[code] ?? (roleMap.get(p.id) === "customer_care" || roleMap.get(p.id) === "telesales" ? (roleMap.get(p.id) as "customer_care" | "telesales") : null);
        return { extension: code, fullName: p.full_name ?? "", team };
      })
      .filter((a) => allowedSet.has(a.extension));

    let extensionFilter: string | undefined;
    if (data.agentId) {
      const match = (profiles ?? []).find((p: any) => p.id === data.agentId);
      if (match?.agent_code) extensionFilter = normalizeExt(match.agent_code);
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
 * Validator: lists every platform agent and every PBX extension in the two
 * operational Extension Groups, and shows how each maps to the other.
 * Comparison is performed on the normalized value of `profiles.agent_code`
 * vs the extension number from the group (trim + strip zero-width chars +
 * strip surrounding quotes + lowercase).
 */
export const getYeastarExtensionMapping = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const {
      isYeastarConfigured, diagnoseYeastar, fetchTeamExtensions,
      normalizeExt, EXTENSION_GROUP_NAMES,
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

    let teamExt: Awaited<ReturnType<typeof fetchTeamExtensions>> | null = null;
    let fetchError: string | null = null;
    try {
      teamExt = await fetchTeamExtensions();
    } catch (err) {
      fetchError = err instanceof Error ? err.message : String(err);
    }
    const missingGroups = teamExt?.missingGroups ?? [];
    const pbxExtensions: Array<GroupExt> = teamExt
      ? teamExt.all.map((e) => ({ number: e.number, name: e.name, status: e.status, team: e.team }))
      : [];

    const pbxByNumber = new Map(pbxExtensions.map((e) => [e.number, e]));

    // Log per-agent comparison for debugging (requirement 5).
    for (const a of agents) {
      const hit = a.agentCode ? pbxByNumber.get(a.agentCode) : undefined;
      console.log(`[Yeastar mapping] agent="${a.fullName}" raw="${a.agentCodeRaw ?? ""}" normalized="${a.agentCode ?? ""}" → ${hit ? `MATCH ext=${hit.number} team=${hit.team}` : "NO MATCH"}`);
    }
    console.log(`[Yeastar mapping] group extensions: [${pbxExtensions.map((e) => `${e.number}(${e.team})`).join(", ")}]`);

    const matched = agents
      .filter((a) => a.agentCode && pbxByNumber.has(a.agentCode))
      .map((a) => {
        const ext = pbxByNumber.get(a.agentCode!)!;
        return {
          agentId: a.id, agentName: a.fullName, agentCode: a.agentCode!, role: a.role,
          pbxName: ext.name ?? null, pbxStatus: ext.status ?? null, team: ext.team,
        };
      });

    const unmatchedAgents = agents
      .filter((a) => !a.agentCode || !pbxByNumber.has(a.agentCode))
      .map((a) => ({
        agentId: a.id, agentName: a.fullName, agentCode: a.agentCode, role: a.role,
        reason: !a.agentCode
          ? "no agent_code"
          : `agent_code "${a.agentCodeRaw}" not in Extension Groups (${EXTENSION_GROUP_NAMES.customer_care} / ${EXTENSION_GROUP_NAMES.telesales})`,
      }));

    const agentsByCode = new Map(agents.filter((a) => a.agentCode).map((a) => [a.agentCode!, a]));
    const unmatchedExtensions = pbxExtensions
      .filter((e) => !agentsByCode.has(e.number))
      .map((e) => ({ number: e.number, name: e.name ?? null, status: e.status ?? null, team: e.team }));

    // First-20 diagnostic view: extension + matched agent + normalized keys.
    const first20 = pbxExtensions.slice(0, 20).map((e) => {
      const a = agentsByCode.get(e.number);
      return {
        pbxNumber: e.number, pbxName: e.name ?? null, team: e.team,
        matchedAgent: a?.fullName ?? null, agentCodeRaw: a?.agentCodeRaw ?? null,
        agentCodeNormalized: a?.agentCode ?? null,
        matches: !!a,
      };
    });

    return {
      configured: true as const,
      fetchError,
      groupConfig: {
        expected: [EXTENSION_GROUP_NAMES.customer_care, EXTENSION_GROUP_NAMES.telesales],
        missing: missingGroups,
        available: teamExt?.availableGroups.map((g) => g.name) ?? [],
      },
      counts: {
        pbxExtensions: pbxExtensions.length,
        agents: agents.length,
        matched: matched.length,
        unmatchedAgents: unmatchedAgents.length,
        unmatchedExtensions: unmatchedExtensions.length,
        customerCareGroup: teamExt?.groups.customer_care.extensions.length ?? 0,
        telesalesGroup: teamExt?.groups.telesales.extensions.length ?? 0,
      },
      matched, unmatchedAgents, unmatchedExtensions,
      first20Extensions: first20,
    };
  });

type GroupExt = { number: string; name?: string; status?: string; team: "customer_care" | "telesales" };
