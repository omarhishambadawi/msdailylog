import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ShieldAlert } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { hasPerm } from "@/lib/permissions";
import {
  yeastarConfigDiagnostic,
  yeastarAuthDiagnostic,
  yeastarCdrProbe,
  yeastarAgentMappingDiagnostic,
  yeastarEndpointProbe,
  yeastarQueueRoster,
} from "@/lib/yeastar.functions";

export const Route = createFileRoute("/_app/admin/yeastar")({
  component: YeastarAdmin,
  head: () => ({ meta: [{ title: "Yeastar Diagnostics · MilaServ Portal" }] }),
});

function Pill({ ok, label }: { ok: boolean; label: string }) {
  return <Badge variant={ok ? "default" : "destructive"} className="font-normal">{label}: {ok ? "yes" : "no"}</Badge>;
}
function Json({ data }: { data: unknown }) {
  return <pre className="text-xs bg-muted rounded p-3 overflow-auto max-h-[420px]">{JSON.stringify(data, null, 2)}</pre>;
}

function YeastarAdmin() {
  const { role, profile } = useAuth();
  const isAdmin = hasPerm(role, profile?.permissions as any, "view_all_agents");

  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

  const [from, setFrom] = useState(yesterday);
  const [to, setTo] = useState(today);

  const configFn = useServerFn(yeastarConfigDiagnostic);
  const authFn = useServerFn(yeastarAuthDiagnostic);
  const probeFn = useServerFn(yeastarCdrProbe);
  const mapFn = useServerFn(yeastarAgentMappingDiagnostic);
  const capsFn = useServerFn(yeastarEndpointProbe);

  const config = useQuery({ queryKey: ["yeastar-config"], queryFn: () => configFn(), enabled: isAdmin });
  const auth = useMutation({ mutationFn: () => authFn() });
  const probe = useMutation({ mutationFn: () => probeFn({ data: { from, to } }) });
  const map = useMutation({ mutationFn: () => mapFn({ data: { from, to } }) });
  const caps = useMutation({ mutationFn: () => capsFn({ data: { from, to } }) });

  if (!isAdmin) {
    return (
      <div className="text-center py-16">
        <ShieldAlert className="mx-auto h-10 w-10 text-destructive" />
        <p className="mt-2 text-sm text-muted-foreground">You don't have access to Yeastar diagnostics.</p>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-5xl">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Yeastar Integration</h1>
        <p className="text-sm text-muted-foreground">Configuration · Authentication · CDR probe · Agent mapping</p>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">1. Configuration</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Pill ok={!!config.data?.baseUrlLoaded} label="YEASTAR_BASE_URL" />
            <Pill ok={!!config.data?.clientIdLoaded} label="YEASTAR_CLIENT_ID" />
            <Pill ok={!!config.data?.clientSecretLoaded} label="YEASTAR_CLIENT_SECRET" />
            {config.data ? (
              <>
                <Badge variant="outline" className="font-normal">TZ offset: {config.data.utcOffsetMinutes}m</Badge>
                <Badge variant="outline" className="font-normal">Date format: {config.data.datetimeFormat}</Badge>
              </>
            ) : null}
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
        <CardHeader><CardTitle className="text-base">Date window (used by probe + mapping diagnostic)</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="space-y-1"><Label className="text-xs">From</Label><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div className="space-y-1"><Label className="text-xs">To</Label><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">3. CDR probe</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <Button size="sm" onClick={() => probe.mutate()} disabled={probe.isPending}>
            {probe.isPending ? "Fetching…" : "Fetch CDRs for range"}
          </Button>
          {probe.data ? <Json data={probe.data} /> : null}
          {probe.error ? <div className="text-sm text-destructive">{(probe.error as Error).message}</div> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">4. Agent mapping</CardTitle>
          <div className="text-xs text-muted-foreground">
            Set each agent's PBX extension in <span className="font-mono">Users → edit → Yeastar extension</span>. Missing extensions and top unmatched PBX extensions are listed here.
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button size="sm" onClick={() => map.mutate()} disabled={map.isPending}>
            {map.isPending ? "Checking…" : "Run mapping diagnostic"}
          </Button>
          {map.data ? <Json data={map.data} /> : null}
          {map.error ? <div className="text-sm text-destructive">{(map.error as Error).message}</div> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">5. Endpoint capability probe</CardTitle>
          <div className="text-xs text-muted-foreground">
            Verifies which Yeastar OpenAPI endpoints the connected PBX actually exposes on this firmware.
            Read-only. Results feed the decision of whether to wire an endpoint in — nothing else changes based on this.
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button size="sm" onClick={() => caps.mutate()} disabled={caps.isPending}>
            {caps.isPending ? "Probing…" : "Probe endpoints"}
          </Button>
          {caps.data ? (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-2">
                {caps.data.results?.map((r) => (
                  <Badge key={r.endpoint} variant={r.supported ? "default" : "destructive"} className="font-mono text-[11px]">
                    {r.supported ? "✓" : "✗"} {r.endpoint} · {r.httpStatus}{r.errcode !== null ? `/e${r.errcode}` : ""}
                  </Badge>
                ))}
              </div>
              <Json data={caps.data} />
            </div>
          ) : null}
          {caps.error ? <div className="text-sm text-destructive">{(caps.error as Error).message}</div> : null}
        </CardContent>
      </Card>
    </div>
  );
}
