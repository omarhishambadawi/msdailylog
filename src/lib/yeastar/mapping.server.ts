/**
 * Yeastar Extension Mapping — the single source of truth for Call Center
 * Analytics. Backed by `public.yeastar_extension_map` in Supabase.
 *
 * The mapping ties each PBX extension number to a platform agent and a team
 * (customer_care | telesales). Because the PBX API needs internal extension
 * IDs (not numbers) for /call_report/list, we also resolve ext_num → ext_id
 * by calling /openapi/v1.0/extension/list once and caching the result.
 *
 * All analytics reads must go through resolveMappingContext(); anything not
 * in the mapping is silently excluded (and logged as "Unmapped Extension"
 * for diagnostics).
 */
import { yeastarFetch } from "./client.server";

export type Team = "customer_care" | "telesales";

export interface ExtensionMapRow {
  ext_num: string;
  agent_name: string;
  team: Team;
  agent_code: string | null;
  active: boolean;
}

export interface MappingContext {
  /** Only active mapped extensions. Keyed by ext_num. */
  byExtNum: Map<string, ExtensionMapRow>;
  /** ext_num -> PBX internal extension id (as string). */
  extNumToId: Map<string, string>;
  /** ext_num values that are in the mapping but the PBX doesn't know about. */
  missingOnPbx: string[];
  /** ext_num values the PBX returned that aren't in the mapping. */
  unmappedFromPbx: string[];
  fetchedAt: string;
}

const MAP_TTL_MS = 60_000;
const EXT_TTL_MS = 5 * 60_000;
let mapCache: { at: number; rows: ExtensionMapRow[] } | null = null;
let extCache: { at: number; list: Array<{ id: string; ext_num: string; name?: string }> } | null = null;

function normalizeTeam(v: unknown): Team | null {
  const s = String(v ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (s === "customer_care" || s === "customercare" || s === "cc") return "customer_care";
  if (s === "telesales" || s === "ts") return "telesales";
  return null;
}

export async function loadMappingRows(force = false): Promise<ExtensionMapRow[]> {
  const now = Date.now();
  if (!force && mapCache && now - mapCache.at < MAP_TTL_MS) return mapCache.rows;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("yeastar_extension_map")
    .select("ext_num, agent_name, team, agent_code, active");
  if (error) throw new Error(`mapping load failed: ${error.message}`);
  const rows: ExtensionMapRow[] = (data ?? []).map((r: any) => ({
    ext_num: String(r.ext_num),
    agent_name: r.agent_name,
    team: r.team as Team,
    agent_code: r.agent_code ?? null,
    active: !!r.active,
  }));
  mapCache = { at: now, rows };
  return rows;
}

/** Fetch all extensions from PBX and return {id, ext_num}. */
async function loadPbxExtensions(force = false): Promise<Array<{ id: string; ext_num: string; name?: string }>> {
  const now = Date.now();
  if (!force && extCache && now - extCache.at < EXT_TTL_MS) return extCache.list;

  const all: Array<{ id: string; ext_num: string; name?: string }> = [];
  let page = 1;
  const pageSize = 200;
  // Cap at 20 pages defensively (=4000 extensions).
  for (; page <= 20; page++) {
    const { httpStatus, json, body } = await yeastarFetch<any>("/openapi/v1.0/extension/list", {
      page, page_size: pageSize,
    });
    if (httpStatus !== 200 || !json || json.errcode !== 0) {
      throw new Error(`extension/list failed: HTTP ${httpStatus} errcode=${json?.errcode ?? "n/a"} body=${body.slice(0, 200)}`);
    }
    const list: any[] = json.extension_list ?? json.data ?? json.list ?? [];
    for (const e of list) {
      const id = e.id ?? e.extension_id;
      const num = e.number ?? e.extension ?? e.ext_num;
      if (id == null || num == null) continue;
      all.push({ id: String(id), ext_num: String(num), name: e.name ?? e.ext_name });
    }
    const total = Number(json.total_number ?? json.total ?? 0);
    if (list.length < pageSize) break;
    if (total && all.length >= total) break;
  }
  extCache = { at: now, list: all };
  return all;
}

export async function resolveMappingContext(force = false): Promise<MappingContext> {
  const [rows, pbxExts] = await Promise.all([loadMappingRows(force), loadPbxExtensions(force)]);
  const active = rows.filter((r) => r.active);
  const byExtNum = new Map<string, ExtensionMapRow>();
  for (const r of active) byExtNum.set(r.ext_num, r);

  const extNumToId = new Map<string, string>();
  const pbxByNum = new Map(pbxExts.map((e) => [e.ext_num, e]));
  for (const ext of byExtNum.keys()) {
    const p = pbxByNum.get(ext);
    if (p) extNumToId.set(ext, p.id);
  }
  const missingOnPbx = [...byExtNum.keys()].filter((n) => !extNumToId.has(n));
  const unmappedFromPbx = pbxExts.map((e) => e.ext_num).filter((n) => !byExtNum.has(n));

  return {
    byExtNum,
    extNumToId,
    missingOnPbx,
    unmappedFromPbx,
    fetchedAt: new Date().toISOString(),
  };
}

export function resetMappingCache() { mapCache = null; extCache = null; }

/** Parse CSV: `ext_num,agent_name,team` (header optional). */
export function parseMappingCsv(csv: string): {
  rows: Array<{ ext_num: string; agent_name: string; team: Team }>;
  errors: Array<{ line: number; error: string; raw: string }>;
} {
  const rows: Array<{ ext_num: string; agent_name: string; team: Team }> = [];
  const errors: Array<{ line: number; error: string; raw: string }> = [];
  const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  lines.forEach((raw, idx) => {
    const line = idx + 1;
    // Skip a header row if the first cell is not a digit.
    const cols = raw.split(",").map((c) => c.trim());
    if (idx === 0 && cols[0] && !/^\d/.test(cols[0])) return;
    if (cols.length < 3) { errors.push({ line, error: "expected 3 columns: ext_num,agent_name,team", raw }); return; }
    const [ext_num, agent_name, teamRaw] = cols;
    if (!/^\d+$/.test(ext_num)) { errors.push({ line, error: "ext_num must be numeric", raw }); return; }
    if (!agent_name) { errors.push({ line, error: "agent_name is empty", raw }); return; }
    const team = normalizeTeam(teamRaw);
    if (!team) { errors.push({ line, error: `unknown team '${teamRaw}' (use customer_care or telesales)`, raw }); return; }
    rows.push({ ext_num, agent_name, team });
  });
  return { rows, errors };
}
