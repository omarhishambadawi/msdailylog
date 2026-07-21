import type { AppRole } from "@/lib/auth";
import { isAdministrator } from "@/lib/auth";

export type PermissionGroup = "Orders" | "Complaints" | "Dashboard" | "Invoice Verification" | "Branches" | "Administration";

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
  { key: "view_call_center", label: "View Call Center Analytics", group: "Dashboard" },
  { key: "export_reports", label: "Export Reports", group: "Dashboard" },
  // Invoice Verification
  { key: "verify_own_orders", label: "Verify Own Orders", group: "Invoice Verification" },
  { key: "verify_all_orders", label: "Verify All Orders", group: "Invoice Verification" },
  { key: "view_invoice_analytics", label: "View Invoice Analytics", group: "Invoice Verification" },
  // Branches
  { key: "view_branches", label: "View Branches", group: "Branches" },
  // Administration
  { key: "view_reports", label: "View All Reports", group: "Administration" },
  { key: "manage_users", label: "Manage Users", group: "Administration" },
  // `manage_roles` was removed: it was declared here (so it rendered a
  // checkbox) but enforced nowhere. Role changes go through adminSetRole,
  // which gates on assertAdmin/is_administrator -- and has_permission()
  // short-circuits to true for owner/admin, so the flag could never evaluate
  // false for anyone able to reach that function. Leaving it in place was
  // actively misleading: unticking it looked like it revoked role management
  // while changing nothing. Role management remains administrator-only.
  { key: "admin_access", label: "Admin Access (edit branches, system)", group: "Administration" },
] as const;

export type PermKey = string;

const AUDITOR_PERMS: PermKey[] = [
  "view_orders",
  "view_complaints",
  "view_dashboard",
  "view_team_analytics",
  "view_all_agents",
  "view_call_center",
  "view_invoice_analytics",
  "view_reports",
  "export_reports",
  "view_branches",
];

const AUDITOR_SAFE_READ_PERMS: PermKey[] = [...AUDITOR_PERMS];

// Operational role between the administrators and the agents: runs the daily
// order/complaint workflow across the whole team, but never touches user
// administration, roles, permissions or system settings.
// `edit_all_orders` is what grants order reassignment -- prevent_order_reassignment
// only permits changing agent_id/team for callers holding it.
const SUPERVISOR_ALLOWED_PERMS: PermKey[] = [
  "view_orders", "create_orders", "edit_orders", "edit_all_orders",
  "view_complaints", "create_complaints", "edit_complaints", "edit_all_complaints",
  "resolve_complaints", "resolve_all_complaints",
  "view_dashboard", "view_team_analytics", "view_all_agents", "view_call_center",
  "verify_own_orders", "verify_all_orders", "view_invoice_analytics",
  "view_branches", "export_reports",
];

const SUPERVISOR_DEFAULT_PERMS: PermKey[] = [
  "view_orders", "create_orders", "edit_orders", "edit_all_orders",
  "view_complaints", "create_complaints", "edit_complaints", "edit_all_complaints",
  "resolve_complaints", "resolve_all_complaints",
  "view_dashboard", "view_team_analytics", "view_all_agents", "view_call_center",
  "verify_own_orders", "verify_all_orders", "view_branches",
];

const ROLE_ALLOWED_PERMS: Record<Exclude<AppRole, "admin" | "owner">, PermKey[]> = {
  supervisor: SUPERVISOR_ALLOWED_PERMS,
  customer_care: [
    "view_orders", "create_orders", "edit_orders",
    "view_complaints", "create_complaints", "edit_complaints", "resolve_complaints",
    "view_dashboard", "view_team_analytics",
    "verify_own_orders", "view_invoice_analytics",
    "view_branches",
    "export_reports",
  ],
  telesales: [
    "view_orders", "create_orders", "edit_orders",
    "view_dashboard", "view_team_analytics",
    "verify_own_orders", "view_invoice_analytics",
    "view_branches",
    "export_reports",
  ],
  call_center: [
    "view_orders",
    "view_complaints", "create_complaints", "edit_complaints", "resolve_complaints",
    "view_dashboard", "view_team_analytics", "view_call_center",
    "view_invoice_analytics", "export_reports",
    "view_branches",
  ],
  auditor: AUDITOR_SAFE_READ_PERMS,
};

const ROLE_DEFAULTS: Record<AppRole, PermKey[]> = {
  owner: ALL_PERMISSIONS.map((p) => p.key),
  admin: ALL_PERMISSIONS.map((p) => p.key),
  supervisor: SUPERVISOR_DEFAULT_PERMS,
  customer_care: [
    "view_orders", "create_orders", "edit_orders",
    "view_complaints", "create_complaints", "edit_complaints", "resolve_complaints",
    "view_dashboard", "view_team_analytics",
    "verify_own_orders",
    "view_branches",
  ],
  telesales: [
    "view_orders", "create_orders", "edit_orders",
    "view_dashboard",
    "verify_own_orders",
    "view_branches",
  ],
  call_center: [
    "view_orders",
    "view_complaints", "create_complaints", "edit_complaints", "resolve_complaints",
    "view_dashboard", "view_team_analytics", "view_call_center",
    "view_branches",
  ],
  auditor: AUDITOR_PERMS,
};

export function hasPerm(role: AppRole | null, permissions: string[] | null | undefined, perm: PermKey): boolean {
  if (!role) return false;
  if (isAdministrator(role)) return true;
  if (role === "auditor") {
    if (!AUDITOR_SAFE_READ_PERMS.includes(perm)) return false;
    if (permissions && permissions.length > 0) return permissions.includes(perm);
    return AUDITOR_PERMS.includes(perm);
  }
  const nonAdminRole = role as Exclude<AppRole, "admin" | "owner">;
  if (permissions && permissions.length > 0) return ROLE_ALLOWED_PERMS[nonAdminRole].includes(perm) && permissions.includes(perm);
  return ROLE_DEFAULTS[role].includes(perm);
}

export function defaultPermsForRole(role: AppRole): PermKey[] {
  return ROLE_DEFAULTS[role];
}

export const PERMISSION_GROUPS: PermissionGroup[] = ["Orders", "Complaints", "Dashboard", "Invoice Verification", "Branches", "Administration"];
