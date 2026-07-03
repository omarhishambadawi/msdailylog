import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  yeastarConfigDiagnostic,
  yeastarAuthDiagnostic,
  yeastarMappingList,
  yeastarMappingDiagnostic,
  yeastarMappingImport,
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
  const qc = useQueryClient();

  const configFn = useServerFn(yeastarConfigDiagnostic);
  const authFn = useServerFn(yeastarAuthDiagnostic);
  const mapListFn = useServerFn(yeastarMappingList);
  const mapDiagFn = useServerFn(yeastarMappingDiagnostic);
  const mapImportFn = useServerFn(yeastarMappingImport);
  const analyticsFn = useServerFn(yeastarCallAnalytics);

  const config = useQuery({ queryKey: ["yeastar-config"], queryFn: () => configFn() });
  const mapList = useQuery({ queryKey: ["yeastar-mapping-list"], queryFn: () => mapListFn() });
  const auth = useMutation({ mutationFn: () => authFn() });
  const mapDiag = useMutation({ mutationFn: () => mapDiagFn() });
  const analytics = useMutation({
    mutationFn: () => analyticsFn({ data: { from: yesterday, to: today, team: "all", communicationType: "All" } }),
  });

  const [csv, setCsv] = useState("");
  const [replace, setReplace] = useState(true);
  const importMut = useMutation({
    mutationFn: () => mapImportFn({ data: { csv, replace } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["yeastar-mapping-list"] });
    },
  });

  const rows = mapList.data?.rows ?? [];
  const byTeam = rows.reduce(
    (acc, r) => { if (r.team === "customer_care") acc.cc++; else if (r.team === "telesales") acc.ts++; return acc; },
    { cc: 0, ts: 0 },
  );

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-5xl">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Yeastar Integration</h1>
        <p className="text-sm text-muted-foreground">Configuration · Authentication · Extension Mapping · Call Reports</p>
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
        <CardHeader><CardTitle className="text-base">3. Extension mapping</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge variant="secondary" className="font-normal">Total: {rows.length}</Badge>
            <Badge variant="secondary" className="font-normal">Customer Care: {byTeam.cc}</Badge>
            <Badge variant="secondary" className="font-normal">Telesales: {byTeam.ts}</Badge>
            <Button size="sm" variant="outline" onClick={() => mapList.refetch()} disabled={mapList.isFetching}>
              {mapList.isFetching ? "Loading…" : "Reload"}
            </Button>
            <Button size="sm" onClick={() => mapDiag.mutate()} disabled={mapDiag.isPending}>
              {mapDiag.isPending ? "Checking PBX…" : "Diagnose (compare with PBX)"}
            </Button>
          </div>

          <div className="space-y-2">
            <div className="text-xs text-muted-foreground">
              Paste CSV rows: <code>ext_num,agent_name,team</code>. Team must be <code>customer_care</code> or <code>telesales</code>. A header row is optional.
            </div>
            <Textarea
              rows={8}
              value={csv}
              onChange={(e) => setCsv(e.target.value)}
              placeholder={`ext_num,agent_name,team\n1001,Ahmed Ali,customer_care\n1002,Sara Khan,telesales`}
              className="font-mono text-xs"
            />
            <div className="flex items-center gap-3">
              <label className="text-xs flex items-center gap-2">
                <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
                Replace all existing mappings
              </label>
              <Button size="sm" onClick={() => importMut.mutate()} disabled={importMut.isPending || !csv.trim()}>
                {importMut.isPending ? "Importing…" : "Import mapping"}
              </Button>
            </div>
            {importMut.data ? <Json data={importMut.data} /> : null}
          </div>

          {mapDiag.data ? <Json data={mapDiag.data} /> : null}

          {rows.length > 0 ? (
            <div className="border rounded-md overflow-auto max-h-[360px]">
              <table className="w-full text-xs">
                <thead className="bg-muted sticky top-0">
                  <tr>
                    <th className="text-left p-2">Ext</th>
                    <th className="text-left p-2">Agent</th>
                    <th className="text-left p-2">Team</th>
                    <th className="text-left p-2">Agent Code</th>
                    <th className="text-left p-2">Active</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.ext_num} className="border-t">
                      <td className="p-2 font-mono">{r.ext_num}</td>
                      <td className="p-2">{r.agent_name}</td>
                      <td className="p-2">{r.team}</td>
                      <td className="p-2 font-mono">{r.agent_code ?? "—"}</td>
                      <td className="p-2">{r.active ? "yes" : "no"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
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
