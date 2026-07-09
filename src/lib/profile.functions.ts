import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Update the authenticated user's own profile.
 * Only full_name and avatar_url are writable by the user.
 * The prevent_profile_escalation trigger blocks any attempt to change
 * agent_code/active/permissions/id from a non-admin session.
 */
export const updateMyProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { fullName?: string; avatarUrl?: string | null }) =>
    z
      .object({
        fullName: z.string().min(1).max(120).optional(),
        avatarUrl: z.string().url().nullable().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const patch: Record<string, unknown> = {};
    if (data.fullName !== undefined) patch.full_name = data.fullName;
    if (data.avatarUrl !== undefined) patch.avatar_url = data.avatarUrl;
    if (Object.keys(patch).length === 0) return { ok: true };
    const { error } = await context.supabase
      .from("profiles")
      .update(patch)
      .eq("id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
