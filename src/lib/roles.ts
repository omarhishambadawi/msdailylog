/**
 * Single source of truth for the `app_role` enum in the application layer.
 *
 * The database already owns the authoritative definition (the `public.app_role`
 * type plus the per-role rules inside `has_permission()`). What this file fixes
 * is the *application* side, which previously restated the role list in five
 * unconnected places — a Zod enum, a TypeScript union, a label map, a tone map,
 * and two hand-written `<SelectItem>` lists. When `supervisor` was added to the
 * database (20260721001000 / 20260721001100) the union and the permission table
 * were updated but the other five sites were not, so the role existed, carried a
 * full permission set, and could never be assigned to anyone.
 *
 * Everything role-shaped in the app layer now derives from `APP_ROLES`. Adding a
 * role means adding one entry here plus its label and tone; TypeScript then fails
 * on anything left incomplete, because both maps are exhaustive `Record<AppRole, …>`.
 *
 * This file intentionally holds NO permission logic. Which permissions a role may
 * hold lives in `src/lib/permissions.ts` (mirroring `has_permission()` in SQL).
 */

/**
 * Every role in `public.app_role`, ordered by descending privilege.
 *
 * Order drives the role-filter dropdown in user management. It does NOT imply
 * any hierarchy in code — authorization is per-permission, never by index.
 */
export const APP_ROLES = [
  "owner",
  "admin",
  "customer_care",
  "telesales",
  "call_center",
  "auditor",
] as const;

export type AppRole = (typeof APP_ROLES)[number];

/**
 * Roles an administrator may pick in the create/edit user dialogs.
 *
 * `owner` is deliberately excluded: ownership transfers through `adminSetRole`
 * under the Owner-only checks in `admin.functions.ts` and the `protect_last_owner`
 * trigger, never through a casual dropdown. The server still accepts `owner` in
 * `RoleEnum` so an Owner can grant it deliberately — this list governs the UI only.
 */
export const ASSIGNABLE_ROLES = [
  "customer_care",
  "telesales",
  "call_center",
  "auditor",
  "admin",
] as const satisfies readonly AppRole[];


/** Human-readable name. Exhaustive: a new role will not typecheck without one. */
export const ROLE_LABEL: Record<AppRole, string> = {
  owner: "Owner",
  admin: "Admin",
  customer_care: "Customer Care",
  telesales: "Telesales",
  call_center: "Call Center",
  auditor: "Auditor",
};

/**
 * Longer label used where the dropdown benefits from a hint about the role's
 * scope. Falls back to `ROLE_LABEL` for roles that need no qualifier.
 */
export const ROLE_OPTION_LABEL: Record<AppRole, string> = {
  ...ROLE_LABEL,
  auditor: "Auditor (read-only)",
};

/** Badge classes. Exhaustive: a new role will not typecheck without one. */
export const ROLE_TONE: Record<AppRole, string> = {
  owner: "bg-primary/10 text-primary border-primary/30",
  admin: "bg-secondary/15 text-secondary-foreground border-secondary/40",
  customer_care: "bg-blue-500/10 text-[var(--badge-blue)] border-blue-500/30",
  telesales: "bg-emerald-500/10 text-[var(--badge-emerald)] border-emerald-500/30",
  call_center: "bg-amber-500/10 text-[var(--badge-amber)] border-amber-500/30",
  auditor: "bg-muted text-muted-foreground border-border",
};


/** Narrowing guard for values arriving from the database or an API boundary. */
export function isAppRole(value: unknown): value is AppRole {
  return typeof value === "string" && (APP_ROLES as readonly string[]).includes(value);
}

/** Label for a possibly-unknown role value, without throwing on stale data. */
export function roleLabel(role: string | null | undefined): string {
  return isAppRole(role) ? ROLE_LABEL[role] : "—";
}

/** Badge classes for a possibly-unknown role value; empty string when unknown. */
export function roleTone(role: string | null | undefined): string {
  return isAppRole(role) ? ROLE_TONE[role] : "";
}
