/**
 * Yeastar extension-group resolver.
 *
 * Looks up the two operational groups (Customer_Care_Emp. and
 * Telesales_Emp.) via GET /openapi/v1.0/extensiongroup/search and caches
 * the resulting IDs in memory for 10 minutes.
 */
import { yeastarFetch } from "./client.server";

export const GROUP_NAME_CUSTOMER_CARE = "Customer_Care_Emp.";
export const GROUP_NAME_TELESALES = "Telesales_Emp.";

export interface ExtensionGroup {
  id: number;
  name: string;
  member_count?: number;
  member_list?: Array<{ ext_id?: number; ext_num?: string; ext_name?: string; number?: string; name?: string }>;
}

export interface ResolvedGroups {
  customerCareId: number | null;
  telesalesId: number | null;
  raw: ExtensionGroup[];
  fetchedAt: string;
}

const TTL_MS = 10 * 60_000;
let cache: { at: number; data: ResolvedGroups } | null = null;

function pickIdByName(groups: ExtensionGroup[], target: string): number | null {
  const t = target.trim().toLowerCase();
  const exact = groups.find((g) => (g.name ?? "").trim().toLowerCase() === t);
  if (exact) return exact.id;
  const loose = groups.find((g) => (g.name ?? "").trim().toLowerCase().replace(/[._\s]/g, "") === t.replace(/[._\s]/g, ""));
  return loose?.id ?? null;
}

export async function resolveExtensionGroups(force = false): Promise<ResolvedGroups> {
  const now = Date.now();
  if (!force && cache && now - cache.at < TTL_MS) return cache.data;

  // Cloud Edition uses /extensiongroup/list; Appliance uses /extensiongroup/search.
  // Try list first, fall back to search for on-prem PBXs.
  let { httpStatus, json, body } = await yeastarFetch<any>(
    "/openapi/v1.0/extensiongroup/list",
    { page: 1, page_size: 200, sort_by: "name", order_by: "asc" },
  );
  if (httpStatus === 200 && json?.errcode === 10001) {
    ({ httpStatus, json, body } = await yeastarFetch<any>(
      "/openapi/v1.0/extensiongroup/search",
      { page: 1, page_size: 200, sort_by: "name", order_by: "asc" },
    ));
  }
  if (httpStatus !== 200 || !json || json.errcode !== 0) {
    throw new Error(`extensiongroup/list failed: HTTP ${httpStatus} errcode=${json?.errcode ?? "n/a"} body=${body.slice(0, 200)}`);
  }
  const list: ExtensionGroup[] = json.extension_group_list ?? json.data ?? json.list ?? [];
  const data: ResolvedGroups = {
    customerCareId: pickIdByName(list, GROUP_NAME_CUSTOMER_CARE),
    telesalesId: pickIdByName(list, GROUP_NAME_TELESALES),
    raw: list.map((g) => ({ id: g.id, name: g.name, member_count: g.member_count })),
    fetchedAt: new Date(now).toISOString(),
  };
  cache = { at: now, data };
  console.log(`[yeastar groups] resolved cc=${data.customerCareId} ts=${data.telesalesId} (of ${list.length} groups)`);
  return data;
}

export function _resetGroupsCacheForTests() { cache = null; }
