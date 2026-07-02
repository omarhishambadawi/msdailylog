import type { AppRole } from "@/lib/auth";
import { isAdministrator } from "@/lib/auth";

export type PermissionGroup = "Orders" | "Complaints" | "Dashboard" | "Invoice Verification" | "Administration";

export interface PermissionDef {
  key: string;
  label: string;
  group: PermissionGroup;
}

export const ALL_PERMISSIONS: PermissionDef[] = [
  // Orders
  { key: "view_orders", label: "View Orders", group: "Orders" },
  { key: "create_orders", label: "Create Orders", group: "Orders" },
  { key: "edit_orders", label: "Edit Own Orders", group: "Orders" },
  { key: "edit_all_orders", label: "Edit All Orders", group: "Orders" },
  { key: "delete_orders", label: "Delete Orders", group: "Orders" },
  // Complaints
  { key: "view_complaints", label: "View Complaints", group: "Complaints" },
  { key: "create_complaints", label: "Create Complaints", group: "Complaints" },
  { key: "edit_complaints", label: "Edit Own Complaints", group: "Complaints" },
  { key: "edit_all_complaints", label: "Edit All Complaints", group: "Complaints" },
  { key: "delete_complaints", label: "Delete Complaints", group: "Complaints" },
  { key: "resolve_complaints", label: "Resolve Own Complaints", group: "Complaints" },
  { key: "resolve_all_complaints", label: "Resolve All Complaints", group: "Complaints" },
  // Dashboard
  { key: "view_dashboard", label: "View Dashboard", group: "Dashboard" },
  { key: "view_team_analytics", label: "View Team Analytics", group: "Dashboard" },
  { key: "view_all_agents", label: "View All Agents", group: "Dashboard" },
  { key: "export_reports", label: "Export Reports", group: "Dashboard" },
  // Invoice Verification
  { key: "verify_own_orders", label: "Verify Own Orders", group: "Invoice Verification" },
  { key: "verify_all_orders", label: "Verify All Orders", group: "Invoice Verification" },
  { key: "view_invoice_analytics", label: "View Invoice Analytics", group: "Invoice Verification" },
  // Administration
  { key: "view_reports", label: "View All Reports", group: "Administration" },
  { key: "manage_users", label: "Manage Users", group: "Administration" },
  { key: "manage_roles", label: "Manage Roles", group: "Administration" },
  { key: "admin_access", label: "Admin Access", group: "Administration" },
] as const;

export type PermKey = string;

const AUDITOR_PERMS: PermKey[] = [
  "view_orders",
  "view_complaints",
  "view_dashboard",
  "view_team_analytics",
  "view_all_agents",
  "view_invoice_analytics",
  "view_reports",
  "export_reports",
];

const AUDITOR_SAFE_READ_PERMS: PermKey[] = [...AUDITOR_PERMS];

const ROLE_ALLOWED_PERMS: Record<Exclude<AppRole, "admin" | "owner">, PermKey[]> = {
  customer_care: [
    "view_orders", "create_orders", "edit_orders",
    "view_complaints", "create_complaints", "edit_complaints", "resolve_complaints",
    "view_dashboard", "view_team_analytics",
    "verify_own_orders", "view_invoice_analytics",
    "export_reports",
  ],
  telesales: [
    "view_orders", "create_orders", "edit_orders",
    "view_dashboard", "view_team_analytics",
    "verify_own_orders", "view_invoice_analytics",
    "export_reports",
  ],
  auditor: AUDITOR_SAFE_READ_PERMS,
};

const ROLE_DEFAULTS: Record<AppRole, PermKey[]> = {
  owner: ALL_PERMISSIONS.map((p) => p.key),
  admin: ALL_PERMISSIONS.map((p) => p.key),
  customer_care: [
    "view_orders", "create_orders", "edit_orders",
    "view_complaints", "create_complaints", "edit_complaints", "resolve_complaints",
    "view_dashboard", "view_team_analytics",
    "verify_own_orders",
  ],
  telesales: [
    "view_orders", "create_orders", "edit_orders",
    "view_dashboard",
    "verify_own_orders",
  ],
  auditor: AUDITOR_PERMS,
};

export function hasPerm(role: AppRole | null, permissions: string[] | null | undefined, perm: PermKey): boolean {
  if (!role) return false;
  if (role === "admin") return true;
  // Auditor is strictly read-only — custom grants may add read-only modules, never mutating perms
  if (role === "auditor") {
    if (!AUDITOR_SAFE_READ_PERMS.includes(perm)) return false;
    if (permissions && permissions.length > 0) return permissions.includes(perm);
    return AUDITOR_PERMS.includes(perm);
  }
  if (permissions && permissions.length > 0) return ROLE_ALLOWED_PERMS[role].includes(perm) && permissions.includes(perm);
  return ROLE_DEFAULTS[role].includes(perm);
}

export function defaultPermsForRole(role: AppRole): PermKey[] {
  return ROLE_DEFAULTS[role];
}

export const PERMISSION_GROUPS: PermissionGroup[] = ["Orders", "Complaints", "Dashboard", "Invoice Verification", "Administration"];
