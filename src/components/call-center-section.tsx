/**
 * Call Center Performance — sourced entirely from the OpenAPI CDR feed
 * (see src/lib/yeastar/reports.server.ts).
 *
 * Consumes the dashboard's Date, Team, and Agent filters. All KPI cards,
 * charts, and the per-agent table are populated from the same server
 * response, so filter changes immediately refresh every widget.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, PhoneOff } from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, CartesianGrid,
  PieChart, Pie, Cell, Legend, LineChart, Line,
} from "recharts";
import { yeastarCallAnalytics, yeastarDailyVolume } from "@/lib/yeastar.functions";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { hasPerm } from "@/lib/permissions";

type Team = "all" | "customer_care" | "telesales";
type Comm = "All" | "Inbound" | "Outbound";

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
  const [comm, setComm] = useState<Comm>("All");
  const { role, profile } = useAuth();
  const isAdmin = hasPerm(role, profile?.permissions as any, "view_all_agents");

  // Map platform agentId -> agent_code (equals PBX extension number).
  const { data: agentCode } = useQuery({
    queryKey: ["profile-agent-code", agentId],
    enabled: agentId !== "all",
    queryFn: async () => {
      const { data } = await supabase
        .from("profiles").select("agent_code")
        .eq("id", agentId).maybeSingle();
      return data?.agent_code ?? null;
    },
  });

  const analyticsFn = useServerFn(yeastarCallAnalytics);
  const dailyFn = useServerFn(yeastarDailyVolume);

  const analytics = useQuery({
    queryKey: ["yeastar-analytics", from, to, team, comm, agentCode ?? "all"],
    queryFn: () => analyticsFn({
      data: { from, to, team, communicationType: comm, agentCode: agentCode ?? undefined },
    }),
    staleTime: 30_000,
  });
  const daily = useQuery({
    queryKey: ["yeastar-daily", from, to, team, comm],
    queryFn: () => dailyFn({ data: { from, to, team, communicationType: comm } }),
    staleTime: 30_000,
  });

  const data = analytics.data;
  const ok = data && data.ok === true;
  const configured = !data || (data as any).configured !== false;
  const errored = !!data && data.ok === false;
  const errorMessage = errored
    ? (configured
      ? "Call analytics are temporarily unavailable. Please try again in a moment."
      : "Call analytics are not configured yet.")
    : null;

  const totals = ok ? data.totals : null;
  const rows = ok ? data.rows : [];
  const cdrMeta = ok ? data.cdr : null;
  const mappingMeta = ok ? data.mapping : null;

  const isLoading = analytics.isPending;
  const hasCalls = !!totals && totals.total > 0;
  const showEmpty = ok && !hasCalls;

  const byTeam = useMemo(() => {
    const acc = { customer_care: 0, telesales: 0 } as Record<string, number>;
    rows.forEach((r) => { acc[r.group] = (acc[r.group] ?? 0) + r.total; });
    return [
      { name: "Customer Care", value: acc.customer_care ?? 0 },
      { name: "Telesales", value: acc.telesales ?? 0 },
    ];
  }, [rows]);

  const topAgents = useMemo(() => rows.slice(0, 12).map((r) => ({
    name: r.ext_name || r.ext_num,
    total: r.total, answered: r.answered, missed: r.missed,
  })), [rows]);

  const inOut = totals
    ? [{ name: "Inbound", value: totals.inbound }, { name: "Outbound", value: totals.outbound }]
    : [];
  const ansMiss = totals
    ? [{ name: "Answered", value: totals.answered }, { name: "Missed", value: totals.missed }]
    : [];

  return (
    <div className="space-y-3">
      {/* Header + filter toggle */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="text-sm text-muted-foreground">
          {agentCode ? <>Agent extension <span className="font-mono">{agentCode}</span> · </> : null}
          {team === "all" ? "Customer Care + Telesales" : team === "customer_care" ? "Customer Care" : "Telesales"} · {from} → {to}
        </div>
        <Tabs value={comm} onValueChange={(v) => setComm(v as Comm)}>
          <TabsList className="h-8">
            <TabsTrigger value="All" className="text-xs">All</TabsTrigger>
            <TabsTrigger value="Inbound" className="text-xs">Inbound</TabsTrigger>
            <TabsTrigger value="Outbound" className="text-xs">Outbound</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {/* Admin-only diagnostics banner */}
      {isAdmin && cdrMeta ? (
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          <Badge variant="outline" className="font-normal">
            CDR rows {cdrMeta.rowsFetched.toLocaleString()} · {cdrMeta.pagesFetched} pages
          </Badge>
          <Badge variant="outline" className="font-normal">
            Attributed {cdrMeta.rowsAttributed.toLocaleString()}
          </Badge>
          {mappingMeta ? (
            <Badge variant="outline" className="font-normal">
              Mapped ext. {mappingMeta.mappedExtensions}
              {mappingMeta.missingOnPbx.length ? ` · missing on PBX: ${mappingMeta.missingOnPbx.length}` : ""}
            </Badge>
          ) : null}
          {cdrMeta.truncated ? (
            <Badge variant="destructive" className="font-normal gap-1">
              <AlertTriangle className="h-3 w-3" />
              CDR truncated at {cdrMeta.pagesFetched * cdrMeta.pageSize} rows — narrow the range
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
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2 sm:gap-3">
        <Kpi label="Total calls" value={totals?.total ?? 0} loading={isLoading} />
        <Kpi label="Answered" value={totals?.answered ?? 0} accent="text-green-600 dark:text-green-400" loading={isLoading} />
        <Kpi label="Missed" value={totals?.missed ?? 0} accent="text-red-600 dark:text-red-400" loading={isLoading} />
        <Kpi label="Inbound" value={totals?.inbound ?? 0} loading={isLoading} />
        <Kpi label="Outbound" value={totals?.outbound ?? 0} loading={isLoading} />
        <Kpi label="Answer rate" value={`${totals?.answerRate ?? 0}%`} accent="text-green-600 dark:text-green-400" loading={isLoading} />
        <Kpi label="Missed rate" value={`${totals?.missedRate ?? 0}%`} accent="text-red-600 dark:text-red-400" loading={isLoading} />
        <Kpi label="Avg talk" value={formatDuration(totals?.avgTalkSec ?? 0)} loading={isLoading} />
      </div>

      {/* Empty state — covers charts + table when there are truly no calls */}
      {showEmpty ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground flex flex-col items-center gap-2">
            <PhoneOff className="h-6 w-6" />
            <div>No calls recorded for {team === "all" ? "any mapped extension" : team === "customer_care" ? "Customer Care" : "Telesales"} between {from} and {to}.</div>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Charts */}
          <div className="grid lg:grid-cols-2 gap-3 sm:gap-4">
            <ChartCard title="Calls by team" loading={isLoading}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={byTeam}>
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

          {/* Daily volume */}
          <ChartCard title="Daily call volume" loading={daily.isPending} height="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={daily.data?.series ?? []}>
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
                    {rows.length === 0 ? (
                      <tr><td colSpan={10} className="text-center text-muted-foreground py-6">No agents matched.</td></tr>
                    ) : null}
                    {rows.map((r) => (
                      <tr key={r.ext_num} className="border-b last:border-0">
                        <td className="px-3 py-2 font-mono text-xs">{r.ext_num}</td>
                        <td className="px-3 py-2 font-medium">{r.ext_name}</td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">
                          {r.group === "customer_care" ? "Customer Care" : r.group === "telesales" ? "Telesales" : "—"}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.total}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-green-600 dark:text-green-400">{r.answered}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-red-600 dark:text-red-400">{r.missed}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.inbound}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.outbound}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.answerRate}%</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatDuration(r.talkTimeSec)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
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
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m`;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}
