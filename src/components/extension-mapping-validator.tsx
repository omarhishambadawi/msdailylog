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
          <Users className="h-4 w-4" /> Agent ↔ Extension whitelist
        </CardTitle>
        <button onClick={() => refetch()} disabled={isFetching}
          className="text-xs font-medium text-primary hover:underline disabled:opacity-50">
          {isFetching ? "Refreshing…" : "Refresh"}
        </button>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="text-xs text-muted-foreground">
          Analytics use a fixed extension whitelist (Yeastar firmware doesn't expose Extension Groups via OpenAPI). Edit
          <code className="mx-1 px-1 rounded bg-muted">EXTENSION_WHITELIST</code> in
          <code className="ml-1 px-1 rounded bg-muted">src/lib/yeastar.server.ts</code> to change membership.
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2">
          <StatBox label="Customer Care" value={d.counts.customerCare} icon={PhoneCall} />
          <StatBox label="Telesales" value={d.counts.telesales} icon={PhoneCall} />
          <StatBox label="Admin" value={d.counts.admin} icon={Users} />
          <StatBox label="Whitelist total" value={d.counts.whitelist} icon={PhoneCall} />
          <StatBox label="Matched agents" value={d.counts.matched} tone="text-emerald-600 dark:text-emerald-400" icon={CheckCircle2} />
          <StatBox label="Unmatched" value={d.counts.unmatched} tone="text-amber-600 dark:text-amber-400" icon={AlertTriangle} />
        </div>

        <Section title={`Whitelist (${d.whitelistRows.length})`}>
          <Table headers={["PBX #", "Name", "Role", "Expected agent_code", "Matched platform user", "Match"]}>
            {d.whitelistRows.map((r) => (
              <tr key={r.pbxNumber} className="border-b last:border-0">
                <td className="px-3 py-1.5 font-mono text-xs">{r.pbxNumber}</td>
                <td className="px-3 py-1.5 text-xs">{r.pbxName}</td>
                <td className="px-3 py-1.5 text-xs">
                  {r.role === "customer_care" ? "Customer Care" : r.role === "telesales" ? "Telesales" : "Admin"}
                </td>
                <td className="px-3 py-1.5 font-mono text-xs">{r.expectedAgentCode}</td>
                <td className="px-3 py-1.5 text-xs">{r.matchedAgentName ?? <span className="text-muted-foreground">—</span>}</td>
                <td className="px-3 py-1.5 text-xs">
                  {r.matches
                    ? <span className="text-emerald-600 dark:text-emerald-400 inline-flex items-center gap-1"><CheckCircle2 className="h-3 w-3"/>Matched</span>
                    : <span className="text-amber-600 dark:text-amber-400 inline-flex items-center gap-1"><AlertTriangle className="h-3 w-3"/>No platform user</span>}
                </td>
              </tr>
            ))}
          </Table>
        </Section>

        <p className="text-[11px] text-muted-foreground">
          Set each platform user's <code>agent_code</code> in Admin → Users to match the whitelisted extension number so their calls are counted.
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
