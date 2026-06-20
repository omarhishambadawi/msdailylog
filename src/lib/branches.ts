export const ORDER_TYPES = ["Cash", "Wasfaty"] as const;
export const DELIVERY_TYPES = ["AlShrouq", "Store Pickup", "Branch Scooter", "Azman"] as const;
export const STATUSES = ["Pending", "Completed", "Cancelled", "Follow-up", "No Answer", "Closed"] as const;
export const COMPLAINT_STATUSES = ["Open", "In Progress", "Resolved", "Closed"] as const;
export const TEAMS = [
  { value: "customer_care", label: "Customer Care" },
  { value: "telesales", label: "Telesales" },
] as const;

export const CURRENCY = "SAR";
export const fmtSAR = (v: number | string | null | undefined) => {
  const n = typeof v === "string" ? Number(v) : v;
  if (n == null || isNaN(n as number)) return "—";
  return `${(n as number).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${CURRENCY}`;
};
