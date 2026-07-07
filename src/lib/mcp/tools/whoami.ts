import { defineTool } from "@lovable.dev/mcp-js";
import { createClient } from "@supabase/supabase-js";

export default defineTool({
  name: "whoami",
  title: "Who am I",
  description: "Return the signed-in user's profile (name, agent code, role, permissions).",
  inputSchema: {},
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async (_input, ctx) => {
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
    const userId = ctx.getUserId();
    const [{ data: profile }, { data: roleRow }] = await Promise.all([
      supabase.rpc("get_my_profile" as any),
      supabase.from("user_roles").select("role").eq("user_id", userId!).maybeSingle(),
    ]);

    const result = {
      user_id: userId,
      email: ctx.getUserEmail(),
      role: roleRow?.role ?? null,
      profile: (Array.isArray(profile) ? profile[0] : profile) ?? null,
    };

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  },
});
