/**
 * Call Center Analytics — standalone module (separated from Dashboard).
 * Progressive loading, queue-aware KPIs, conversion analytics, exports.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useRef, useState } from "react";
import { format } from "date-fns";
import type { DateRange } from "react-day-picker";
import {
  BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, CartesianGrid,
  LineChart, Line, Legend, PieChart, Pie, Cell, AreaChart, Area,
} from "recharts";
import * as XLSX from "xlsx";
import {
  Download, ShieldAlert, PhoneOff, AlertTriangle, TrendingUp, Users, Clock, Printer,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { hasPerm } from "@/lib/permissions";
import { getCallCenterAnalytics } from "@/lib/yeastar.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { DateRangePicker } from "@/components/date-range-picker";
import { cn } from "@/lib/utils";
import { fmtSAR } from "@/lib/branches";

export const Route = createFileRoute("/_app/call-center")({
  head: () => ({ meta: [{ title: "Call Center Analytics — MilaServ" }] }),
  component: CallCenterPage,
});

const toISO = (d: Date) => format(d, "yyyy-MM-dd");
const CHART_COLORS = ["hsl(var(--chart-1))", "hsl(var(--chart-2))", "hsl(var(--chart-3))", "hsl(var(--chart-4))", "hsl(var(--chart-5))"];

type Team = "all" | "customer_care" | "telesales";
type Direction = "all" | "Inbound" | "Outbound" | "Internal";
type StatusFilter = "all" | "ANSWERED" | "NO ANSWER" | "BUSY" | "FAILED" | "VOICEMAIL";
type Grain = "daily" | "weekly" | "monthly";

function CallCenterPage() {
  const { user, role, profile } = useAuth();
  const canView = hasPerm(role, profile?.permissions as any, "view_team_analytics") || hasPerm(role, profile?.permissions as any, "view_dashboard");
  const canAll = hasPerm(role, profile?.permissions as any, "view_all_agents");
  const canExport = hasPerm(role, profile?.permissions as any, "export_reports");

  // ---- Filters ----
  const today = new Date();
  const [range, setRange] = useState<DateRange | undefined>({ from: today, to: today });
  const [team, setTeam] = useState<Team>("all");
  const [agentId, setAgentId] = useState<string>("all");
  const [direction, setDirection] = useState<Direction>("all");
  const [statusF, setStatusF] = useState<StatusFilter>("all");
  const [grain, setGrain] = useState<Grain>("daily");
  const [search, setSearch] = useState("");

  const from = range?.from ? toISO(range.from) : toISO(today);
  const to = range?.to ? toISO(range.to) : from;

  // ---- Agents dropdown (admin) ----
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
  });
  const filteredAgents = useMemo(() => {
    if (!agents) return [];
    return team === "all" ? agents : agents.filter((a: any) => a.role === team);
  }, [agents, team]);

  // ---- Progress job id ----
  const jobIdRef = useRef<string>("");
  const [jobId, setJobId] = useState<string>("");
  const queryKey = ["cc-analytics", from, to, team, agentId, direction, statusF];
  useEffect(() => {
    const id = crypto.randomUUID();
    jobIdRef.current = id;
    setJobId(id);
  }, [from, to, team, agentId, direction, statusF]);

  // ---- Analytics query ----
  const analyticsFn = useServerFn(getCallCenterAnalytics);
  const q = useQuery({
    queryKey,
    queryFn: () => analyticsFn({
      data: {
        from, to, team,
        agentId: canAll && agentId !== "all" ? agentId : null,
        direction, status: statusF,
        includeOrders: true,
        jobId: jobIdRef.current,
      },
    }),
    staleTime: 60_000,
  });

  // ---- Progress polling ----
  const [progress, setProgress] = useState<{ percent: number; message: string; status: string } | null>(null);
  useEffect(() => {
    if (!q.isFetching || !jobId) { setProgress(null); return; }
    let stop = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/public/cdr-progress/${jobId}`, { cache: "no-store" });
        if (!res.ok) return;
        const j = await res.json();
        if (!stop) setProgress({ percent: j.percent ?? 0, message: j.message ?? "Loading…", status: j.status ?? "pending" });
      } catch { /* ignore */ }
    };
    tick();
    const iv = setInterval(tick, 500);
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
  const heatmap = ok ? data.heatmap : [];
  const teamCompare = ok ? data.teamCompare : [];
  const missed = ok ? data.missedBreakdown : null;
  const conv = ok ? data.conversion : null;

  const grouped = useMemo(() => aggregateByGrain(byDay, grain), [byDay, grain]);
  const searchedAgents = useMemo(() => {
    if (!search.trim()) return rows;
    const s = search.toLowerCase();
    return rows.filter((r) => r.name.toLowerCase().includes(s) || r.ext.toLowerCase().includes(s));
  }, [rows, search]);

  const doExport = (kind: "csv" | "xlsx") => {
    if (!ok) return;
    const kpiSheet = totals ? [
      { Metric: "Total calls", Value: totals.total },
      { Metric: "Answered", Value: totals.answered },
      { Metric: "Missed (global)", Value: totals.missed },
      { Metric: "Abandoned", Value: totals.abandoned },
      { Metric: "Busy", Value: totals.busy },
      { Metric: "Failed", Value: totals.failed },
      { Metric: "Voicemail", Value: totals.voicemail },
      { Metric: "Inbound", Value: totals.inbound },
      { Metric: "Outbound", Value: totals.outbound },
      { Metric: "Internal", Value: totals.internal },
      { Metric: "Answer rate %", Value: totals.answerRate.toFixed(2) },
      { Metric: "Missed rate %", Value: totals.missedRate.toFixed(2) },
      { Metric: "Abandon rate %", Value: totals.abandonRate.toFixed(2) },
      { Metric: "Avg talk (s)", Value: totals.avgTalkSec.toFixed(1) },
      { Metric: "AHT (s)", Value: totals.avgHandlingSec.toFixed(1) },
      { Metric: "Avg ring (s)", Value: totals.avgRingSec.toFixed(1) },
      { Metric: "Avg duration (s)", Value: totals.avgDurationSec.toFixed(1) },
      { Metric: "Total talk (s)", Value: totals.talkSeconds },
      { Metric: "Longest (s)", Value: totals.longestSec },
      { Metric: "Shortest (s)", Value: totals.shortestSec },
      { Metric: "Active agents", Value: totals.activeAgents },
      { Metric: "Calls / agent", Value: totals.callsPerAgent.toFixed(2) },
    ] : [];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(kpiSheet), "KPIs");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "Agents");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(byDay), "By day");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(byHour), "By hour");
    if (conv) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(conv.perAgent), "Conversion by agent");
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(conv.perDay), "Conversion by day");
    }
    XLSX.writeFile(wb, `call-center-${from}_${to}.${kind === "csv" ? "csv" : "xlsx"}`);
  };

  return (
    <div className="space-y-5 print:space-y-3">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">Call Center Analytics</h1>
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
              <SelectItem value="all">All directions</SelectItem>
              <SelectItem value="Inbound">Inbound</SelectItem>
              <SelectItem value="Outbound">Outbound</SelectItem>
              <SelectItem value="Internal">Internal</SelectItem>
            </SelectContent>
          </Select>
          <Select value={statusF} onValueChange={(v) => setStatusF(v as StatusFilter)}>
            <SelectTrigger className="h-9 w-[140px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="ANSWERED">Answered</SelectItem>
              <SelectItem value="NO ANSWER">No answer</SelectItem>
              <SelectItem value="BUSY">Busy</SelectItem>
              <SelectItem value="FAILED">Failed</SelectItem>
              <SelectItem value="VOICEMAIL">Voicemail</SelectItem>
            </SelectContent>
          </Select>
          {canExport && (
            <>
              <Button variant="outline" size="sm" onClick={() => doExport("xlsx")} disabled={!ok}>
                <Download className="h-4 w-4 mr-2" />Excel
              </Button>
              <Button variant="outline" size="sm" onClick={() => window.print()} disabled={!ok}>
                <Printer className="h-4 w-4 mr-2" />PDF
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Progress bar */}
      {q.isFetching && (
        <Card>
          <CardContent className="p-4 space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium">{progress?.message ?? "Loading call records…"}</span>
              <span className="tabular-nums text-muted-foreground">{progress?.percent ?? 0}%</span>
            </div>
            <Progress value={progress?.percent ?? 0} />
          </CardContent>
        </Card>
      )}

      {/* Error */}
      {errMsg && (
        <Card>
          <CardContent className="p-4 text-sm text-muted-foreground flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-destructive shrink-0" />
            {errMsg}
          </CardContent>
        </Card>
      )}

      {/* KPI CARDS — load first, always visible */}
      <section>
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-2">Overview</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 sm:gap-3">
          <Kpi label="Total calls" value={totals?.total ?? 0} loading={isLoading} />
          <Kpi label="Answered" value={totals?.answered ?? 0} accent="text-green-600" loading={isLoading} />
          <Kpi label="Missed" value={totals?.missed ?? 0} accent="text-red-600" loading={isLoading} />
          <Kpi label="Abandoned" value={totals?.abandoned ?? 0} accent="text-orange-600" loading={isLoading} />
          <Kpi label="Failed" value={totals?.failed ?? 0} loading={isLoading} />
          <Kpi label="Busy" value={totals?.busy ?? 0} loading={isLoading} />
          <Kpi label="Inbound" value={totals?.inbound ?? 0} loading={isLoading} />
          <Kpi label="Outbound" value={totals?.outbound ?? 0} loading={isLoading} />
          <Kpi label="Internal" value={totals?.internal ?? 0} loading={isLoading} />
          <Kpi label="Answer rate" value={pct(totals?.answerRate)} accent="text-green-600" loading={isLoading} />
          <Kpi label="Missed rate" value={pct(totals?.missedRate)} accent="text-red-600" loading={isLoading} />
          <Kpi label="Abandon rate" value={pct(totals?.abandonRate)} accent="text-orange-600" loading={isLoading} />
        </div>
        <div className="mt-2 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 sm:gap-3">
          <Kpi label="Avg talk time" value={dur(totals?.avgTalkSec)} loading={isLoading} />
          <Kpi label="AHT" value={dur(totals?.avgHandlingSec)} loading={isLoading} />
          <Kpi label="Avg ring" value={dur(totals?.avgRingSec)} loading={isLoading} />
          <Kpi label="Avg duration" value={dur(totals?.avgDurationSec)} loading={isLoading} />
          <Kpi label="Total talk" value={dur(totals?.talkSeconds)} loading={isLoading} />
          <Kpi label="Longest call" value={dur(totals?.longestSec)} loading={isLoading} />
          <Kpi label="Shortest call" value={dur(totals?.shortestSec)} loading={isLoading} />
          <Kpi label="Active agents" value={totals?.activeAgents ?? 0} loading={isLoading} />
          <Kpi label="Calls / agent" value={(totals?.callsPerAgent ?? 0).toFixed(1)} loading={isLoading} />
        </div>
      </section>

      {ok && totals && totals.total === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground flex flex-col items-center gap-2">
            <PhoneOff className="h-6 w-6" />
            No calls found for the selected filters.
          </CardContent>
        </Card>
      ) : (
        <Tabs defaultValue="trends" className="space-y-4">
          <TabsList>
            <TabsTrigger value="trends">Trends</TabsTrigger>
            <TabsTrigger value="hourly">Hourly</TabsTrigger>
            <TabsTrigger value="agents">Agents</TabsTrigger>
            <TabsTrigger value="teams">Teams</TabsTrigger>
            <TabsTrigger value="missed">Missed / Abandoned</TabsTrigger>
            <TabsTrigger value="conversion">Conversion</TabsTrigger>
          </TabsList>

          {/* TRENDS */}
          <TabsContent value="trends" className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Grain</span>
              <Select value={grain} onValueChange={(v) => setGrain(v as Grain)}>
                <SelectTrigger className="h-8 w-[110px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="weekly">Weekly</SelectItem>
                  <SelectItem value="monthly">Monthly</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid lg:grid-cols-2 gap-3">
              <ChartCard title="Calls per period" loading={isLoading}>
                <ResponsiveContainer><AreaChart data={grouped}>
                  <defs>
                    <linearGradient id="cA" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={CHART_COLORS[0]} stopOpacity={0.6} />
                      <stop offset="100%" stopColor={CHART_COLORS[0]} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--color-border)" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                  <Tooltip />
                  <Area type="monotone" dataKey="total" name="Total" stroke={CHART_COLORS[0]} fill="url(#cA)" />
                </AreaChart></ResponsiveContainer>
              </ChartCard>
              <ChartCard title="Answered vs missed vs abandoned" loading={isLoading}>
                <ResponsiveContainer><LineChart data={grouped}>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--color-border)" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                  <Tooltip /><Legend />
                  <Line type="monotone" dataKey="answered" stroke="#16a34a" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="missed" stroke="#dc2626" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="abandoned" stroke="#f97316" strokeWidth={2} dot={false} />
                </LineChart></ResponsiveContainer>
              </ChartCard>
              <ChartCard title="Answer rate %" loading={isLoading}>
                <ResponsiveContainer><LineChart data={grouped.map((g) => ({ ...g, rate: g.total ? (g.answered / g.total) * 100 : 0 }))}>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--color-border)" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} domain={[0, 100]} />
                  <Tooltip />
                  <Line type="monotone" dataKey="rate" stroke="#16a34a" strokeWidth={2} dot={false} />
                </LineChart></ResponsiveContainer>
              </ChartCard>
              <ChartCard title="AHT / Talk / Ring (avg sec)" loading={isLoading}>
                <ResponsiveContainer><LineChart data={grouped.map((g) => ({
                  label: g.label,
                  aht: g.answered ? g.handlingSeconds / g.answered : 0,
                  talk: g.answered ? g.talkSeconds / g.answered : 0,
                  ring: g.answered ? g.ringSeconds / g.answered : 0,
                }))}>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--color-border)" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip /><Legend />
                  <Line type="monotone" dataKey="aht" stroke={CHART_COLORS[0]} strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="talk" stroke={CHART_COLORS[1]} strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="ring" stroke={CHART_COLORS[2]} strokeWidth={2} dot={false} />
                </LineChart></ResponsiveContainer>
              </ChartCard>
              <ChartCard title="Inbound vs outbound" loading={isLoading}>
                <ResponsiveContainer><BarChart data={grouped}>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--color-border)" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                  <Tooltip /><Legend />
                  <Bar dataKey="inbound" stackId="a" fill={CHART_COLORS[0]} />
                  <Bar dataKey="outbound" stackId="a" fill={CHART_COLORS[1]} />
                </BarChart></ResponsiveContainer>
              </ChartCard>
            </div>
          </TabsContent>

          {/* HOURLY */}
          <TabsContent value="hourly" className="space-y-3">
            <div className="grid lg:grid-cols-2 gap-3">
              <ChartCard title="Calls by hour" loading={isLoading}>
                <ResponsiveContainer><BarChart data={byHour}>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--color-border)" />
                  <XAxis dataKey="hour" tick={{ fontSize: 11 }} tickFormatter={(h) => `${h}:00`} />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                  <Tooltip labelFormatter={(h) => `${h}:00`} /><Legend />
                  <Bar dataKey="answered" stackId="h" fill="#16a34a" name="Answered" />
                  <Bar dataKey="missed" stackId="h" fill="#dc2626" name="Missed" />
                </BarChart></ResponsiveContainer>
              </ChartCard>
              <ChartCard title="Answer rate by hour" loading={isLoading}>
                <ResponsiveContainer><LineChart data={byHour.map((h) => ({ ...h, rate: h.total ? (h.answered / h.total) * 100 : 0 }))}>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--color-border)" />
                  <XAxis dataKey="hour" tick={{ fontSize: 11 }} tickFormatter={(h) => `${h}:00`} />
                  <YAxis tick={{ fontSize: 11 }} domain={[0, 100]} />
                  <Tooltip labelFormatter={(h) => `${h}:00`} />
                  <Line type="monotone" dataKey="rate" stroke="#16a34a" strokeWidth={2} dot={false} />
                </LineChart></ResponsiveContainer>
              </ChartCard>
            </div>
            <Card>
              <CardHeader><CardTitle className="text-base">Peak traffic heatmap (day × hour)</CardTitle></CardHeader>
              <CardContent><Heatmap cells={heatmap} /></CardContent>
            </Card>
          </TabsContent>

          {/* AGENTS */}
          <TabsContent value="agents" className="space-y-3">
            <div className="grid lg:grid-cols-2 gap-3">
              <Card>
                <CardHeader><CardTitle className="text-base flex items-center gap-2"><TrendingUp className="h-4 w-4 text-green-600" />Top performers</CardTitle></CardHeader>
                <CardContent><MiniLeaderboard rows={[...rows].sort((a, b) => b.answered - a.answered).slice(0, 5)} highlight="answered" /></CardContent>
              </Card>
              <Card>
                <CardHeader><CardTitle className="text-base flex items-center gap-2"><Users className="h-4 w-4 text-orange-600" />Lowest answer rate</CardTitle></CardHeader>
                <CardContent><MiniLeaderboard rows={[...rows].filter((r) => r.inbound + r.outbound > 0).sort((a, b) => a.answerRate - b.answerRate).slice(0, 5)} highlight="answerRate" isPct /></CardContent>
              </Card>
            </div>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="text-base">Agent performance</CardTitle>
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
                      <th className="px-3 py-2 text-right">In</th>
                      <th className="px-3 py-2 text-right">Out</th>
                      <th className="px-3 py-2 text-right">Answer %</th>
                      <th className="px-3 py-2 text-right">Talk</th>
                      <th className="px-3 py-2 text-right">Avg talk</th>
                      <th className="px-3 py-2 text-right">AHT</th>
                      <th className="px-3 py-2 text-right">Avg ring</th>
                      <th className="px-3 py-2 text-right">Longest</th>
                      <th className="px-3 py-2 text-right">Shortest</th>
                    </tr>
                  </thead>
                  <tbody>
                    {isLoading ? (
                      Array.from({ length: 5 }).map((_, i) => (
                        <tr key={i}><td colSpan={15} className="p-2"><Skeleton className="h-6 w-full" /></td></tr>
                      ))
                    ) : searchedAgents.length === 0 ? (
                      <tr><td colSpan={15} className="text-center text-muted-foreground py-6">No agents matched.</td></tr>
                    ) : searchedAgents.map((a) => (
                      <tr key={a.agentId} className="border-b last:border-0">
                        <td className="px-3 py-2 font-mono text-xs">{a.ext}</td>
                        <td className="px-3 py-2 font-medium">{a.name}</td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">{a.team === "customer_care" ? "Customer Care" : "Telesales"}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{a.total}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-green-600">{a.answered}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-red-600">{a.missed}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{a.inbound}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{a.outbound}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{a.answerRate.toFixed(1)}%</td>
                        <td className="px-3 py-2 text-right tabular-nums">{dur(a.talkSeconds)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{dur(a.avgTalkSec)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{dur(a.avgHandlingSec)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{dur(a.avgRingSec)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{dur(a.longestSec)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{dur(a.shortestSec)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="px-3 py-2 text-[11px] text-muted-foreground">
                  *Missed = the agent's own ring went unanswered (may have been picked up by another agent in the queue).
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* TEAMS */}
          <TabsContent value="teams" className="space-y-3">
            <div className="grid lg:grid-cols-2 gap-3">
              {teamCompare.map((t) => (
                <Card key={t.team}>
                  <CardHeader><CardTitle className="text-base">{t.team === "customer_care" ? "Customer Care" : "Telesales"}</CardTitle></CardHeader>
                  <CardContent className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <Kpi label="Calls" value={t.calls} loading={isLoading} />
                    <Kpi label="Answered" value={t.answered} accent="text-green-600" loading={isLoading} />
                    <Kpi label="Missed" value={t.missed} accent="text-red-600" loading={isLoading} />
                    <Kpi label="Answer rate" value={pct(t.answerRate)} loading={isLoading} />
                    <Kpi label="Inbound" value={t.inbound} loading={isLoading} />
                    <Kpi label="Outbound" value={t.outbound} loading={isLoading} />
                    <Kpi label="AHT" value={dur(t.answered ? t.handlingSeconds / t.answered : 0)} loading={isLoading} />
                    <Kpi label="Total talk" value={dur(t.talkSeconds)} loading={isLoading} />
                  </CardContent>
                </Card>
              ))}
            </div>
            <ChartCard title="Team comparison" loading={isLoading}>
              <ResponsiveContainer><BarChart data={teamCompare.map((t) => ({ team: t.team === "customer_care" ? "Customer Care" : "Telesales", Answered: t.answered, Missed: t.missed }))}>
                <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis dataKey="team" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip /><Legend />
                <Bar dataKey="Answered" fill="#16a34a" />
                <Bar dataKey="Missed" fill="#dc2626" />
              </BarChart></ResponsiveContainer>
            </ChartCard>
          </TabsContent>

          {/* MISSED / ABANDONED */}
          <TabsContent value="missed" className="space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              <Kpi label="Missed" value={missed?.missed ?? 0} accent="text-red-600" loading={isLoading} />
              <Kpi label="Abandoned" value={missed?.abandoned ?? 0} accent="text-orange-600" loading={isLoading} />
              <Kpi label="Busy" value={missed?.busy ?? 0} loading={isLoading} />
              <Kpi label="Failed" value={missed?.failed ?? 0} loading={isLoading} />
              <Kpi label="Voicemail" value={missed?.voicemail ?? 0} loading={isLoading} />
            </div>
            <ChartCard title="Missed & abandoned trend" loading={isLoading}>
              <ResponsiveContainer><LineChart data={grouped}>
                <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip /><Legend />
                <Line type="monotone" dataKey="missed" stroke="#dc2626" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="abandoned" stroke="#f97316" strokeWidth={2} dot={false} />
              </LineChart></ResponsiveContainer>
            </ChartCard>
            <ChartCard title="Breakdown" loading={isLoading}>
              <ResponsiveContainer><PieChart>
                <Pie data={missed ? [
                  { name: "Missed", value: missed.missed },
                  { name: "Abandoned", value: missed.abandoned },
                  { name: "Busy", value: missed.busy },
                  { name: "Failed", value: missed.failed },
                  { name: "Voicemail", value: missed.voicemail },
                ] : []} dataKey="value" nameKey="name" outerRadius={90} label>
                  {["#dc2626", "#f97316", "#eab308", "#94a3b8", "#8b5cf6"].map((c, i) => <Cell key={i} fill={c} />)}
                </Pie>
                <Legend /><Tooltip />
              </PieChart></ResponsiveContainer>
            </ChartCard>
          </TabsContent>

          {/* CONVERSION */}
          <TabsContent value="conversion" className="space-y-3">
            <p className="text-xs text-muted-foreground">Conversion is computed only for the Telesales team.</p>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
              <Kpi label="Answered (tele)" value={conv?.overall.answered ?? 0} loading={isLoading} />
              <Kpi label="Total orders" value={conv?.overall.orders ?? 0} loading={isLoading} />
              <Kpi label="Completed" value={conv?.overall.completed ?? 0} accent="text-green-600" loading={isLoading} />
              <Kpi label="Cancelled" value={conv?.overall.cancelled ?? 0} accent="text-red-600" loading={isLoading} />
              <Kpi label="Pending" value={conv?.overall.pending ?? 0} loading={isLoading} />
              <Kpi label="Revenue" value={conv ? fmtSAR(conv.overall.revenue) : "—"} loading={isLoading} />
              <Kpi label="Overall conversion" value={pct(conv?.overall.conversionRate)} accent="text-green-600" loading={isLoading} />
              <Kpi label="Cash conversion" value={pct(conv?.overall.cashConversion)} loading={isLoading} />
              <Kpi label="Wasfaty conversion" value={pct(conv?.overall.wasfatyConversion)} loading={isLoading} />
              <Kpi label="Orders / call" value={(conv?.overall.ordersPerCall ?? 0).toFixed(2)} loading={isLoading} />
              <Kpi label="Revenue / call" value={conv ? fmtSAR(conv.overall.revenuePerCall) : "—"} loading={isLoading} />
              <Kpi label="Revenue / order" value={conv ? fmtSAR(conv.overall.revenuePerOrder) : "—"} loading={isLoading} />
            </div>
            <div className="grid lg:grid-cols-2 gap-3">
              <ChartCard title="Conversion rate per day" loading={isLoading}>
                <ResponsiveContainer><LineChart data={conv?.perDay ?? []}>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--color-border)" />
                  <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Line type="monotone" dataKey="rate" stroke={CHART_COLORS[0]} strokeWidth={2} dot={false} />
                </LineChart></ResponsiveContainer>
              </ChartCard>
              <ChartCard title="Monthly conversion" loading={isLoading}>
                <ResponsiveContainer><BarChart data={conv?.perMonth ?? []}>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--color-border)" />
                  <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Bar dataKey="rate" fill={CHART_COLORS[2]} />
                </BarChart></ResponsiveContainer>
              </ChartCard>
            </div>
            <Card>
              <CardHeader><CardTitle className="text-base">Conversion by agent</CardTitle></CardHeader>
              <CardContent className="p-0 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th className="px-3 py-2">Ext</th>
                      <th className="px-3 py-2">Agent</th>
                      <th className="px-3 py-2 text-right">Answered</th>
                      <th className="px-3 py-2 text-right">Orders</th>
                      <th className="px-3 py-2 text-right">Completed</th>
                      <th className="px-3 py-2 text-right">Cash</th>
                      <th className="px-3 py-2 text-right">Wasfaty</th>
                      <th className="px-3 py-2 text-right">Conv %</th>
                      <th className="px-3 py-2 text-right">Revenue</th>
                      <th className="px-3 py-2 text-right">Rev/call</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(conv?.perAgent ?? []).length === 0 ? (
                      <tr><td colSpan={10} className="text-center text-muted-foreground py-6">No telesales activity.</td></tr>
                    ) : (conv?.perAgent ?? []).map((a) => (
                      <tr key={a.agentId} className="border-b last:border-0">
                        <td className="px-3 py-2 font-mono text-xs">{a.ext}</td>
                        <td className="px-3 py-2 font-medium">{a.name}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{a.answered}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{a.ordersTotal}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-green-600">{a.ordersCompleted}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{a.ordersCash}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{a.ordersWasfaty}</td>
                        <td className="px-3 py-2 text-right tabular-nums font-semibold">{a.conversionRate.toFixed(1)}%</td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmtSAR(a.revenue)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmtSAR(a.revenuePerCall)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      )}

      {ok && data.cdr && (
        <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground print:hidden">
          <Badge variant="outline">CDR fetched {data.cdr.fetched.toLocaleString()}{data.cdr.totalReported != null ? ` / ${data.cdr.totalReported.toLocaleString()}` : ""}</Badge>
          <Badge variant="outline">Path: {data.cdr.path}</Badge>
          <Badge variant="outline">Elapsed: {(data.cdr.elapsedMs / 1000).toFixed(1)}s</Badge>
          {data.cdr.truncated && <Badge variant="destructive">Truncated — narrow the range</Badge>}
        </div>
      )}
    </div>
  );
}

/* ------------------------- helpers & subcomponents ------------------------- */

function Kpi({ label, value, accent, loading }: { label: string; value: string | number; accent?: string; loading?: boolean }) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold truncate">{label}</div>
      {loading ? <Skeleton className="mt-2 h-6 w-16" /> : (
        <div className={cn("mt-1 text-lg font-bold tabular-nums leading-tight", accent)}>{value}</div>
      )}
    </div>
  );
}

function ChartCard({ title, loading, children }: { title: string; loading?: boolean; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">{title}</CardTitle></CardHeader>
      <CardContent className="h-64">{loading ? <Skeleton className="h-full w-full" /> : children}</CardContent>
    </Card>
  );
}

function MiniLeaderboard({ rows, highlight, isPct }: { rows: any[]; highlight: string; isPct?: boolean }) {
  if (rows.length === 0) return <div className="text-sm text-muted-foreground">No data.</div>;
  return (
    <ul className="space-y-1.5">
      {rows.map((r) => (
        <li key={r.agentId} className="flex items-center justify-between text-sm">
          <span className="truncate"><span className="text-xs text-muted-foreground mr-1">{r.ext}</span>{r.name}</span>
          <span className="tabular-nums font-semibold">{isPct ? `${r[highlight].toFixed(1)}%` : r[highlight]}</span>
        </li>
      ))}
    </ul>
  );
}

function Heatmap({ cells }: { cells: { date: string; hour: number; value: number }[] }) {
  const days = [...new Set(cells.map((c) => c.date))].sort();
  const max = Math.max(1, ...cells.map((c) => c.value));
  const cellMap = new Map(cells.map((c) => [`${c.date}|${c.hour}`, c.value]));
  return (
    <div className="overflow-x-auto">
      <table className="text-[10px] border-separate border-spacing-0.5">
        <thead>
          <tr>
            <th className="text-left px-1"></th>
            {Array.from({ length: 24 }, (_, h) => (
              <th key={h} className="px-1 text-muted-foreground font-normal w-6">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {days.map((d) => (
            <tr key={d}>
              <td className="pr-2 text-muted-foreground whitespace-nowrap">{d.slice(5)}</td>
              {Array.from({ length: 24 }, (_, h) => {
                const v = cellMap.get(`${d}|${h}`) ?? 0;
                const intensity = v / max;
                const bg = v === 0 ? "hsl(var(--muted))" : `hsl(var(--chart-1) / ${0.15 + intensity * 0.85})`;
                return (
                  <td key={h} title={`${d} ${h}:00 → ${v} calls`} className="w-6 h-5 rounded text-center" style={{ background: bg }}>
                    {v > 0 ? v : ""}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function pct(v: number | null | undefined) {
  return v == null ? "0.0%" : `${v.toFixed(1)}%`;
}
function dur(sec: number | null | undefined) {
  const s = Number(sec ?? 0);
  if (!s || s < 0) return "0s";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = Math.floor(s % 60);
  if (h > 0) return `${h}h ${m}m`;
  return m > 0 ? `${m}m ${r}s` : `${r}s`;
}

interface Grouped {
  label: string;
  total: number; answered: number; missed: number; abandoned: number;
  inbound: number; outbound: number;
  talkSeconds: number; ringSeconds: number; handlingSeconds: number;
}
function aggregateByGrain(days: any[], grain: Grain): Grouped[] {
  const keyOf = (d: string) => {
    if (grain === "daily") return d;
    if (grain === "monthly") return d.slice(0, 7);
    // weekly: ISO-ish YYYY-Www
    const dt = new Date(d);
    const onejan = new Date(dt.getFullYear(), 0, 1);
    const week = Math.ceil((((dt.getTime() - onejan.getTime()) / 86400000) + onejan.getDay() + 1) / 7);
    return `${dt.getFullYear()}-W${String(week).padStart(2, "0")}`;
  };
  const acc = new Map<string, Grouped>();
  for (const d of days) {
    const k = keyOf(d.date);
    const g = acc.get(k) ?? { label: k, total: 0, answered: 0, missed: 0, abandoned: 0, inbound: 0, outbound: 0, talkSeconds: 0, ringSeconds: 0, handlingSeconds: 0 };
    g.total += d.total; g.answered += d.answered; g.missed += d.missed; g.abandoned += d.abandoned;
    g.inbound += d.inbound; g.outbound += d.outbound;
    g.talkSeconds += d.talkSeconds; g.ringSeconds += d.ringSeconds; g.handlingSeconds += d.handlingSeconds;
    acc.set(k, g);
  }
  return [...acc.values()].sort((a, b) => a.label.localeCompare(b.label));
}
