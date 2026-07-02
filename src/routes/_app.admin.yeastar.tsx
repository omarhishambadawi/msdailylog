import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  yeastarConfigDiagnostic,
  yeastarAuthDiagnostic,
  yeastarGroupsDiagnostic,
  yeastarCallAnalytics,
} from "@/lib/yeastar.functions";

export const Route = createFileRoute("/_app/admin/yeastar")({
  component: YeastarAdmin,
  head: () => ({ meta: [{ title: "Yeastar Diagnostics · MilaServ" }] }),
});

function Pill({ ok, label }: { ok: boolean; label: string }) {
  return <Badge variant={ok ? "default" : "destructive"} className="font-normal">{label}: {ok ? "yes" : "no"}</Badge>;
}
function Json({ data }: { data: unknown }) {
  return <pre className="text-xs bg-muted rounded p-3 overflow-auto max-h-[420px]">{JSON.stringify(data, null, 2)}</pre>;
}

function YeastarAdmin() {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

  const configFn = useServerFn(yeastarConfigDiagnostic);
  const authFn = useServerFn(yeastarAuthDiagnostic);
  const groupsFn = useServerFn(yeastarGroupsDiagnostic);
  const analyticsFn = useServerFn(yeastarCallAnalytics);

  const config = useQuery({ queryKey: ["yeastar-config"], queryFn: () => configFn() });
  const auth = useMutation({ mutationFn: () => authFn() });
  const groups = useMutation({ mutationFn: () => groupsFn() });
  const analytics = useMutation({
    mutationFn: () => analyticsFn({ data: { from: yesterday, to: today, team: "all", communicationType: "All" } }),
  });

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-5xl">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Yeastar Integration</h1>
        <p className="text-sm text-muted-foreground">Configuration · Authentication · Call Reports</p>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">1. Configuration</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Pill ok={!!config.data?.baseUrlLoaded} label="YEASTAR_BASE_URL" />
            <Pill ok={!!config.data?.clientIdLoaded} label="YEASTAR_CLIENT_ID" />
            <Pill ok={!!config.data?.clientSecretLoaded} label="YEASTAR_CLIENT_SECRET" />
          </div>
          <Button size="sm" variant="outline" onClick={() => config.refetch()} disabled={config.isFetching}>
            {config.isFetching ? "Checking…" : "Re-check"}
          </Button>
          {config.data ? <Json data={config.data} /> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">2. Authentication</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <Button size="sm" onClick={() => auth.mutate()} disabled={auth.isPending}>
            {auth.isPending ? "Authenticating…" : "Run auth check"}
          </Button>
          {auth.data ? <Json data={auth.data} /> : null}
          {auth.error ? <div className="text-sm text-destructive">{(auth.error as Error).message}</div> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">3. Extension groups</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">Resolves <code>Customer_Care_Emp.</code> and <code>Telesales_Emp.</code> group IDs on the PBX.</p>
          <Button size="sm" onClick={() => groups.mutate()} disabled={groups.isPending}>
            {groups.isPending ? "Resolving…" : "Resolve groups"}
          </Button>
          {groups.data ? <Json data={groups.data} /> : null}
          {groups.error ? <div className="text-sm text-destructive">{(groups.error as Error).message}</div> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">4. Call Reports probe (yesterday → today, all teams)</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <Button size="sm" onClick={() => analytics.mutate()} disabled={analytics.isPending}>
            {analytics.isPending ? "Fetching…" : "Fetch call statistics"}
          </Button>
          {analytics.data ? <Json data={analytics.data} /> : null}
          {analytics.error ? <div className="text-sm text-destructive">{(analytics.error as Error).message}</div> : null}
        </CardContent>
      </Card>
    </div>
  );
}
