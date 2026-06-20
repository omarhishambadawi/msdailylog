import type { AppRole } from "@/lib/auth";

export const ALL_PERMISSIONS = [
  { key: "create_orders", label: "Create Orders" },
  { key: "edit_orders", label: "Edit Orders" },
  { key: "view_orders", label: "View Orders" },
  { key: "create_complaints", label: "Create Complaints" },
  { key: "edit_complaints", label: "Edit Complaints" },
  { key: "view_reports", label: "View Reports" },
  { key: "admin_access", label: "Admin Access" },
] as const;

export type PermKey = (typeof ALL_PERMISSIONS)[number]["key"];

const ROLE_DEFAULTS: Record<AppRole, PermKey[]> = {
  admin: ALL_PERMISSIONS.map((p) => p.key) as PermKey[],
  customer_care: ["create_orders", "edit_orders", "view_orders", "create_complaints", "edit_complaints", "view_reports"],
  telesales: ["create_orders", "edit_orders", "view_orders", "view_reports"],
};

export function hasPerm(role: AppRole | null, permissions: string[] | null | undefined, perm: PermKey): boolean {
  if (!role) return false;
  if (role === "admin") return true;
  if (permissions && permissions.length > 0) return permissions.includes(perm);
  return ROLE_DEFAULTS[role].includes(perm);
}

export function defaultPermsForRole(role: AppRole): PermKey[] {
  return ROLE_DEFAULTS[role];
}
