export const ORDER_TYPES = ["Cash", "Wasfaty"] as const;
export const DELIVERY_TYPES = ["AlShrouq", "Store Pickup", "Branch Scooter", "Azman"] as const;
export const STATUSES = ["Pending", "Completed", "Cancelled"] as const;
export const COMPLAINT_STATUSES = ["In Progress", "Resolved"] as const;
export const TEAMS = [
  { value: "customer_care", label: "Customer Care" },
  { value: "telesales", label: "Telesales" },
] as const;

export const STATUS_STYLES: Record<string, string> = {
  Pending: "bg-amber-100 text-amber-900 border-amber-300 dark:bg-amber-500/15 dark:text-amber-200 dark:border-amber-500/30",
  Completed: "bg-green-100 text-green-900 border-green-300 dark:bg-green-500/15 dark:text-green-200 dark:border-green-500/30",
  Cancelled: "bg-red-100 text-red-900 border-red-300 dark:bg-red-500/15 dark:text-red-200 dark:border-red-500/30",
  "In Progress": "bg-amber-100 text-amber-900 border-amber-300 dark:bg-amber-500/15 dark:text-amber-200 dark:border-amber-500/30",
  Resolved: "bg-green-100 text-green-900 border-green-300 dark:bg-green-500/15 dark:text-green-200 dark:border-green-500/30",
};

export const CURRENCY = "SAR";
export const fmtSAR = (v: number | string | null | undefined) => {
  const n = typeof v === "string" ? Number(v) : v;
  if (n == null || isNaN(n as number)) return "—";
  return `${(n as number).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${CURRENCY}`;
};

/** Team-aware display number, e.g. CC-43435 or TS-4323. Strips leading "#". */
export function formatOrderNo(team: string | null | undefined, displayNo: string | null | undefined): string {
  if (!displayNo) return "—";
  const n = String(displayNo).replace(/^#/, "");
  const prefix = team === "telesales" ? "TS-" : "CC-";
  return `${prefix}${n}`;
}

/** Strip team prefix to get the numeric portion, for searching. */
export function stripOrderPrefix(s: string): string {
  return s.replace(/^(cc-|ts-|#)/i, "");
}
