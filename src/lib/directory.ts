import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type DirectoryAgent = {
  id: string;
  full_name: string | null;
  agent_code: string | null;
  role: string | null;
};

/**
 * Shared React Query key for the agent directory.
 *
 * A single key means the profiles + user_roles fetch is de-duplicated and its
 * cache reused across every consumer (Dashboard, Orders, Call Center) instead of
 * each route holding its own copy under a private key.
 */
export const AGENT_DIRECTORY_KEY = ["agent-directory"] as const;

/**
 * Loads every profile the caller is allowed to see, joined with each user's
 * role. RLS still governs the rows returned: privileged users (manage_users /
 * view_all_agents) get the whole directory, everyone else gets only their own
 * row — exactly as the previous per-route queries did.
 */
async function fetchAgentDirectory(): Promise<DirectoryAgent[]> {
  const [{ data: profiles }, { data: roles }] = await Promise.all([
    supabase.from("profiles").select("id,full_name,agent_code").order("full_name"),
    supabase.from("user_roles").select("user_id,role"),
  ]);
  const roleById = new Map((roles ?? []).map((r: any) => [r.user_id, r.role]));
  return (profiles ?? []).map((p: any) => ({ ...p, role: roleById.get(p.id) ?? null }));
}

/**
 * Single reusable source for the agent directory.
 *
 * This exact query was previously copy-pasted into three routes under three
 * different keys ("dashboard-agents", "orders-agents", "cc-agents"), plus the
 * profiles half was fetched a fourth time by the Orders row-enrichment query.
 * They now all read through this one hook / key.
 *
 * @param options.enabled Gate the fetch on a permission flag (defaults to true,
 *   for consumers such as Orders enrichment that need it for every user).
 */
export function useAgentDirectory(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: AGENT_DIRECTORY_KEY,
    queryFn: fetchAgentDirectory,
    enabled: options?.enabled ?? true,
  });
}
