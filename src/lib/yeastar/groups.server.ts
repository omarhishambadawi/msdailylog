/**
 * Yeastar extension-group resolver.
 *
 * The Yeastar OpenAPI documents two spellings for this endpoint:
 *   - Cloud Edition:      GET /openapi/v1.0/extension_group/list
 *   - Appliance Edition:  GET /openapi/v1.0/extension_group/search
 *
 * Historically there was also an undocumented `/extensiongroup/*` variant.
 * On some firmwares (observed on 37.21.0.66) all of these return
 * `errcode 10001 INTERFACE NOT EXISTED` even though the PBX web UI clearly
 * exposes Extension Groups. This almost always means the OpenAPI role
 * assigned to the API client lacks the "Extension Group" permission scope
 * (the OpenAPI treats forbidden endpoints as non-existent). The PBX web UI
 * itself does NOT use the OpenAPI — it calls an internal `/api/...`
 * admin API authenticated by a login-session cookie, which we cannot reuse
 * from our OpenAPI credentials.
 *
 * To keep the integration unblocked while the PBX-side scope is being
 * enabled, this module also supports an explicit override:
 *   YEASTAR_GROUP_CUSTOMER_CARE_ID  (integer group ID)
 *   YEASTAR_GROUP_TELESALES_ID      (integer group ID)
 * If both are set, we skip the API probe entirely.
 *
 * When the probe runs, every attempt is recorded (path, HTTP status,
 * errcode, errmsg, body preview) and surfaced by the diagnostic function
 * so the failure mode is visible without SSH-level debugging.
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

export interface ProbeAttempt {
  path: string;
  httpStatus: number;
  errcode: number | null;
  errmsg: string | null;
  bodyPreview: string;
  count: number;
}

export interface ResolvedGroups {
  customerCareId: number | null;
  telesalesId: number | null;
  raw: ExtensionGroup[];
  fetchedAt: string;
  source: "override" | "probe";
  attempts: ProbeAttempt[];
  probedPath?: string;
}

const TTL_MS = 10 * 60_000;
let cache: { at: number; data: ResolvedGroups } | null = null;

// Documented spellings, in order of most-likely-supported first.
const CANDIDATE_PATHS = [
  "/openapi/v1.0/extension_group/list",     // Cloud Edition (documented)
  "/openapi/v1.0/extension_group/search",   // Appliance Edition (documented)
  "/openapi/v1.0/extensiongroup/list",      // legacy / undocumented
  "/openapi/v1.0/extensiongroup/search",    // legacy / undocumented
];

function pickIdByName(groups: ExtensionGroup[], target: string): number | null {
  const norm = (s: string) => s.trim().toLowerCase().replace(/[._\s]/g, "");
  const t = norm(target);
  return groups.find((g) => norm(g.name ?? "") === t)?.id ?? null;
}

function readOverride(): { cc: number | null; ts: number | null } {
  const cc = Number(process.env.YEASTAR_GROUP_CUSTOMER_CARE_ID);
  const ts = Number(process.env.YEASTAR_GROUP_TELESALES_ID);
  return {
    cc: Number.isFinite(cc) && cc > 0 ? cc : null,
    ts: Number.isFinite(ts) && ts > 0 ? ts : null,
  };
}

async function probeOnce(path: string): Promise<{ attempt: ProbeAttempt; list: ExtensionGroup[] | null }> {
  // Minimal params — some firmwares reject `sort_by=name`.
  const { httpStatus, json, body } = await yeastarFetch<any>(path, { page: 1, page_size: 100 });
  const errcode = json?.errcode ?? null;
  const errmsg = json?.errmsg ?? null;
  const list: ExtensionGroup[] | null =
    httpStatus === 200 && errcode === 0
      ? (json.extension_group_list ?? json.data ?? json.list ?? [])
      : null;
  return {
    attempt: {
      path,
      httpStatus,
      errcode,
      errmsg,
      bodyPreview: body.slice(0, 400),
      count: list?.length ?? 0,
    },
    list,
  };
}

export async function resolveExtensionGroups(force = false): Promise<ResolvedGroups> {
  const now = Date.now();
  if (!force && cache && now - cache.at < TTL_MS) return cache.data;

  const override = readOverride();
  if (override.cc && override.ts) {
    const data: ResolvedGroups = {
      customerCareId: override.cc,
      telesalesId: override.ts,
      raw: [
        { id: override.cc, name: GROUP_NAME_CUSTOMER_CARE },
        { id: override.ts, name: GROUP_NAME_TELESALES },
      ],
      fetchedAt: new Date(now).toISOString(),
      source: "override",
      attempts: [],
    };
    cache = { at: now, data };
    console.log(`[yeastar groups] using env override cc=${override.cc} ts=${override.ts}`);
    return data;
  }

  const attempts: ProbeAttempt[] = [];
  let list: ExtensionGroup[] | null = null;
  let probedPath: string | undefined;

  for (const path of CANDIDATE_PATHS) {
    const { attempt, list: got } = await probeOnce(path);
    attempts.push(attempt);
    if (got) { list = got; probedPath = path; break; }
    // Continue only on 10001 (INTERFACE NOT EXISTED). Any other failure is fatal
    // for this call — retrying alternate spellings would just mask the real error.
    if (attempt.errcode !== 10001) break;
  }

  if (!list) {
    const detail = attempts
      .map((a) => `${a.path} → HTTP ${a.httpStatus} errcode=${a.errcode ?? "n/a"} ${a.errmsg ?? ""}`)
      .join(" | ");
    const hint =
      attempts.every((a) => a.errcode === 10001)
        ? " Hint: every documented spelling returned INTERFACE NOT EXISTED. On the PBX, open Integrations → API Integration, edit this client, and enable the 'Extension Group' permission scope. If that scope is unavailable, set YEASTAR_GROUP_CUSTOMER_CARE_ID and YEASTAR_GROUP_TELESALES_ID secrets to the IDs shown in Extension and Trunk → Extension Group."
        : "";
    throw new Error(`Extension group lookup failed. Attempts: ${detail}.${hint}`);
  }

  const data: ResolvedGroups = {
    customerCareId: pickIdByName(list, GROUP_NAME_CUSTOMER_CARE),
    telesalesId: pickIdByName(list, GROUP_NAME_TELESALES),
    raw: list.map((g) => ({ id: g.id, name: g.name, member_count: g.member_count })),
    fetchedAt: new Date(now).toISOString(),
    source: "probe",
    attempts,
    probedPath,
  };
  cache = { at: now, data };
  console.log(`[yeastar groups] resolved via ${probedPath} cc=${data.customerCareId} ts=${data.telesalesId} (of ${list.length} groups)`);
  return data;
}

export function _resetGroupsCacheForTests() { cache = null; }
