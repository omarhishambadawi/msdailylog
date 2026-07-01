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
      const records = await fetchCdr(data.from, data.to);
      return {
        ...aggregateCdr(records, directory, {
          team: data.team === "all" ? undefined : data.team,
          extension: extensionFilter,
        }),
        diagnostic: diag,
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

