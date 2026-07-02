import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { yeastarRawProbe } from "@/lib/yeastar-raw-probe.functions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth, isAdministrator } from "@/lib/auth";

export const Route = createFileRoute("/_app/admin/yeastar-raw")({
  head: () => ({
    meta: [
      { title: "Yeastar Raw Probe (temporary)" },
      { name: "description", content: "Temporary raw diagnostic — extension/list and cdr/list." },
    ],
  }),
  component: RawProbePage,
});

function RawProbePage() {
  const { role } = useAuth();
  const run = useServerFn(yeastarRawProbe);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);

  if (!isAdministrator(role)) {
    return <div className="p-6 text-sm">Not authorized.</div>;
  }

  return (
    <div className="mx-auto max-w-5xl p-6 space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Yeastar Raw Probe (temporary diagnostic)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Performs a fresh <code>/get_token</code>, then raw
            <code> GET /openapi/v1.0/extension/list</code> and
            <code> GET /openapi/v1.0/cdr/list?page=1&page_size=1</code>.
            Prints URL (token masked), method, HTTP status, raw body,
            <code> errcode</code>, and <code>errmsg</code>. Does not touch cached auth.
          </p>
          <Button
            onClick={async () => {
              setBusy(true);
              try { setResult(await run()); } finally { setBusy(false); }
            }}
            disabled={busy}
          >
            {busy ? "Running…" : "Run raw probe"}
          </Button>
          {result && (
            <pre className="text-xs bg-muted p-3 rounded overflow-auto max-h-[70vh]">
              {JSON.stringify(result, null, 2)}
            </pre>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
