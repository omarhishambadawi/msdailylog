import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/cdr-progress/$jobId")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const { getJob } = await import("@/lib/yeastar/progress.server");
        const j = getJob(params.jobId);
        if (!j) {
          return new Response(
            JSON.stringify({ status: "unknown", message: "No job found" }),
            { headers: { "content-type": "application/json", "cache-control": "no-store" } },
          );
        }
        const percent =
          j.totalPages && j.totalPages > 0
            ? Math.min(100, Math.round((j.page / j.totalPages) * 100))
            : j.status === "done" ? 100 : j.status === "aggregating" ? 95 : 5;
        return new Response(JSON.stringify({ ...j, percent }), {
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        });
      },
    },
  },
});
