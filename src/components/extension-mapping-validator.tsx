import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CheckCircle2, AlertTriangle, Users, PhoneCall } from "lucide-react";
import { getYeastarExtensionMapping } from "@/lib/yeastar.functions";

export function ExtensionMappingValidator() {
  const fetchMapping = useServerFn(getYeastarExtensionMapping);
  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ["yeastar-extension-mapping"],
    queryFn: () => fetchMapping(),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  if (isLoading) {
    return <Card><CardContent className="p-4 text-sm text-muted-foreground">Loading extension mapping…</CardContent></Card>;
  }
  if (isError || !data) {
    return (
      <Card><CardContent className="p-4 text-sm text-muted-foreground flex justify-between items-center">
        <span>Unable to load extension mapping.</span>
        <button onClick={() => refetch()} className="text-xs font-medium text-primary hover:underline">Retry</button>
      </CardContent></Card>
    );
  }
  if (!data.configured) return null;
  if ("diagnostic" in data && data.diagnostic) {
    return (
      <Card><CardContent className="p-4 text-sm text-muted-foreground">
        PBX not reachable — mapping validator paused.
      </CardContent></Card>
    );
  }
  const d = data as Extract<typeof data, { counts: any }>;

  return (
    <Card>
      <CardHeader className="pb-2 flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base flex items-center gap-2">
          <Users className="h-4 w-4" /> Agent ↔ Extension mapping
        </CardTitle>
        <button onClick={() => refetch()} disabled={isFetching}
          className="text-xs font-medium text-primary hover:underline disabled:opacity-50">
          {isFetching ? "Refreshing…" : "Refresh"}
        </button>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {d.fetchError && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs">
            Failed to fetch extensions from PBX: <span className="font-mono">{d.fetchError}</span>
          </div>
        )}

        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
          <StatBox label="PBX extensions" value={d.counts.pbxExtensions} icon={PhoneCall} />
          <StatBox label="Platform agents" value={d.counts.agents} icon={Users} />
          <StatBox label="Matched" value={d.counts.matched} tone="text-emerald-600 dark:text-emerald-400" icon={CheckCircle2} />
          <StatBox label="Unmatched agents" value={d.counts.unmatchedAgents} tone="text-amber-600 dark:text-amber-400" icon={AlertTriangle} />
          <StatBox label="Unmatched extensions" value={d.counts.unmatchedExtensions} tone="text-amber-600 dark:text-amber-400" icon={AlertTriangle} />
        </div>

        <Section title={`Matched (${d.matched.length})`}>
          {d.matched.length === 0 ? (
            <Empty>No agents are mapped to a PBX extension yet.</Empty>
          ) : (
            <Table headers={["Agent", "Role", "agent_code → PBX #", "PBX name", "Status"]}>
              {d.matched.map((m) => (
                <tr key={m.agentId} className="border-b last:border-0">
                  <td className="px-3 py-1.5 font-medium">{m.agentName || "(unnamed)"}</td>
                  <td className="px-3 py-1.5 text-xs text-muted-foreground">{m.role ?? "—"}</td>
                  <td className="px-3 py-1.5 font-mono text-xs">{m.agentCode}</td>
                  <td className="px-3 py-1.5 text-xs">{m.pbxName ?? "—"}</td>
                  <td className="px-3 py-1.5 text-xs">{m.pbxStatus ?? "—"}</td>
                </tr>
              ))}
            </Table>
          )}
        </Section>

        <Section title={`Unmatched platform agents (${d.unmatchedAgents.length})`}>
          {d.unmatchedAgents.length === 0 ? (
            <Empty>Every agent has a matching PBX extension.</Empty>
          ) : (
            <Table headers={["Agent", "Role", "agent_code", "Reason"]}>
              {d.unmatchedAgents.map((a) => (
                <tr key={a.agentId} className="border-b last:border-0">
                  <td className="px-3 py-1.5 font-medium">{a.agentName || "(unnamed)"}</td>
                  <td className="px-3 py-1.5 text-xs text-muted-foreground">{a.role ?? "—"}</td>
                  <td className="px-3 py-1.5 font-mono text-xs">{a.agentCode ?? "—"}</td>
                  <td className="px-3 py-1.5 text-xs text-amber-600 dark:text-amber-400">{a.reason}</td>
                </tr>
              ))}
            </Table>
          )}
        </Section>

        <Section title={`Unmatched PBX extensions (${d.unmatchedExtensions.length})`}>
          {d.unmatchedExtensions.length === 0 ? (
            <Empty>Every PBX extension is assigned to an agent.</Empty>
          ) : (
            <Table headers={["Extension", "PBX name", "Status"]}>
              {d.unmatchedExtensions.map((e) => (
                <tr key={e.number} className="border-b last:border-0">
                  <td className="px-3 py-1.5 font-mono text-xs">{e.number}</td>
                  <td className="px-3 py-1.5 text-xs">{e.name ?? "—"}</td>
                  <td className="px-3 py-1.5 text-xs">{e.status ?? "—"}</td>
                </tr>
              ))}
            </Table>
          )}
        </Section>

        <p className="text-[11px] text-muted-foreground">
          Set each agent's <code>agent_code</code> in Admin → Users to match a PBX extension number so their calls are counted.
        </p>
      </CardContent>
    </Card>
  );
}

function StatBox({ label, value, tone, icon: Icon }: { label: string; value: number; tone?: string; icon: any }) {
  return (
    <div className="rounded-md border p-2 flex items-center gap-2">
      <Icon className={`h-4 w-4 ${tone ?? "text-muted-foreground"}`} />
      <div className="min-w-0">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground truncate">{label}</div>
        <div className={`text-base font-semibold tabular-nums ${tone ?? ""}`}>{value}</div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs font-medium text-muted-foreground mb-1">{title}</div>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground text-center">{children}</div>;
}

function Table({ headers, children }: { headers: string[]; children: React.ReactNode }) {
  return (
    <div className="rounded-md border overflow-hidden overflow-x-auto max-h-72">
      <table className="w-full text-sm">
        <thead className="bg-muted/40">
          <tr className="text-left text-xs text-muted-foreground">
            {headers.map((h) => <th key={h} className="px-3 py-1.5 font-medium">{h}</th>)}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
