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
 * Returns aggregated Yeastar call statistics for the requested window,
 * optionally filtered by team and/or agent. Follows the dashboard's own
 * filters — no separate UI is required.
 *
 * When `YEASTAR_BASE_URL` is not configured, returns `{ configured: false }`
 * so the UI can render a friendly "not connected" state instead of erroring.
 */
export const getYeastarCallStats = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => inputSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { fetchCdr, aggregateCdr, isYeastarConfigured, diagnoseYeastar } = await import("@/lib/yeastar.server");
    const emptyStats = {
      total: 0, answered: 0, missed: 0, inbound: 0, outbound: 0,
      byTeam: { customerCare: 0, telesales: 0 },
      byAgent: [] as Array<{
        extension: string; agentName: string;
        total: number; answered: number; missed: number; inbound: number; outbound: number;
      }>,
    };
    if (!isYeastarConfigured()) {
      return { configured: false as const, ...emptyStats };
    }

    // Step 1: run connection diagnostic. Do NOT continue until we have a token.
    const diag = await diagnoseYeastar();
    if (!diag.ok) {
      console.error("[Yeastar] diagnostic failed:", diag.category, diag.message);
      return { configured: true as const, diagnostic: diag, ...emptyStats };
    }

    // Build agent directory from profiles + user_roles.
    const { supabase } = context;
    const [{ data: profiles }, { data: roles }] = await Promise.all([
      supabase.from("profiles").select("id,full_name,agent_code"),
      supabase.from("user_roles").select("user_id,role"),
    ]);
    const roleMap = new Map((roles ?? []).map((r: any) => [r.user_id, r.role]));
    const directory = (profiles ?? [])
      .filter((p: any) => !!p.agent_code)
      .map((p: any) => {
        const r = roleMap.get(p.id);
        const team = r === "customer_care" || r === "telesales" ? r : null;
        return { extension: String(p.agent_code), fullName: p.full_name ?? "", team };
      });

    let extensionFilter: string | undefined;
    if (data.agentId) {
      const match = (profiles ?? []).find((p: any) => p.id === data.agentId);
      if (match?.agent_code) extensionFilter = String(match.agent_code);
    }

    try {
      console.log(`[Yeastar] dashboard filter → from=${data.from} to=${data.to} team=${data.team} agentId=${data.agentId ?? "all"} extensionFilter=${extensionFilter ?? "none"}`);
      const { records, diagnostic: cdrDiag } = await fetchCdr(data.from, data.to);
      const agg = aggregateCdr(records, directory, {
        team: data.team === "all" ? undefined : data.team,
        extension: extensionFilter,
      });
      console.log(`[Yeastar] window=${data.from}..${data.to} url=${cdrDiag.requestUrl} pbxReturned=${records.length} usedAfterFilter=${agg.total} mappedAgents=${directory.length}`);
      return { ...agg, diagnostic: diag, cdrDiagnostic: cdrDiag, agentDirectory: directory };

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
 * Validator: lists every PBX extension and every platform agent, and shows
 * which ones map to each other via `profiles.agent_code`.
 */
export const getYeastarExtensionMapping = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { isYeastarConfigured, diagnoseYeastar, fetchAllExtensions } = await import("@/lib/yeastar.server");
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
      agentCode: p.agent_code ? String(p.agent_code) : null,
      role: roleMap.get(p.id) ?? null,
    }));

    let pbxExtensions: Array<{ number: string; name?: string; status?: string }> = [];
    let fetchError: string | null = null;
    try {
      pbxExtensions = await fetchAllExtensions();
    } catch (err) {
      fetchError = err instanceof Error ? err.message : String(err);
    }

    const pbxByNumber = new Map(pbxExtensions.map((e) => [e.number, e]));
    const agentsByCode = new Map(agents.filter((a) => a.agentCode).map((a) => [a.agentCode!, a]));

    const matched = agents
      .filter((a) => a.agentCode && pbxByNumber.has(a.agentCode))
      .map((a) => ({
        agentId: a.id, agentName: a.fullName, agentCode: a.agentCode!, role: a.role,
        pbxName: pbxByNumber.get(a.agentCode!)?.name ?? null,
        pbxStatus: pbxByNumber.get(a.agentCode!)?.status ?? null,
      }));

    const unmatchedAgents = agents
      .filter((a) => !a.agentCode || !pbxByNumber.has(a.agentCode))
      .map((a) => ({
        agentId: a.id, agentName: a.fullName, agentCode: a.agentCode, role: a.role,
        reason: !a.agentCode ? "no agent_code" : "no matching PBX extension",
      }));

    const unmatchedExtensions = pbxExtensions
      .filter((e) => !agentsByCode.has(e.number))
      .map((e) => ({ number: e.number, name: e.name ?? null, status: e.status ?? null }));

    return {
      configured: true as const,
      fetchError,
      counts: {
        pbxExtensions: pbxExtensions.length,
        agents: agents.length,
        matched: matched.length,
        unmatchedAgents: unmatchedAgents.length,
        unmatchedExtensions: unmatchedExtensions.length,
      },
      matched, unmatchedAgents, unmatchedExtensions,
    };
  });


