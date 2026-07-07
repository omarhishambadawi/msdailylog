import { auth, defineMcp } from "@lovable.dev/mcp-js";
import whoami from "./tools/whoami";
import listOrders from "./tools/list-orders";
import getOrder from "./tools/get-order";
import listComplaints from "./tools/list-complaints";
import ordersSummary from "./tools/orders-summary";

// The OAuth issuer must be the direct Supabase host, not the .lovable.cloud
// proxy that publish rewrites SUPABASE_URL to. VITE_SUPABASE_PROJECT_ID is
// inlined by Vite at build time.
const projectRef = import.meta.env.VITE_SUPABASE_PROJECT_ID ?? "project-ref-unset";

export default defineMcp({
  name: "milaserv-daily-log-mcp",
  title: "MilaServ Portal",
  version: "0.1.0",
  instructions:
    "Tools for the MilaServ Portal app. Use `whoami` to confirm the signed-in user. Use `list_orders`, `get_order`, and `orders_summary` for order data (filter by date range, team, status). Use `list_complaints` for complaint data. All data is scoped to what the signed-in user is allowed to see.",
  auth: auth.oauth.issuer({
    issuer: `https://${projectRef}.supabase.co/auth/v1`,
    acceptedAudiences: "authenticated",
  }),
  tools: [whoami, listOrders, getOrder, listComplaints, ordersSummary],
});
