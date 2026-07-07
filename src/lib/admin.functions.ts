import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const RoleEnum = z.enum(["owner", "admin", "customer_care", "telesales", "call_center", "auditor"]);

async function assertAdmin(supabase: any, userId: string) {
  // Owner and admin have identical administrative privileges.
  const { data, error } = await supabase.rpc("is_administrator", { _user_id: userId });
  if (error) {
    console.error("[authz] is_administrator RPC error", { userId, error: error.message });
    throw new Error("Forbidden: authorization check failed");
  }
  if (!data) {
    const { data: roleRow } = await supabase
      .from("user_roles").select("role").eq("user_id", userId).maybeSingle();
    console.warn("[authz] non-administrator access attempt", { userId, role: roleRow?.role ?? null });
    throw new Error("Forbidden: administrator access required (owner or admin)");
  }
  console.log("[authz] administrator access granted", { userId });
}

export const adminCreateUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { email: string; password: string; fullName: string; agentCode?: string; role: "owner" | "admin" | "customer_care" | "telesales" | "call_center" | "auditor" }) =>
    z
      .object({
        email: z.string().email(),
        password: z.string().min(8),
        fullName: z.string().min(1).max(120),
        agentCode: z.string().max(40).optional(),
        role: RoleEnum,
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // [H3] Do NOT pass role via user_metadata — the handle_new_user trigger
    // ignores it and always writes the default (customer_care). Elevated
    // roles are granted server-side, after creation, via user_roles.
    const { data: created, error } = await supabaseAdmin.auth.admin.createUser({
      email: data.email,
      password: data.password,
      email_confirm: true,
      user_metadata: { full_name: data.fullName, agent_code: data.agentCode },
    });
    if (error) throw new Error(error.message);
    const newUserId = created.user?.id;
    if (newUserId && data.role !== "customer_care") {
      await supabaseAdmin.from("user_roles").delete().eq("user_id", newUserId);
      const { error: roleErr } = await supabaseAdmin
        .from("user_roles")
        .insert({ user_id: newUserId, role: data.role });
      if (roleErr) throw new Error(roleErr.message);
    }
    return { id: newUserId };
  });


export const adminSetActive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { userId: string; active: boolean }) =>
    z.object({ userId: z.string().uuid(), active: z.boolean() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("profiles")
      .update({ active: data.active })
      .eq("id", data.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const adminSetRole = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { userId: string; role: "owner" | "admin" | "customer_care" | "telesales" | "call_center" | "auditor" }) =>
    z.object({ userId: z.string().uuid(), role: RoleEnum }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("user_roles").delete().eq("user_id", data.userId);
    const { error } = await supabaseAdmin
      .from("user_roles")
      .insert({ user_id: data.userId, role: data.role });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const adminUpdateProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { userId: string; fullName: string; agentCode?: string; yeastarExt?: string | null; permissions?: string[] }) =>
    z
      .object({
        userId: z.string().uuid(),
        fullName: z.string().min(1).max(120),
        agentCode: z.string().max(40).optional().nullable(),
        yeastarExt: z.string().max(20).optional().nullable(),
        permissions: z.array(z.string()).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const patch: any = { full_name: data.fullName, agent_code: data.agentCode ?? null };
    if (data.permissions) patch.permissions = data.permissions;
    if (data.yeastarExt !== undefined) {
      const v = (data.yeastarExt ?? "").trim();
      patch.yeastar_ext = v.length > 0 ? v : null;
    }
    const { error } = await supabaseAdmin
      .from("profiles")
      .update(patch)
      .eq("id", data.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });


export const adminSetPassword = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { userId: string; password: string }) =>
    z.object({ userId: z.string().uuid(), password: z.string().min(8) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.auth.admin.updateUserById(data.userId, {
      password: data.password,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const adminDeleteUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { userId: string }) => z.object({ userId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    if (data.userId === context.userId) throw new Error("You cannot delete your own account");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.auth.admin.deleteUser(data.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const adminListUsers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: profiles, error } = await supabaseAdmin
      .from("profiles" as any)
      .select("id,full_name,agent_code,active,permissions,created_at,yeastar_ext")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    const { data: roles } = await supabaseAdmin.from("user_roles").select("user_id,role");
    const { data: list } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 });
    const emails = new Map(list.users.map((u: any) => [u.id, u.email]));
    const roleMap = new Map((roles ?? []).map((r: any) => [r.user_id, r.role]));
    return (profiles ?? []).map((p: any) => ({
      ...p,
      email: emails.get(p.id) ?? "",
      role: roleMap.get(p.id) ?? null,
    }));
  });
