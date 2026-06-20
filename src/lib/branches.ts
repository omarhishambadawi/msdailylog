export const ORDER_TYPES = ["Cash", "Wasfaty", "Complaint"] as const;
export const DELIVERY_TYPES = ["AlShrouq", "Store Pickup", "Branch Scooter", "Azman"] as const;
export const STATUSES = ["Pending", "Completed", "Closed", "Holded", "Complaint - Solved"] as const;
export const TEAMS = [
  { value: "customer_care", label: "Customer Care" },
  { value: "telesales", label: "Telesales" },
] as const;
