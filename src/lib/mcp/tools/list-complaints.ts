import { defineTool } from "@lovable.dev/mcp-js";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

export default defineTool({
  name: "list_complaints",
  title: "List complaints",
  description:
    "List complaints visible to the signed-in user, filtered by optional date range, status, category, or free-text search.",
  inputSchema: {
    from: z.string().optional().describe("Start date (YYYY-MM-DD) for complaint_date."),
    to: z.string().optional().describe("End date (YYYY-MM-DD) for complaint_date."),
    status: z.string().optional().describe("Filter by status (e.g. open, resolved)."),
    category: z.string().optional().describe("Filter by category."),
    search: z.string().optional().describe("Match customer name, phone, description, or display_no."),
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
      .from("complaints")
      .select(
        "id, display_no, complaint_date, customer_name, customer_phone, branch_no, category, description, resolution, status, created_at",
      )
      .order("complaint_date", { ascending: false })
      .limit(input.limit ?? 50);
    if (input.from) q = q.gte("complaint_date", input.from);
    if (input.to) q = q.lte("complaint_date", input.to);
    if (input.status) q = q.eq("status", input.status);
    if (input.category) q = q.eq("category", input.category);
    if (input.search) {
      const s = `%${input.search}%`;
      q = q.or(
        `customer_name.ilike.${s},customer_phone.ilike.${s},description.ilike.${s},display_no.ilike.${s}`,
      );
    }
    const { data, error } = await q;
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      structuredContent: { count: data?.length ?? 0, rows: data ?? [] },
    };
  },
});
