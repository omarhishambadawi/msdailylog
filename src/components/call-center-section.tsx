/**
 * Call Center Performance — direct CDR → per-agent attribution
 * (see src/lib/yeastar/cdr.server.ts + stats.server.ts).
 *
 * Consumes the dashboard's Date, Team, and Agent filters. All KPI cards,
 * charts, and the per-agent table are populated from the same server
 * response, so filter changes immediately refresh every widget.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, PhoneOff } from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, CartesianGrid,
  PieChart, Pie, Cell, Legend, LineChart, Line,
} from "recharts";
import { getAgentCallStats } from "@/lib/yeastar.functions";
import { useAuth } from "@/lib/auth";
import { hasPerm } from "@/lib/permissions";

type Team = "all" | "customer_care" | "telesales";

interface Props {
  from: string;
  to: string;
  team: Team;
  /** Platform agent user id (from profiles) or "all" */
  agentId: string;
}

const CHART_COLORS = [
  "hsl(var(--chart-1))", "hsl(var(--chart-2))",
  "hsl(var(--chart-3))", "hsl(var(--chart-4))", "hsl(var(--chart-5))",
];

export function CallCenterSection({ from, to, team, agentId }: Props) {
  const { role, profile } = useAuth();
  const canViewAllAgents = hasPerm(role, profile?.permissions as any, "view_all_agents");
  const isAdmin = canViewAllAgents;

  const callsFn = useServerFn(getAgentCallStats);
  const q = useQuery({
    queryKey: ["yeastar-agent-stats", from, to, team, agentId],
    queryFn: () => callsFn({
      data: {
        from, to, team,
        agentId: canViewAllAgents && agentId !== "all" ? agentId : null,
      },
    }),
    staleTime: 60_000,
  });

  const data = q.data;
  const isLoading = q.isPending;
  const ok = data && data.ok === true;
  const configured = !data || (data as any).configured !== false;
  const errored = !!data && data.ok === false;
  const errorMessage = errored
    ? (configured
      ? "Call analytics are temporarily unavailable. Please try again in a moment."
      : "Call analytics are not configured yet.")
    : null;

  const totals = ok ? data.totals : null;
  const agents = ok ? data.agents : [];
  const byDay = ok ? data.byDay : [];
  const unmatched = ok ? data.unmatched : null;
  const cdrMeta = ok ? data.cdr : null;

  const hasCalls = !!totals && totals.total > 0;
  const showEmpty = ok && !hasCalls;

  const byTeamData = useMemo(() => {
    const acc: Record<string, number> = { customer_care: 0, telesales: 0 };
    agents.forEach((a) => { acc[a.team] = (acc[a.team] ?? 0) + a.total; });
    return [
      { name: "Customer Care", value: acc.customer_care ?? 0 },
      { name: "Telesales", value: acc.telesales ?? 0 },
    ];
  }, [agents]);

  const topAgents = useMemo(() => agents.slice(0, 12).map((a) => ({
    name: a.name || a.ext,
    total: a.total, answered: a.answered, missed: a.missed,
  })), [agents]);

  const inOut = totals
    ? [{ name: "Inbound", value: totals.inbound }, { name: "Outbound", value: totals.outbound }]
    : [];
  const ansMiss = totals
    ? [{ name: "Answered", value: totals.answered }, { name: "Missed", value: totals.missed }]
    : [];

  return (
    <div className="space-y-3">
      {/* Header line */}
      <div className="text-sm text-muted-foreground">
        {team === "all" ? "Customer Care + Telesales" : team === "customer_care" ? "Customer Care" : "Telesales"} · {from} → {to}
      </div>

      {/* Admin-only diagnostics banner */}
      {isAdmin && cdrMeta ? (
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          <Badge variant="outline" className="font-normal">
            CDR fetched {cdrMeta.fetched.toLocaleString()}
            {cdrMeta.totalReported != null ? ` / ${cdrMeta.totalReported.toLocaleString()}` : ""}
          </Badge>
          <Badge variant="outline" className="font-normal">Path: {cdrMeta.path}</Badge>
          {unmatched && unmatched.records > 0 ? (
            <Badge variant="outline" className="font-normal">Unmatched: {unmatched.records.toLocaleString()}</Badge>
          ) : null}
          {cdrMeta.truncated ? (
            <Badge variant="destructive" className="font-normal gap-1">
              <AlertTriangle className="h-3 w-3" />
              CDR truncated — narrow the range
            </Badge>
          ) : null}
        </div>
      ) : null}

      {/* Friendly error */}
      {errorMessage ? (
        <Card>
          <CardContent className="p-4 text-sm text-muted-foreground flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-destructive shrink-0" />
            {errorMessage}
          </CardContent>
        </Card>
      ) : null}

      {/* KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 sm:gap-3">
        <Kpi label="Total calls" value={totals?.total ?? 0} loading={isLoading} />
        <Kpi label="Answered" value={totals?.answered ?? 0} accent="text-green-600 dark:text-green-400" loading={isLoading} />
        <Kpi label="Missed" value={totals?.missed ?? 0} accent="text-red-600 dark:text-red-400" loading={isLoading} />
        <Kpi label="Inbound" value={totals?.inbound ?? 0} loading={isLoading} />
        <Kpi label="Outbound" value={totals?.outbound ?? 0} loading={isLoading} />
        <Kpi label="Answer rate" value={`${totals ? totals.answerRate.toFixed(1) : "0.0"}%`} accent="text-green-600 dark:text-green-400" loading={isLoading} />
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 sm:gap-3">
        <Kpi label="Total talk time" value={formatDuration(totals?.talkSeconds ?? 0)} loading={isLoading} />
        <Kpi label="Agents with calls" value={agents.length} loading={isLoading} />
        <Kpi label="Unmatched calls" value={unmatched?.records ?? 0} loading={isLoading} />
      </div>

      {showEmpty ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground flex flex-col items-center gap-2">
            <PhoneOff className="h-6 w-6" />
            <div>No calls recorded for {team === "all" ? "any mapped agent" : team === "customer_care" ? "Customer Care" : "Telesales"} between {from} and {to}.</div>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Charts */}
          <div className="grid lg:grid-cols-2 gap-3 sm:gap-4">
            <ChartCard title="Calls by team" loading={isLoading}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={byTeamData}>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--color-border)" />
                  <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                  <Tooltip />
                  <Bar dataKey="value" name="Calls" fill={CHART_COLORS[0]} radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Inbound vs outbound" loading={isLoading}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={inOut} dataKey="value" nameKey="name" outerRadius={70} label>
                    {inOut.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                  </Pie>
                  <Legend /><Tooltip />
                </PieChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Answered vs missed" loading={isLoading}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={ansMiss} dataKey="value" nameKey="name" outerRadius={70} label>
                    <Cell fill="#16a34a" /><Cell fill="#dc2626" />
                  </Pie>
                  <Legend /><Tooltip />
                </PieChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Top agents by call volume" loading={isLoading}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={topAgents} layout="vertical">
                  <CartesianGrid horizontal={false} strokeDasharray="3 3" stroke="var(--color-border)" />
                  <XAxis type="number" tick={{ fontSize: 11 }} allowDecimals={false} />
                  <YAxis type="category" dataKey="name" width={130} tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Bar dataKey="answered" name="Answered" stackId="a" fill="#16a34a" />
                  <Bar dataKey="missed" name="Missed" stackId="a" fill="#dc2626" />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
          </div>

          {/* Daily trend */}
          <ChartCard title="Daily call volume" loading={isLoading} height="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={byDay}>
                <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip /><Legend />
                <Line type="monotone" dataKey="total" name="Total" stroke={CHART_COLORS[0]} strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="answered" name="Answered" stroke="#16a34a" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="missed" name="Missed" stroke="#dc2626" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>

          {/* Per-agent table */}
          <Card>
            <CardHeader><CardTitle className="text-base">Calls by agent</CardTitle></CardHeader>
            <CardContent className="p-0 overflow-x-auto">
              {isLoading ? (
                <div className="p-4 space-y-2">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Skeleton key={i} className="h-8 w-full" />
                  ))}
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th className="px-3 py-2">Ext.</th>
                      <th className="px-3 py-2">Agent</th>
                      <th className="px-3 py-2">Team</th>
                      <th className="px-3 py-2 text-right">Total</th>
                      <th className="px-3 py-2 text-right">Answered</th>
                      <th className="px-3 py-2 text-right">Missed</th>
                      <th className="px-3 py-2 text-right">Inbound</th>
                      <th className="px-3 py-2 text-right">Outbound</th>
                      <th className="px-3 py-2 text-right">Answer %</th>
                      <th className="px-3 py-2 text-right">Talk time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {agents.length === 0 ? (
                      <tr><td colSpan={10} className="text-center text-muted-foreground py-6">No agents matched.</td></tr>
                    ) : null}
                    {agents.map((a) => (
                      <tr key={a.agentId} className="border-b last:border-0">
                        <td className="px-3 py-2 font-mono text-xs">{a.ext}</td>
                        <td className="px-3 py-2 font-medium">{a.name}</td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">
                          {a.team === "customer_care" ? "Customer Care" : "Telesales"}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{a.total}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-green-600 dark:text-green-400">{a.answered}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-red-600 dark:text-red-400">{a.missed}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{a.inbound}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{a.outbound}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{a.answerRate.toFixed(1)}%</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatDuration(a.talkSeconds)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>

          {/* Unmatched extensions (admin only) */}
          {isAdmin && unmatched && unmatched.extensions.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Unmatched extensions</CardTitle>
                <div className="text-xs text-muted-foreground">
                  {unmatched.records.toLocaleString()} calls didn't match any active Customer Care / Telesales agent (queues, admin lines, IVRs, or missing Yeastar extension in the profile).
                </div>
              </CardHeader>
              <CardContent className="p-0 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th className="px-3 py-2">Extension</th>
                      <th className="px-3 py-2 text-right">Calls</th>
                    </tr>
                  </thead>
                  <tbody>
                    {unmatched.extensions.map((u) => (
                      <tr key={u.ext} className="border-b last:border-0">
                        <td className="px-3 py-2 font-mono text-xs">{u.ext}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{u.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          ) : null}
        </>
      )}
    </div>
  );
}

function Kpi({ label, value, accent, loading }: { label: string; value: string | number; accent?: string; loading?: boolean }) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">{label}</div>
      {loading
        ? <Skeleton className="mt-2 h-6 w-16" />
        : <div className={`mt-1 text-xl font-bold tabular-nums leading-tight ${accent ?? ""}`}>{value}</div>}
    </div>
  );
}

function ChartCard({
  title, loading, height = "h-56", children,
}: {
  title: string; loading?: boolean; height?: string; children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">{title}</CardTitle></CardHeader>
      <CardContent className={height}>
        {loading ? <Skeleton className="h-full w-full" /> : children}
      </CardContent>
    </Card>
  );
}

function formatDuration(sec: number): string {
  if (!sec || sec <= 0) return "0s";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}h ${m}m`;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}
