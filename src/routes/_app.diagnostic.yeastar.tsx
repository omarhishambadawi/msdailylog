import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { yeastarPhase1Probe } from "@/lib/yeastar-diagnostic.functions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const Route = createFileRoute("/_app/diagnostic/yeastar")({
  head: () => ({
    meta: [
      { title: "Yeastar Diagnostic — Phase 1" },
      { name: "description", content: "Isolated Yeastar auth + CDR smoke test." },
    ],
  }),
  component: YeastarPhase1Page,
});

function YeastarPhase1Page() {
  const runProbe = useServerFn(yeastarPhase1Probe);
  const [state, setState] = useState<
    { status: "idle" } | { status: "loading" } | { status: "done"; result: any } | { status: "error"; error: string }
  >({ status: "idle" });

  const run = async () => {
    setState({ status: "loading" });
    try {
      const result = await runProbe();
      setState({ status: "done", result });
    } catch (err) {
      setState({ status: "error", error: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div className="mx-auto max-w-4xl p-6 space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Yeastar Diagnostic — Phase 1</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Isolated test: authenticate (reuses cached token when possible), fetch CDR for the last
            24 hours, display the first 10 records. No mapping, no analytics, no Supabase joins.
          </p>
          <Button onClick={run} disabled={state.status === "loading"}>
            {state.status === "loading" ? "Running…" : "Run Phase 1 Probe"}
          </Button>
          {state.status === "error" && (
            <pre className="text-sm text-destructive whitespace-pre-wrap">{state.error}</pre>
          )}
          {state.status === "done" && (
            <pre className="text-xs bg-muted p-3 rounded overflow-auto max-h-[70vh]">
              {JSON.stringify(state.result, null, 2)}
            </pre>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
