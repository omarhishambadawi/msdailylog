import { defineTool } from "@lovable.dev/mcp-js";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { buildSearchOr, normalizeSearchTerm } from "../search";

export default defineTool({
  name: "list_orders",
  title: "List orders",
  description:
    "List orders visible to the signed-in user, filtered by optional date range, team, status, or free-text search. Respects row-level security.",
  inputSchema: {
    from: z.string().optional().describe("Start date (YYYY-MM-DD) for order_date."),
    to: z.string().optional().describe("End date (YYYY-MM-DD) for order_date."),
    team: z.enum(["customer_care", "telesales"]).optional().describe("Filter by team."),
    status: z
      .string()
      .optional()
      .describe("Filter by status (e.g. pending, confirmed, cancelled)."),
    search: z
      .string()
      .optional()
      .describe("Match customer name, phone, invoice_no, or display_no."),
    limit: z.number().int().min(1).max(200).optional().describe("Max rows (default 50)."),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: async (input, ctx) => {
    if (!ctx.isAuthenticated()) {
      return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    }
    const supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_PUBLISHABLE_KEY!,
      {
        global: { headers: { Authorization: `Bearer ${ctx.getToken()}` } },
        auth: { persistSession: false, autoRefreshToken: false },
      },
    );
    let q = supabase
      .from("orders")
      .select(
        "id, display_no, order_date, team, order_type, branch_no, delivery_type, invoice_no, invoice_value, status, customer_name, customer_phone, call_center_verified, created_at",
      )
      .order("order_date", { ascending: false })
      .limit(input.limit ?? 50);
    if (input.from) q = q.gte("order_date", input.from);
    if (input.to) q = q.lte("order_date", input.to);
    if (input.team) q = q.eq("team", input.team);
    if (input.status) q = q.eq("status", input.status);
    if (input.search) {
      const term = normalizeSearchTerm(input.search);
      if (term) {
        q = q.or(
          buildSearchOr(term, ["customer_name", "customer_phone", "invoice_no", "display_no"]),
        );
      }
    }
    const { data, error } = await q;
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      structuredContent: { count: data?.length ?? 0, rows: data ?? [] },
    };
  },
});
