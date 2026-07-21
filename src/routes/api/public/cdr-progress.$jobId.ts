import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

// NOTE: the `/api/public/` path is legacy — this endpoint is NOT public.
// It reads `cdr_progress` through the service-role client (RLS bypassed), so
// every request must carry a valid Supabase access token. The jobId is an
// unguessable UUID, but that alone is not an authorization boundary.

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

async function requireUser(request: Request): Promise<string | null> {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) return null;

  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) return null;

  const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase.auth.getClaims(token);
  if (error || !data?.claims?.sub) return null;
  return String(data.claims.sub);
}

export const Route = createFileRoute("/api/public/cdr-progress/$jobId")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const userId = await requireUser(request);
        if (!userId) return json({ error: "Unauthorized" }, 401);

        const { getJob } = await import("@/lib/yeastar/progress.server");
        // Jobs are stored namespaced as `${userId}:${jobId}` by
        // getCallCenterAnalytics. Re-deriving the key from the authenticated
        // caller means a user can only ever read their own job, so a guessed
        // or copied jobId reveals nothing about anyone else's query.
        const j = await getJob(`${userId}:${params.jobId}`);
        if (!j) {
          return json({ status: "unknown", message: "No job found" });
        }
        const percent =
          j.totalPages && j.totalPages > 0
            ? Math.min(100, Math.round((j.page / j.totalPages) * 100))
            : j.status === "done"
              ? 100
              : j.status === "aggregating"
                ? 95
                : 5;

        // `error` carries upstream PBX/infra detail — keep it server-side.
        const { error: _internalError, ...safe } = j;
        return json({ ...safe, percent });
      },
    },
  },
});
