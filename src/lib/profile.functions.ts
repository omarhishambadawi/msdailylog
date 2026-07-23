import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Update the authenticated user's own profile.
 * Only full_name and avatar_url are writable by the user.
 * The prevent_profile_escalation trigger blocks any attempt to change
 * agent_code/active/permissions/id from a non-admin session.
 *
 * `avatar_url` stores only the storage object path (not a URL); short-lived
 * signed URLs are minted on demand at display time.
 */
export const updateMyProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { fullName?: string; avatarPath?: string | null }) =>
    z
      .object({
        fullName: z.string().min(1).max(120).optional(),
        avatarPath: z.string().min(1).max(255).nullable().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const patch: { full_name?: string; avatar_url?: string | null } = {};
    if (data.fullName !== undefined) patch.full_name = data.fullName;
    if (data.avatarPath !== undefined) {
      // A user may only point their avatar at an object in their own folder.
      if (data.avatarPath !== null && data.avatarPath.split("/")[0] !== context.userId) {
        throw new Error("Invalid avatar path");
      }
      patch.avatar_url = data.avatarPath;
    }
    if (Object.keys(patch).length === 0) return { ok: true };
    const { error } = await context.supabase
      .from("profiles")
      .update(patch)
      .eq("id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
