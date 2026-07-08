/**
 * Call Center Analytics — MilaServ Portal
 * Single unified executive dashboard. Queue-aware, order-joined,
 * Internal calls excluded, monthly default.
 */
import { createFileRoute } from "@tanstack/react-router";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useRef, useState } from "react";
import { format, startOfMonth } from "date-fns";
import type { DateRange } from "react-day-picker";
import {
  BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, CartesianGrid,
  LineChart, Line, Legend,
} from "recharts";
// xlsx is lazy-loaded inside the export handler to keep it out of the initial route chunk.
import {
  Download, ShieldAlert, PhoneOff, AlertTriangle, Printer, PhoneIncoming, PhoneOutgoing, Clock, Users, TrendingUp,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { hasPerm } from "@/lib/permissions";
import { getCallCenterAnalytics } from "@/lib/yeastar.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { DateRangePicker } from "@/components/date-range-picker";
import { cn } from "@/lib/utils";
import { fmtSAR } from "@/lib/branches";

export const Route = createFileRoute("/_app/call-center")({
  head: () => ({ meta: [{ title: "Call Center Analytics — MilaServ Portal" }] }),
  component: CallCenterPage,
});

const toISO = (d: Date) => format(d, "yyyy-MM-dd");

type Team = "all" | "customer_care" | "telesales";
type Direction = "all" | "Inbound" | "Outbound";

function CallCenterPage() {
  const { role, profile } = useAuth();
  const canView = hasPerm(role, profile?.permissions as any, "view_call_center")
    || hasPerm(role, profile?.permissions as any, "view_team_analytics")
    || hasPerm(role, profile?.permissions as any, "view_dashboard");
  const canAll = hasPerm(role, profile?.permissions as any, "view_all_agents");
  const canExport = hasPerm(role, profile?.permissions as any, "export_reports");

  // Default: current month
  const today = new Date();
  const [range, setRange] = useState<DateRange | undefined>({ from: startOfMonth(today), to: today });
  const [team, setTeam] = useState<Team>("all");
  const [agentId, setAgentId] = useState<string>("all");
  const [direction, setDirection] = useState<Direction>("all");
  const [search, setSearch] = useState("");

  const from = range?.from ? toISO(range.from) : toISO(startOfMonth(today));
  const to = range?.to ? toISO(range.to) : from;

  // Agents dropdown (admin only)
  const { data: agents } = useQuery({
    queryKey: ["cc-agents"],
    queryFn: async () => {
      const [{ data: profiles }, { data: roles }] = await Promise.all([
        supabase.from("profiles").select("id,full_name,agent_code").order("full_name"),
        supabase.from("user_roles").select("user_id,role"),
      ]);
      const rm = new Map((roles ?? []).map((r: any) => [r.user_id, r.role]));
      return (profiles ?? []).map((p: any) => ({ ...p, role: rm.get(p.id) ?? null }))
        .filter((a: any) => a.role === "customer_care" || a.role === "telesales");
    },
    enabled: canAll,
    staleTime: 5 * 60_000,
  });
  const filteredAgents = useMemo(() => {
    if (!agents) return [];
    return team === "all" ? agents : agents.filter((a: any) => a.role === team);
  }, [agents, team]);

  // Progress job id (rotates per query)
  const jobIdRef = useRef<string>("");
  const [jobId, setJobId] = useState<string>("");
  useEffect(() => {
    const id = crypto.randomUUID();
    jobIdRef.current = id;
    setJobId(id);
  }, [from, to, team, agentId, direction]);

  // Analytics query — one call feeds every section
  const analyticsFn = useServerFn(getCallCenterAnalytics);
  const q = useQuery({
    queryKey: ["cc-analytics", from, to, team, agentId, direction],
    queryFn: () => analyticsFn({
      data: {
        from, to, team,
        agentId: canAll && agentId !== "all" ? agentId : null,
        direction, status: "all",
        includeOrders: true,
        jobId: jobIdRef.current,
      },
    }),
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
  });

  // Survey removed — Satisfaction Survey section discontinued.


  // Progress polling
  const [progress, setProgress] = useState<{ percent: number; message: string } | null>(null);
  useEffect(() => {
    if (!q.isFetching || !jobId) { setProgress(null); return; }
    let stop = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/public/cdr-progress/${jobId}`, { cache: "no-store" });
        if (!res.ok) return;
        const j = await res.json();
        if (!stop) setProgress({ percent: j.percent ?? 0, message: j.message ?? "Loading…" });
      } catch { /* ignore */ }
    };
    tick();
    const iv = setInterval(tick, 800);
    return () => { stop = true; clearInterval(iv); };
  }, [q.isFetching, jobId]);

  if (!canView) {
    return (
      <div className="text-center py-16">
        <ShieldAlert className="mx-auto h-10 w-10 text-destructive" />
        <p className="mt-2 text-sm text-muted-foreground">You don't have access to Call Center Analytics.</p>
      </div>
    );
  }

  const data = q.data;
  const ok = data && data.ok === true;
  const configured = !data || (data as any).configured !== false;
  const isLoading = q.isPending;
  const errored = (data && data.ok === false) || !!q.error;
  const errMsg = q.error instanceof Error ? q.error.message
    : errored ? (configured ? "Call analytics are temporarily unavailable." : "Call analytics are not configured yet.") : null;

  const totals = ok ? data.totals : null;
  const rows = ok ? data.agents : [];
  const byDay = ok ? data.byDay : [];
  const byHour = ok ? data.byHour : [];
  const teamCompare = ok ? data.teamCompare : [];
  const conv = ok ? data.conversion : null;

  const hourly12 = useMemo(() => byHour.map((h) => ({
    ...h,
    label: hourLabel(h.hour),
  })), [byHour]);

  const searchedAgents = useMemo(() => {
    if (!search.trim()) return rows;
    const s = search.toLowerCase();
    return rows.filter((r) => r.name.toLowerCase().includes(s) || r.ext.toLowerCase().includes(s));
  }, [rows, search]);

  const doExport = async () => {
    if (!ok || !totals) return;
    const XLSX = await import("xlsx");
    const kpiSheet = [
      { Metric: "Total calls", Value: totals.total },
      { Metric: "Answered", Value: totals.answered },
      { Metric: "Missed (queue)", Value: totals.missed },
      { Metric: "Abandoned", Value: totals.abandoned },
      { Metric: "No-answer outbound", Value: totals.noAnswerOutbound },
      { Metric: "Inbound", Value: totals.inbound },
      { Metric: "Outbound", Value: totals.outbound },
      { Metric: "Answer rate %", Value: totals.answerRate.toFixed(2) },
      { Metric: "Avg talking", Value: hhmmss(totals.avgTalkSec) },
      { Metric: "Avg waiting", Value: hhmmss(totals.avgWaitSec) },
      { Metric: "Total talk", Value: hhmmss(totals.talkSeconds) },
      { Metric: "Conversion rate %", Value: (conv?.overall.conversionRate ?? 0).toFixed(2) },
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(kpiSheet), "KPIs");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "Agents");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(byDay), "By day");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(hourly12), "By hour");
    if (conv) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(conv.perAgent), "Conversion by agent");
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(conv.perDay), "Conversion by day");
    }
    XLSX.writeFile(wb, `call-center-${from}_${to}.xlsx`);
  };


  return (
    <div className="space-y-6 print:space-y-3">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">Call Center Analytics</h1>
          <p className="text-xs sm:text-sm text-muted-foreground truncate">
            {team === "all" ? "All teams" : team === "customer_care" ? "Customer Care" : "Telesales"} · {from} → {to}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 print:hidden">
          <DateRangePicker range={range} onChange={setRange} align="end" size="sm" />
          <Select value={team} onValueChange={(v) => { setTeam(v as Team); setAgentId("all"); }}>
            <SelectTrigger className="h-9 w-[150px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All teams</SelectItem>
              <SelectItem value="customer_care">Customer Care</SelectItem>
              <SelectItem value="telesales">Telesales</SelectItem>
            </SelectContent>
          </Select>
          {canAll && (
            <Select value={agentId} onValueChange={setAgentId}>
              <SelectTrigger className="h-9 w-[190px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All agents</SelectItem>
                {filteredAgents.map((a: any) => (
                  <SelectItem key={a.id} value={a.id}>{a.full_name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Select value={direction} onValueChange={(v) => setDirection(v as Direction)}>
            <SelectTrigger className="h-9 w-[130px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Both</SelectItem>
              <SelectItem value="Inbound">Inbound</SelectItem>
              <SelectItem value="Outbound">Outbound</SelectItem>
            </SelectContent>
          </Select>
          {canExport && (
            <>
              <Button variant="outline" size="sm" onClick={doExport} disabled={!ok}>
                <Download className="h-4 w-4 mr-2" />Excel
              </Button>
              <Button variant="outline" size="sm" onClick={() => window.print()} disabled={!ok}>
                <Printer className="h-4 w-4 mr-2" />PDF
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Progress bar — shows during any fetch so users get feedback on re-queries too */}
      {q.isFetching && (
        <Card className="border-primary/30 bg-primary/5">
          <CardContent className="p-4 space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium text-foreground">{progress?.message ?? (q.data ? "Refreshing analytics…" : "Loading call records…")}</span>
              <span className="tabular-nums text-muted-foreground">{progress?.percent ?? (q.data ? 60 : 0)}%</span>
            </div>
            <Progress value={progress?.percent ?? (q.data ? 60 : 5)} />
          </CardContent>
        </Card>
      )}

      {errMsg && (
        <Card>
          <CardContent className="p-4 text-sm text-muted-foreground flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-destructive shrink-0" />
            {errMsg}
          </CardContent>
        </Card>
      )}

      {/* HERO KPIs */}
      <SectionHeader>Overview</SectionHeader>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <HeroKpi label="Total calls" value={totals?.total ?? 0} loading={isLoading} icon={Users} tone="primary" />
        <HeroKpi label="Answered calls" value={totals?.answered ?? 0} loading={isLoading} icon={PhoneIncoming} tone="success" />
        <HeroKpi label="Answer rate" value={pct(totals?.answerRate)} loading={isLoading} icon={TrendingUp} tone="success" />
        <HeroKpi label="Conversion rate" value={pct(totals?.total ? ((conv?.overall.orders ?? 0) / totals.total) * 100 : 0)} loading={isLoading} icon={PhoneOutgoing} tone="secondary" hint="Total orders ÷ total calls" />
      </div>

      {/* QUEUE STATS */}
      <SectionHeader>Queue statistics</SectionHeader>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Kpi label="Missed calls (queue)" value={totals?.missed ?? 0} tone="destructive" loading={isLoading} hint="Inbound not answered within ring window" />
        <Kpi label="Abandoned calls" value={totals?.abandoned ?? 0} tone="warning" loading={isLoading} hint="Inbound hung up before ring threshold" />
        <Kpi label="No-answer outbound" value={totals?.noAnswerOutbound ?? 0} loading={isLoading} hint="Customer did not pick up (not a missed call)" />
      </div>

      {/* DIRECTION */}
      <SectionHeader>Call direction</SectionHeader>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Kpi label="Inbound calls" value={totals?.inbound ?? 0} tone="success" loading={isLoading} icon={PhoneIncoming} />
        <Kpi label="Outbound calls" value={totals?.outbound ?? 0} tone="secondary" loading={isLoading} icon={PhoneOutgoing} />
      </div>

      {/* TIME METRICS */}
      <SectionHeader>Time metrics</SectionHeader>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Kpi label="Average talking time" value={hhmmss(totals?.avgTalkSec)} loading={isLoading} icon={Clock} />
        <Kpi label="Average waiting time" value={hhmmss(totals?.avgWaitSec)} loading={isLoading} icon={Clock} />
        <Kpi label="Total talk duration" value={hhmmss(totals?.talkSeconds)} loading={isLoading} icon={Clock} />
      </div>

      {ok && totals && totals.total === 0 ? (
        <Card>
          <CardContent className="p-10 text-center text-sm text-muted-foreground flex flex-col items-center gap-2">
            <PhoneOff className="h-8 w-8" />
            No calls found for the selected filters.
          </CardContent>
        </Card>
      ) : (
        <>
          {/* TRENDS */}
          <SectionHeader>Call trends</SectionHeader>
          <div className="grid lg:grid-cols-2 gap-3">
            <ChartCard title="Inbound vs outbound" loading={isLoading} hasData={byDay.length > 0}>
              <ResponsiveContainer>
                <BarChart data={byDay} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--color-border)" />
                  <XAxis dataKey="date" tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }} tickLine={false} axisLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }} allowDecimals={false} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "var(--color-muted)", opacity: 0.4 }} />
                  <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
                  <Bar dataKey="inbound" name="Inbound" fill="var(--color-chart-1)" radius={[6, 6, 0, 0]} stackId="a" />
                  <Bar dataKey="outbound" name="Outbound" fill="var(--color-chart-3)" radius={[6, 6, 0, 0]} stackId="a" />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
            <ChartCard title="Answer rate over time" loading={isLoading} hasData={byDay.length > 0}>
              <ResponsiveContainer>
                <LineChart data={byDay.map((d) => ({ date: d.date, rate: d.total ? (d.answered / d.total) * 100 : 0 }))} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--color-border)" />
                  <XAxis dataKey="date" tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }} tickLine={false} axisLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }} domain={[0, 100]} tickFormatter={(v) => `${v}%`} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={tooltipStyle} formatter={(v: any) => [`${Number(v).toFixed(1)}%`, "Answer rate"]} />
                  <Line type="monotone" dataKey="rate" stroke="var(--color-chart-1)" strokeWidth={2.5} dot={{ r: 3, fill: "var(--color-chart-1)" }} activeDot={{ r: 5 }} />
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>
          </div>

          {/* HOURLY */}
          <SectionHeader>Hourly distribution</SectionHeader>
          <ChartCard title="Calls by hour" loading={isLoading} hasData={byHour.some((h) => h.total > 0)}>
            <ResponsiveContainer>
              <BarChart data={hourly12} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }} interval={0} tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }} allowDecimals={false} tickLine={false} axisLine={false} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "var(--color-muted)", opacity: 0.4 }} />
                <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
                <Bar dataKey="inbound" name="Inbound" fill="var(--color-chart-1)" radius={[6, 6, 0, 0]} stackId="h" />
                <Bar dataKey="outbound" name="Outbound" fill="var(--color-chart-3)" radius={[6, 6, 0, 0]} stackId="h" />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>


          {/* TEAM COMPARE */}
          {teamCompare.length > 0 && (
            <>
              <SectionHeader>Team comparison</SectionHeader>
              <div className="grid lg:grid-cols-2 gap-3">
                {teamCompare.map((t) => (
                  <Card key={t.team}>
                    <CardHeader><CardTitle className="text-base">{t.team === "customer_care" ? "Customer Care" : "Telesales"}</CardTitle></CardHeader>
                    <CardContent className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      <Kpi label="Calls" value={t.calls} loading={isLoading} />
                      <Kpi label="Answered" value={t.answered} accent="text-emerald-600" loading={isLoading} />
                      <Kpi label="Answer rate" value={pct(t.answerRate)} loading={isLoading} />
                      <Kpi label="Total talk" value={hhmmss(t.talkSeconds)} loading={isLoading} />
                    </CardContent>
                  </Card>
                ))}
              </div>
            </>
          )}

          {/* AGENT PERFORMANCE */}
          <SectionHeader>Agent performance</SectionHeader>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-base">Agents ({rows.length})</CardTitle>
              <Input placeholder="Search agent or ext…" value={search} onChange={(e) => setSearch(e.target.value)} className="h-8 w-48" />
            </CardHeader>
            <CardContent className="p-0 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="px-3 py-2">Ext</th>
                    <th className="px-3 py-2">Agent</th>
                    <th className="px-3 py-2">Team</th>
                    <th className="px-3 py-2 text-right">Total</th>
                    <th className="px-3 py-2 text-right">Answered</th>
                    <th className="px-3 py-2 text-right">Missed*</th>
                    <th className="px-3 py-2 text-right">No-answer out</th>
                    <th className="px-3 py-2 text-right">In</th>
                    <th className="px-3 py-2 text-right">Out</th>
                    <th className="px-3 py-2 text-right">Answer %</th>
                    <th className="px-3 py-2 text-right">Talk</th>
                    <th className="px-3 py-2 text-right">Avg talk</th>
                    <th className="px-3 py-2 text-right">Avg ring (answered)</th>
                    <th className="px-3 py-2 text-right">Longest</th>
                  </tr>
                </thead>
                <tbody>
                  {isLoading ? (
                    Array.from({ length: 5 }).map((_, i) => (
                      <tr key={i}><td colSpan={14} className="p-2"><Skeleton className="h-6 w-full" /></td></tr>
                    ))
                  ) : searchedAgents.length === 0 ? (
                    <tr><td colSpan={14} className="text-center text-muted-foreground py-6">No agents matched.</td></tr>
                  ) : searchedAgents.map((a) => (
                    <tr key={a.agentId} className="border-b last:border-0">
                      <td className="px-3 py-2 font-mono text-xs">{a.ext}</td>
                      <td className="px-3 py-2 font-medium">{a.name}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{a.team === "customer_care" ? "Customer Care" : "Telesales"}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{a.total}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-emerald-600">{a.answered}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-red-600">{a.missed}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{a.noAnswerOutbound}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{a.inbound}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{a.outbound}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{a.answerRate.toFixed(1)}%</td>
                      <td className="px-3 py-2 text-right tabular-nums">{hhmmss(a.talkSeconds)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{hhmmss(a.avgTalkSec)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{hhmmss(a.avgRingSec)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{hhmmss(a.longestSec)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="px-3 py-2 text-[11px] text-muted-foreground">
                *Missed = the agent's own ring went unanswered. Individual performance metric only — not summed into the platform Missed KPI (the queue auto-forwards to the next available agent).
              </div>
            </CardContent>
          </Card>

          {/* CONVERSION */}
          <SectionHeader>Telesales conversion</SectionHeader>
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <Kpi label="Answered (tele)" value={conv?.overall.answered ?? 0} loading={isLoading} />
            <Kpi label="Completed orders" value={conv?.overall.completed ?? 0} accent="text-emerald-600" loading={isLoading} />
            <Kpi label="Conversion rate" value={pct(conv?.overall.conversionRate)} accent="text-blue-600" loading={isLoading} />
            <Kpi label="Revenue" value={conv ? fmtSAR(conv.overall.revenue) : "—"} loading={isLoading} />
            <Kpi label="Revenue / call" value={conv ? fmtSAR(conv.overall.revenuePerCall) : "—"} loading={isLoading} />
          </div>
          <ChartCard title="Conversion rate per day" loading={isLoading} hasData={(conv?.perDay ?? []).length > 0}>
            <ResponsiveContainer>
              <LineChart data={conv?.perDay ?? []}>
                <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `${v}%`} />
                <Tooltip formatter={(v: any) => `${Number(v).toFixed(1)}%`} />
                <Line type="monotone" dataKey="rate" stroke="hsl(var(--chart-2))" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>
          <Card>
            <CardHeader><CardTitle className="text-base">Conversion by agent</CardTitle></CardHeader>
            <CardContent className="p-0 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="px-3 py-2">Ext</th>
                    <th className="px-3 py-2">Agent</th>
                    <th className="px-3 py-2 text-right">Answered</th>
                    <th className="px-3 py-2 text-right">Completed</th>
                    <th className="px-3 py-2 text-right">Conversion %</th>
                    <th className="px-3 py-2 text-right">Revenue</th>
                    <th className="px-3 py-2 text-right">Rev / call</th>
                  </tr>
                </thead>
                <tbody>
                  {(conv?.perAgent ?? []).length === 0 ? (
                    <tr><td colSpan={7} className="text-center text-muted-foreground py-6">No telesales activity in range.</td></tr>
                  ) : (conv?.perAgent ?? []).map((c) => (
                    <tr key={c.agentId} className="border-b last:border-0">
                      <td className="px-3 py-2 font-mono text-xs">{c.ext}</td>
                      <td className="px-3 py-2 font-medium">{c.name}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{c.answered}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-emerald-600">{c.ordersCompleted}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{c.conversionRate.toFixed(1)}%</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtSAR(c.revenue)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtSAR(c.revenuePerCall)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>

          {/* Satisfaction Survey section removed per product decision. */}

        </>
      )}
    </div>
  );
}

// ---- helpers & tiny components ---------------------------------------------

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider pt-2">
      {children}
    </h2>
  );
}

const tooltipStyle: React.CSSProperties = {
  background: "var(--color-popover)",
  border: "1px solid var(--color-border)",
  borderRadius: 10,
  fontSize: 12,
  boxShadow: "0 6px 20px -10px rgba(0,0,0,.25)",
  color: "var(--color-foreground)",
};

type Tone = "primary" | "secondary" | "success" | "warning" | "destructive" | "muted";

const toneMap: Record<Tone, { text: string; ring: string; iconBg: string; iconText: string }> = {
  primary:     { text: "text-primary",     ring: "ring-primary/20",     iconBg: "bg-primary/10",     iconText: "text-primary" },
  secondary:   { text: "text-secondary",   ring: "ring-secondary/20",   iconBg: "bg-secondary/10",   iconText: "text-secondary" },
  success:     { text: "text-success",     ring: "ring-success/20",     iconBg: "bg-success/10",     iconText: "text-success" },
  warning:     { text: "text-warning",     ring: "ring-warning/20",     iconBg: "bg-warning/10",     iconText: "text-warning" },
  destructive: { text: "text-destructive", ring: "ring-destructive/20", iconBg: "bg-destructive/10", iconText: "text-destructive" },
  muted:       { text: "text-foreground",  ring: "ring-border",         iconBg: "bg-muted",          iconText: "text-muted-foreground" },
};

function HeroKpi({ label, value, loading, icon: Icon, tone = "muted", hint }: { label: string; value: string | number; loading?: boolean; icon?: any; tone?: Tone; hint?: string }) {
  const t = toneMap[tone];
  return (
    <Card className="overflow-hidden transition-shadow hover:shadow-md">
      <CardContent className="p-4 sm:p-5">
        <div className="flex items-start justify-between gap-2 mb-3">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{label}</div>
          {Icon && (
            <div className={cn("rounded-lg p-2", t.iconBg)}>
              <Icon className={cn("h-4 w-4", t.iconText)} />
            </div>
          )}
        </div>
        {loading ? (
          <Skeleton className="h-9 w-24" />
        ) : (
          <div className={cn("text-2xl sm:text-3xl font-semibold tabular-nums tracking-tight", t.text)}>{value}</div>
        )}
        {hint && <div className="mt-1.5 text-[11px] text-muted-foreground/80">{hint}</div>}
      </CardContent>
    </Card>
  );
}

function Kpi({ label, value, loading, icon: Icon, tone = "muted", hint }: { label: string; value: string | number; loading?: boolean; icon?: any; tone?: Tone; hint?: string }) {
  const t = toneMap[tone];
  return (
    <Card className="transition-shadow hover:shadow-sm">
      <CardContent className="p-3 sm:p-4">
        <div className="flex items-center justify-between mb-1.5">
          <div className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">{label}</div>
          {Icon && <Icon className={cn("h-3.5 w-3.5", t.iconText)} />}
        </div>
        {loading ? (
          <Skeleton className="h-6 w-16" />
        ) : (
          <div className={cn("text-lg sm:text-xl font-semibold tabular-nums", t.text)}>{value}</div>
        )}
        {hint && <div className="mt-1 text-[10px] text-muted-foreground/80">{hint}</div>}
      </CardContent>
    </Card>
  );
}

function ChartCard({ title, loading, hasData, children }: { title: string; loading?: boolean; hasData?: boolean; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-sm font-semibold">{title}</CardTitle></CardHeader>
      <CardContent className="h-64">
        {loading ? (
          <Skeleton className="h-full w-full" />
        ) : !hasData ? (
          <div className="h-full flex items-center justify-center text-xs text-muted-foreground">No data</div>
        ) : children}
      </CardContent>
    </Card>
  );
}

// SurveySection removed — Satisfaction Survey has been discontinued.


function hourLabel(h: number): string {
  if (h === 0) return "12 AM";
  if (h < 12) return `${h} AM`;
  if (h === 12) return "12 PM";
  return `${h - 12} PM`;
}

function pct(v?: number) { return `${(v ?? 0).toFixed(1)}%`; }

function hhmmss(sec?: number): string {
  const s = Math.max(0, Math.floor(sec ?? 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}
