import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  yeastarConfigDiagnostic,
  yeastarAuthDiagnostic,
  yeastarCdrDiagnostic,
} from "@/lib/yeastar.functions";

export const Route = createFileRoute("/_app/admin/yeastar")({
  component: YeastarAdmin,
  head: () => ({ meta: [{ title: "Yeastar Diagnostics · MilaServ" }] }),
});

function Pill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <Badge variant={ok ? "default" : "destructive"} className="font-normal">
      {label}: {ok ? "yes" : "no"}
    </Badge>
  );
}

function Json({ data }: { data: unknown }) {
  return (
    <pre className="text-xs bg-muted rounded p-3 overflow-auto max-h-[420px]">
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}

function YeastarAdmin() {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const [from, setFrom] = useState(yesterday);
  const [to, setTo] = useState(today);

  const configFn = useServerFn(yeastarConfigDiagnostic);
  const authFn = useServerFn(yeastarAuthDiagnostic);
  const cdrFn = useServerFn(yeastarCdrDiagnostic);

  const config = useQuery({ queryKey: ["yeastar-config"], queryFn: () => configFn() });
  const auth = useMutation({ mutationFn: () => authFn() });
  const cdr = useMutation({ mutationFn: () => cdrFn({ data: { from, to, limit: 10 } }) });

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-5xl">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Yeastar Integration</h1>
        <p className="text-sm text-muted-foreground">Configuration · Authentication · CDR probe</p>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">1. Configuration</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Pill ok={!!config.data?.baseUrlLoaded} label="YEASTAR_BASE_URL" />
            <Pill ok={!!config.data?.clientIdLoaded} label="YEASTAR_CLIENT_ID" />
            <Pill ok={!!config.data?.clientSecretLoaded} label="YEASTAR_CLIENT_SECRET" />
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => config.refetch()} disabled={config.isFetching}>
              {config.isFetching ? "Checking…" : "Re-check"}
            </Button>
          </div>
          {config.data && <Json data={config.data} />}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">2. Authentication</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <Button size="sm" onClick={() => auth.mutate()} disabled={auth.isPending}>
            {auth.isPending ? "Authenticating…" : "Run auth check"}
          </Button>
          {auth.data && <Json data={auth.data} />}
          {auth.error && <div className="text-sm text-destructive">{(auth.error as Error).message}</div>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">3. CDR probe</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3 max-w-md">
            <div>
              <Label htmlFor="from">From</Label>
              <Input id="from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="to">To</Label>
              <Input id="to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
          </div>
          <Button size="sm" onClick={() => cdr.mutate()} disabled={cdr.isPending}>
            {cdr.isPending ? "Fetching…" : "Fetch first 10 records"}
          </Button>
          {cdr.data && <Json data={cdr.data} />}
          {cdr.error && <div className="text-sm text-destructive">{(cdr.error as Error).message}</div>}
        </CardContent>
      </Card>
    </div>
  );
}
