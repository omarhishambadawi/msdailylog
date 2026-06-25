import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useMemo, useState } from "react";
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, CartesianGrid, PieChart, Pie, Cell, Legend } from "recharts";
import { fmtSAR } from "@/lib/branches";
import { format } from "date-fns";
import type { DateRange } from "react-day-picker";
import { CalendarIcon, Download } from "lucide-react";
import { cn } from "@/lib/utils";
import * as XLSX from "xlsx";

export const Route = createFileRoute("/_app/dashboard")({
  head: () => ({ meta: [{ title: "Dashboard — MilaServ Daily Log" }] }),
  component: Dashboard,
});

const toISO = (d: Date) => format(d, "yyyy-MM-dd");

function Dashboard() {
  const { user, role } = useAuth();
  const isAdmin = role === "admin";
  const [mineOnly, setMineOnly] = useState(false);
  const [agentFilter, setAgentFilter] = useState<string>("all");
  const [teamFilter, setTeamFilter] = useState<string>("all");
  const [dateOpen, setDateOpen] = useState(false);

  const today = new Date();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  const [range, setRange] = useState<DateRange | undefined>({ from: monthStart, to: monthEnd });
  const from = range?.from ? toISO(range.from) : toISO(monthStart);
  const to = range?.to ? toISO(range.to) : from;

  const dateLabel = useMemo(() => {
    if (!range?.from) return "Pick a date";
    if (!range.to || toISO(range.from) === toISO(range.to)) return format(range.from, "PP");
    return `${format(range.from, "PP")} — ${format(range.to, "PP")}`;
  }, [range]);

  const setQuick = (kind: "today" | "7d" | "30d" | "month") => {
    const t = new Date();
    if (kind === "today") { setRange({ from: t, to: t }); return; }
    if (kind === "7d") { const f = new Date(); f.setDate(f.getDate() - 6); setRange({ from: f, to: t }); return; }
    if (kind === "30d") { const f = new Date(); f.setDate(f.getDate() - 29); setRange({ from: f, to: t }); return; }
    if (kind === "month") { setRange({ from: new Date(t.getFullYear(), t.getMonth(), 1), to: new Date(t.getFullYear(), t.getMonth() + 1, 0) }); return; }
  };

  const effectiveAgent = isAdmin ? agentFilter : (mineOnly && user?.id ? user.id : "all");
  const effectiveTeam = isAdmin ? teamFilter : "all";

  const { data: agents } = useQuery({
    queryKey: ["dashboard-agents"],
    queryFn: async () => {
      const [{ data: profiles }, { data: roles }] = await Promise.all([
        supabase.from("profiles").select("id,full_name,agent_code").order("full_name"),
        supabase.from("user_roles").select("user_id,role"),
      ]);
      const rm = new Map((roles ?? []).map((r: any) => [r.user_id, r.role]));
      return (profiles ?? []).map((p: any) => ({ ...p, role: rm.get(p.id) ?? null }));
    },
    enabled: isAdmin,
  });

  const filteredAgents = useMemo(() => {
    if (!agents) return [];
    if (teamFilter === "all") return agents;
    return agents.filter((a: any) => a.role === teamFilter || a.role === "admin");
  }, [agents, teamFilter]);

  const { data } = useQuery({
    queryKey: ["dashboard", from, to, effectiveAgent, effectiveTeam, isAdmin, user?.id],
    queryFn: async () => {
      let qb = supabase.from("orders")
        .select("id,order_date,team,agent_id,branch_no,invoice_value,status,order_type,delivery_type,call_center_verified")
        .gte("order_date", from).lte("order_date", to);
      if (effectiveAgent !== "all") qb = qb.eq("agent_id", effectiveAgent);
      if (effectiveTeam !== "all") qb = qb.eq("team", effectiveTeam as "customer_care" | "telesales");

      let cb = supabase.from("complaints" as any).select("id,complaint_date,branch_no,status,agent_id")
        .gte("complaint_date", from).lte("complaint_date", to);
      if (effectiveAgent !== "all") cb = cb.eq("agent_id", effectiveAgent);

      const [{ data: orders }, { data: branches }, { data: profiles }, { data: complaints }] = await Promise.all([
        qb,
        supabase.from("branches").select("branch_no,city"),
        supabase.from("profiles").select("id,full_name"),
        cb,
      ]);
      const cityMap = new Map((branches ?? []).map((b: any) => [b.branch_no, b.city]));
      const nameMap = new Map((profiles ?? []).map((p: any) => [p.id, p.full_name]));
      const rangeOrders = orders ?? [];
      const cmps = (complaints as any[]) ?? [];

      const num = (v: any) => Number(v ?? 0);
      const sum = (rows: any[]) => rows.reduce((s, o) => s + num(o.invoice_value), 0);
      const completedRows = (rows: any[]) => rows.filter((o) => o.status === "Completed");
      const cash = (rows: any[]) => rows.filter((o: any) => o.order_type === "Cash");
      const was = (rows: any[]) => rows.filter((o: any) => o.order_type === "Wasfaty");
      const verifiedRows = (rows: any[]) => rows.filter((o: any) => o.call_center_verified);

      const monthAll = sum(rangeOrders);
      const monthCompleted = sum(completedRows(rangeOrders));
      const monthCompletedCount = completedRows(rangeOrders).length;
      const completionRate = rangeOrders.length > 0 ? (monthCompletedCount / rangeOrders.length) * 100 : 0;

      // Generic aggregation: counts, completed-sales, completed count, completion rate
      const groupAgg = (rows: any[], keyFn: (o: any) => string) => {
        const m: Record<string, { count: number; sales: number; completed: number }> = {};
        for (const o of rows) {
          const k = keyFn(o) || "—";
          if (!m[k]) m[k] = { count: 0, sales: 0, completed: 0 };
          m[k].count += 1;
          if (o.status === "Completed") {
            m[k].sales += num(o.invoice_value);
            m[k].completed += 1;
          }
        }
        return Object.entries(m).map(([name, v]) => ({
          name, ...v,
          rate: v.count > 0 ? (v.completed / v.count) * 100 : 0,
        }));
      };

      const byStatus: Record<string, number> = {};
      for (const o of rangeOrders) byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;

      const byDay: Record<string, { date: string; total: number; completed: number }> = {};
      for (const o of rangeOrders) {
        const d = o.order_date;
        if (!byDay[d]) byDay[d] = { date: d.slice(5), total: 0, completed: 0 };
        byDay[d].total += num(o.invoice_value);
        if (o.status === "Completed") byDay[d].completed += num(o.invoice_value);
      }

      // CC verification by agent
      const verifByAgent: Record<string, { name: string; total: number; verified: number; nonVerified: number; verifiedValue: number; verifiedCount: number }> = {};
      for (const o of rangeOrders) {
        const k = o.agent_id ?? "—";
        const name = nameMap.get(o.agent_id) ?? "Unknown";
        if (!verifByAgent[k]) verifByAgent[k] = { name, total: 0, verified: 0, nonVerified: 0, verifiedValue: 0, verifiedCount: 0 };
        verifByAgent[k].total += 1;
        if (o.call_center_verified) {
          verifByAgent[k].verified += 1;
          verifByAgent[k].verifiedCount += 1;
          verifByAgent[k].verifiedValue += num(o.invoice_value);
        } else {
          verifByAgent[k].nonVerified += 1;
        }
      }
      let verifAgentRows = Object.entries(verifByAgent).map(([agentId, r]) => ({
        agentId, ...r, rate: r.total > 0 ? (r.verified / r.total) * 100 : 0,
      })).sort((a, b) => b.verified - a.verified);
      // Privacy: non-admin agents only see their own row in the CC Invoices tracking table
      if (!isAdmin && user?.id) {
        verifAgentRows = verifAgentRows.filter((r) => r.agentId === user.id);
      }

      const totalVerified = verifiedRows(rangeOrders).length;
      const totalNonVerified = rangeOrders.length - totalVerified;
      const totalVerifiedValue = sum(verifiedRows(rangeOrders));

      // Complaints aggregations
      const cmpByBranch: Record<string, { total: number; resolved: number }> = {};
      const cmpByCity: Record<string, { total: number; resolved: number }> = {};
      let cmpResolved = 0, cmpInProg = 0;
      for (const c of cmps) {
        const b = c.branch_no ?? "—";
        const city = cityMap.get(c.branch_no) ?? "—";
        if (!cmpByBranch[b]) cmpByBranch[b] = { total: 0, resolved: 0 };
        if (!cmpByCity[city]) cmpByCity[city] = { total: 0, resolved: 0 };
        cmpByBranch[b].total += 1;
        cmpByCity[city].total += 1;
        if (c.status === "Resolved") {
          cmpByBranch[b].resolved += 1;
          cmpByCity[city].resolved += 1;
          cmpResolved += 1;
        } else cmpInProg += 1;
      }
      const cmpBranchRows = Object.entries(cmpByBranch).map(([name, v]) => ({
        name, ...v, open: v.total - v.resolved, rate: v.total > 0 ? (v.resolved / v.total) * 100 : 0,
      })).sort((a, b) => b.total - a.total).slice(0, 10);
      const cmpCityRows = Object.entries(cmpByCity).map(([name, v]) => ({
        name, ...v, rate: v.total > 0 ? (v.resolved / v.total) * 100 : 0,
      })).sort((a, b) => b.total - a.total);

      return {
        monthAll, monthCompleted, monthCompletedCount,
        monthTotalCount: rangeOrders.length,
        monthCashSales: sum(cash(rangeOrders)),
        monthWasSales: sum(was(rangeOrders)),
        completionRate,
        totalVerified, totalNonVerified, totalVerifiedValue,
        verifRate: rangeOrders.length > 0 ? (totalVerified / rangeOrders.length) * 100 : 0,
        verifAgentRows: verifAgentRows.slice(0, 12),
        byAgent: groupAgg(rangeOrders, (o) => nameMap.get(o.agent_id) ?? "Unknown").sort((a, b) => b.sales - a.sales).slice(0, 10),
        byTeam: groupAgg(rangeOrders, (o) => o.team === "telesales" ? "Telesales" : "Customer Care"),
        byBranch: groupAgg(rangeOrders, (o) => o.branch_no ?? "—").sort((a, b) => b.sales - a.sales).slice(0, 10),
        byCity: groupAgg(rangeOrders, (o) => cityMap.get(o.branch_no) ?? "—").sort((a, b) => b.sales - a.sales),
        byDelivery: groupAgg(rangeOrders, (o) => o.delivery_type ?? "—"),
        byDeliveryBranch: (() => {
          const m: Record<string, Record<string, number>> = {};
          for (const o of completedRows(rangeOrders)) {
            const b = o.branch_no ?? "—";
            const d = o.delivery_type ?? "—";
            if (!m[b]) m[b] = {};
            m[b][d] = (m[b][d] ?? 0) + num(o.invoice_value);
          }
          return m;
        })(),
        byDeliveryCity: (() => {
          const m: Record<string, Record<string, number>> = {};
          for (const o of completedRows(rangeOrders)) {
            const c = cityMap.get(o.branch_no) ?? "—";
            const d = o.delivery_type ?? "—";
            if (!m[c]) m[c] = {};
            m[c][d] = (m[c][d] ?? 0) + num(o.invoice_value);
          }
          return m;
        })(),
        byStatus: Object.entries(byStatus).map(([name, value]) => ({ name, value })),
        pending: byStatus["Pending"] ?? 0,
        cancelled: byStatus["Cancelled"] ?? 0,
        byDay: Object.values(byDay).sort((a, b) => a.date.localeCompare(b.date)),
        cmpTotal: cmps.length, cmpResolved, cmpInProg,
        cmpResolutionRate: cmps.length > 0 ? (cmpResolved / cmps.length) * 100 : 0,
        cmpBranchRows, cmpCityRows,
      };
    },
  });

  const COLORS = ["var(--color-chart-1)", "var(--color-chart-2)", "var(--color-chart-3)", "var(--color-chart-4)", "var(--color-chart-5)"];
  const STATUS_COLORS: Record<string, string> = {
    Pending: "#eab308", Completed: "#16a34a", Cancelled: "#dc2626", "Follow-up": "#2563eb", "No Answer": "#6b7280",
  };

  const Stat = ({ label, value, accent, sub }: { label: string; value: string | number; accent?: string; sub?: string }) => (
    <Card>
      <CardContent className="p-3 sm:p-4">
        <div className="text-[10px] sm:text-[11px] uppercase tracking-wider text-muted-foreground truncate">{label}</div>
        <div className={`text-base sm:text-xl font-semibold mt-1 truncate ${accent ?? ""}`}>{value}</div>
        {sub && <div className="text-[10px] sm:text-[11px] text-muted-foreground mt-0.5 truncate">{sub}</div>}
      </CardContent>
    </Card>
  );

  const deliveryMethods = Array.from(new Set((data?.byDelivery ?? []).map((d) => d.name)));
  const selectedAgentLabel = isAdmin && agentFilter !== "all"
    ? (agents?.find((a: any) => a.id === agentFilter)?.full_name ?? "agent")
    : null;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 sm:flex sm:flex-wrap sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight truncate">Dashboard</h1>
          <p className="text-xs sm:text-sm text-muted-foreground truncate">
            {selectedAgentLabel ? `Performance for ${selectedAgentLabel}` : mineOnly ? "Your performance" : "Team performance"} · {dateLabel}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <Popover open={dateOpen} onOpenChange={setDateOpen}>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className={cn("font-normal", !range?.from && "text-muted-foreground")}>
                <CalendarIcon className="mr-2 h-4 w-4" />
                <span className="truncate max-w-[180px]">{dateLabel}</span>
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0 pointer-events-auto" align="end">
              <div className="flex flex-wrap gap-1 p-2 border-b">
                <Button size="sm" variant="ghost" onClick={() => setQuick("today")}>Today</Button>
                <Button size="sm" variant="ghost" onClick={() => setQuick("7d")}>Last 7 days</Button>
                <Button size="sm" variant="ghost" onClick={() => setQuick("30d")}>Last 30 days</Button>
                <Button size="sm" variant="ghost" onClick={() => setQuick("month")}>This month</Button>
              </div>
              <Calendar mode="range" selected={range} onSelect={setRange} numberOfMonths={1} defaultMonth={range?.from} className="pointer-events-auto [--cell-size:2.25rem]" />
            </PopoverContent>
          </Popover>
          {isAdmin ? (
            <>
              <Select value={teamFilter} onValueChange={(v) => { setTeamFilter(v); setAgentFilter("all"); }}>
                <SelectTrigger className="h-9 w-[150px]"><SelectValue placeholder="All teams" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All teams</SelectItem>
                  <SelectItem value="customer_care">Customer Care</SelectItem>
                  <SelectItem value="telesales">Telesales</SelectItem>
                </SelectContent>
              </Select>
              <Select value={agentFilter} onValueChange={setAgentFilter}>
                <SelectTrigger className="h-9 w-[170px] sm:w-[200px]"><SelectValue placeholder="All agents" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All agents</SelectItem>
                  {filteredAgents.map((a: any) => (
                    <SelectItem key={a.id} value={a.id}>{a.full_name}{a.agent_code ? ` (${a.agent_code})` : ""}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </>
          ) : (
            <Button variant={mineOnly ? "default" : "outline"} size="sm" onClick={() => setMineOnly((v) => !v)}>
              {mineOnly ? "My data" : "All data"}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => exportDashboard(data, { from, to, agentLabel: selectedAgentLabel, teamLabel: teamFilter })} disabled={!data}>
            <Download className="h-4 w-4 mr-2" />Export
          </Button>
        </div>
      </div>

      <div>
        <SectionTitle title="Performance for selected period" />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <KpiBlock label="Total orders" tone="from-slate-50 to-transparent dark:from-slate-500/10">
            <KpiBig value={data?.monthTotalCount ?? 0} />
            <KpiLine label="Pending" value={String(data?.pending ?? 0)} accent="text-amber-600 dark:text-amber-400" />
            <KpiLine label="Cancelled" value={String(data?.cancelled ?? 0)} accent="text-red-600 dark:text-red-400" />
            <KpiFoot value={`Avg ${data && data.monthTotalCount > 0 ? fmtSAR(data.monthAll / data.monthTotalCount) : "—"}`} />
          </KpiBlock>
          <KpiBlock label="Completed" tone="from-emerald-50 to-transparent dark:from-emerald-500/10" highlight>
            <KpiBig value={data?.monthCompletedCount ?? 0} accent="text-green-600 dark:text-green-400" />
            <KpiLine label="Completion rate" value={data ? `${data.completionRate.toFixed(1)}%` : "—"} />
            <KpiLine label="Completed sales" value={data ? fmtSAR(data.monthCompleted) : "—"} accent="text-green-600 dark:text-green-400" />
            <KpiFoot value={`of ${data?.monthTotalCount ?? 0} orders`} />
          </KpiBlock>
          <KpiBlock label="Cash" tone="from-amber-50 to-transparent dark:from-amber-500/10">
            <KpiBig value={data ? fmtSAR(data.monthCashSales) : "—"} />
            <KpiLine label="Sales" value={data ? fmtSAR(data.monthCashSales) : "—"} muted />
            <KpiFoot value="Cash orders" />
          </KpiBlock>
          <KpiBlock label="Wasfaty" tone="from-sky-50 to-transparent dark:from-sky-500/10">
            <KpiBig value={data ? fmtSAR(data.monthWasSales) : "—"} />
            <KpiLine label="Sales" value={data ? fmtSAR(data.monthWasSales) : "—"} muted />
            <KpiFoot value="Wasfaty orders" />
          </KpiBlock>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3 mt-3">
          <Stat label="Total sales" value={data ? fmtSAR(data.monthAll) : "—"} />
          <Stat label="Verified invoices" value={data?.totalVerified ?? 0} accent="text-green-600 dark:text-green-400" />
          <Stat label="Verification rate" value={data ? `${data.verifRate.toFixed(1)}%` : "—"} />
          <Stat label="Verified value" value={data ? fmtSAR(data.totalVerifiedValue) : "—"} />
        </div>
      </div>

      {/* Call Center Invoice Verification */}
      <div>
        <SectionTitle title="Call Center Invoice verification" />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
          <Stat label="Verified invoices" value={data?.totalVerified ?? 0} accent="text-green-600 dark:text-green-400" />
          <Stat label="Non-verified" value={data?.totalNonVerified ?? 0} accent="text-yellow-600 dark:text-yellow-400" />
          <Stat label="Verification rate" value={data ? `${data.verifRate.toFixed(1)}%` : "—"} />
          <Stat label="Verified value" value={data ? fmtSAR(data.totalVerifiedValue) : "—"} />
        </div>

        <Card className="mt-3">
          <CardHeader><CardTitle className="text-base">Call Center Invoices Tracking</CardTitle></CardHeader>
          <CardContent className="p-0 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2">Agent</th>
                  <th className="px-3 py-2 text-right">Total orders</th>
                  <th className="px-3 py-2 text-right">Verified</th>
                  <th className="px-3 py-2 text-right">Non-verified</th>
                  <th className="px-3 py-2 text-right">Rate</th>
                  <th className="px-3 py-2 text-right">Verified value</th>
                </tr>
              </thead>
              <tbody>
                {(data?.verifAgentRows ?? []).length === 0 && <tr><td colSpan={6} className="text-center text-muted-foreground py-6">No data</td></tr>}
                {(data?.verifAgentRows ?? []).map((r) => (
                  <tr key={r.name} className="border-b last:border-0">
                    <td className="px-3 py-2 font-medium whitespace-nowrap">{r.name}</td>
                    <td className="px-3 py-2 text-right">{r.total}</td>
                    <td className="px-3 py-2 text-right text-green-600 dark:text-green-400 font-semibold">{r.verified}</td>
                    <td className="px-3 py-2 text-right text-muted-foreground">{r.nonVerified}</td>
                    <td className="px-3 py-2 text-right">{r.rate.toFixed(0)}%</td>
                    <td className="px-3 py-2 text-right font-mono text-xs">{fmtSAR(r.verifiedValue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      </div>

      {/* Sales charts */}
      <div className="grid lg:grid-cols-2 gap-3 sm:gap-4">
        <Card>
          <CardHeader><CardTitle className="text-base">Daily sales trend</CardTitle></CardHeader>
          <CardContent className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data?.byDay ?? []}>
                <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v: any) => fmtSAR(v)} />
                <Legend />
                <Bar dataKey="completed" name="Completed" fill="#16a34a" radius={[4, 4, 0, 0]} />
                <Bar dataKey="total" name="All" fill="var(--color-chart-1)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Orders by status</CardTitle></CardHeader>
          <CardContent className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={data?.byStatus ?? []} dataKey="value" nameKey="name" outerRadius={80} label>
                  {(data?.byStatus ?? []).map((s, i) => <Cell key={i} fill={STATUS_COLORS[s.name] ?? COLORS[i % COLORS.length]} />)}
                </Pie>
                <Legend />
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Sales by team</CardTitle></CardHeader>
          <CardContent className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data?.byTeam ?? []}>
                <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v: any) => fmtSAR(v)} />
                <Bar dataKey="sales" name="Completed sales" fill="var(--color-chart-2)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Top agents by sales</CardTitle></CardHeader>
          <CardContent className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data?.byAgent ?? []} layout="vertical">
                <CartesianGrid horizontal={false} strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis type="number" tick={{ fontSize: 11 }} />
                <YAxis type="category" dataKey="name" width={130} tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v: any) => fmtSAR(v)} />
                <Bar dataKey="sales" fill="var(--color-chart-3)" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Sales by branch (top 10)</CardTitle></CardHeader>
          <CardContent className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data?.byBranch ?? []} layout="vertical">
                <CartesianGrid horizontal={false} strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis type="number" tick={{ fontSize: 11 }} />
                <YAxis type="category" dataKey="name" width={80} tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v: any) => fmtSAR(v)} />
                <Bar dataKey="sales" fill="var(--color-chart-4)" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Sales by city</CardTitle></CardHeader>
          <CardContent className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data?.byCity ?? []} layout="vertical">
                <CartesianGrid horizontal={false} strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis type="number" tick={{ fontSize: 11 }} />
                <YAxis type="category" dataKey="name" width={90} tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v: any) => fmtSAR(v)} />
                <Bar dataKey="sales" fill="var(--color-chart-5)" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      {/* Delivery method analysis */}
      <div>
        <SectionTitle title="Delivery methods" />
        <Card>
          <CardHeader><CardTitle className="text-base">Delivery method performance</CardTitle></CardHeader>
          <CardContent className="p-0 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2">Method</th>
                  <th className="px-3 py-2 text-right">Orders</th>
                  <th className="px-3 py-2 text-right">Completed sales</th>
                  <th className="px-3 py-2 text-right">Completion rate</th>
                </tr>
              </thead>
              <tbody>
                {(data?.byDelivery ?? []).length === 0 && <tr><td colSpan={4} className="text-center text-muted-foreground py-6">No data</td></tr>}
                {(data?.byDelivery ?? []).map((d) => (
                  <tr key={d.name} className="border-b last:border-0">
                    <td className="px-3 py-2 font-medium">{d.name}</td>
                    <td className="px-3 py-2 text-right">{d.count}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs">{fmtSAR(d.sales)}</td>
                    <td className="px-3 py-2 text-right">{d.rate.toFixed(0)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>

        <div className="grid lg:grid-cols-2 gap-3 sm:gap-4 mt-3">
          <DeliveryMatrix title="Sales by branch × delivery method" matrix={data?.byDeliveryBranch ?? {}} methods={deliveryMethods} />
          <DeliveryMatrix title="Sales by city × delivery method" matrix={data?.byDeliveryCity ?? {}} methods={deliveryMethods} />
        </div>
      </div>

      {/* Complaints analytics */}
      <div>
        <SectionTitle title="Complaints" />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
          <Stat label="Total complaints" value={data?.cmpTotal ?? 0} />
          <Stat label="In progress" value={data?.cmpInProg ?? 0} accent="text-amber-600 dark:text-amber-400" />
          <Stat label="Resolved" value={data?.cmpResolved ?? 0} accent="text-green-600 dark:text-green-400" />
          <Stat label="Resolution rate" value={data ? `${data.cmpResolutionRate.toFixed(1)}%` : "—"} />
        </div>

        <div className="grid lg:grid-cols-2 gap-3 sm:gap-4 mt-3">
          <Card>
            <CardHeader><CardTitle className="text-base">Complaints by branch (top 10)</CardTitle></CardHeader>
            <CardContent className="p-0 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="px-3 py-2">Branch</th>
                    <th className="px-3 py-2 text-right">Total</th>
                    <th className="px-3 py-2 text-right">Resolved</th>
                    <th className="px-3 py-2 text-right">Open</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.cmpBranchRows ?? []).length === 0 && <tr><td colSpan={4} className="text-center text-muted-foreground py-6">No data</td></tr>}
                  {(data?.cmpBranchRows ?? []).map((r) => (
                    <tr key={r.name} className="border-b last:border-0">
                      <td className="px-3 py-2 font-medium">{r.name}</td>
                      <td className="px-3 py-2 text-right">{r.total}</td>
                      <td className="px-3 py-2 text-right text-green-600 dark:text-green-400">{r.resolved}</td>
                      <td className="px-3 py-2 text-right text-amber-600 dark:text-amber-400">{r.open}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">Complaints by city</CardTitle></CardHeader>
            <CardContent className="p-0 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="px-3 py-2">City</th>
                    <th className="px-3 py-2 text-right">Total</th>
                    <th className="px-3 py-2 text-right">Resolution rate</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.cmpCityRows ?? []).length === 0 && <tr><td colSpan={3} className="text-center text-muted-foreground py-6">No data</td></tr>}
                  {(data?.cmpCityRows ?? []).map((r) => (
                    <tr key={r.name} className="border-b last:border-0">
                      <td className="px-3 py-2 font-medium">{r.name}</td>
                      <td className="px-3 py-2 text-right">{r.total}</td>
                      <td className="px-3 py-2 text-right">{r.rate.toFixed(0)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function DeliveryMatrix({ title, matrix, methods }: { title: string; matrix: Record<string, Record<string, number>>; methods: string[] }) {
  const rows = Object.entries(matrix).map(([k, v]) => ({ k, v, total: Object.values(v).reduce((s, n) => s + n, 0) }))
    .sort((a, b) => b.total - a.total).slice(0, 10);
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">{title}</CardTitle></CardHeader>
      <CardContent className="p-0 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="px-3 py-2">Key</th>
              {methods.map((m) => <th key={m} className="px-3 py-2 text-right">{m}</th>)}
              <th className="px-3 py-2 text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={methods.length + 2} className="text-center text-muted-foreground py-6">No data</td></tr>}
            {rows.map((r) => (
              <tr key={r.k} className="border-b last:border-0">
                <td className="px-3 py-2 font-medium">{r.k}</td>
                {methods.map((m) => <td key={m} className="px-3 py-2 text-right font-mono text-xs">{r.v[m] ? fmtSAR(r.v[m]) : "—"}</td>)}
                <td className="px-3 py-2 text-right font-mono text-xs font-semibold">{fmtSAR(r.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

function SectionTitle({ title }: { title: string }) {
  return (
    <div className="mb-3 mt-2 flex items-end gap-3">
      <h2 className="text-lg sm:text-xl font-semibold tracking-tight text-foreground">{title}</h2>
      <div className="flex-1 h-px bg-border" />
    </div>
  );
}

function KpiBlock({ label, tone, highlight, children }: { label: string; tone: string; highlight?: boolean; children: React.ReactNode }) {
  return (
    <div className={cn("relative rounded-lg border bg-gradient-to-br p-4", tone, highlight && "border-primary/40 shadow-sm")}>
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">{label}</div>
      <div className="mt-2 space-y-1.5">{children}</div>
    </div>
  );
}
function KpiBig({ value, accent }: { value: string | number; accent?: string }) {
  return <div className={cn("text-2xl sm:text-3xl font-bold tabular-nums leading-tight", accent)}>{value}</div>;
}
function KpiLine({ label, value, accent, muted }: { label: string; value: string; accent?: string; muted?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn("text-sm font-semibold tabular-nums truncate", accent, muted && !accent && "text-foreground")}>{value}</span>
    </div>
  );
}
function KpiFoot({ value }: { value: string }) {
  return <div className="text-[11px] text-muted-foreground mt-1 pt-1.5 border-t border-border/60">{value}</div>;
}

function exportDashboard(
  data: any,
  ctx: { from: string; to: string; agentLabel: string | null; teamLabel: string },
) {
  if (!data) return;
  const wb = XLSX.utils.book_new();
  const teamLbl = ctx.teamLabel === "customer_care" ? "Customer Care" : ctx.teamLabel === "telesales" ? "Telesales" : "All Teams";
  const summary = [
    ["MilaServ Daily Log — Dashboard Export"],
    ["Period", `${ctx.from} to ${ctx.to}`],
    ["Team", teamLbl],
    ["Agent", ctx.agentLabel ?? "All agents"],
    [],
    ["KPI", "Value"],
    ["Total orders", data.monthTotalCount],
    ["Completed orders", data.monthCompletedCount],
    ["Pending", data.pending],
    ["Cancelled", data.cancelled],
    ["Completion rate (%)", Number(data.completionRate.toFixed(2))],
    ["Total sales", data.monthAll],
    ["Completed sales", data.monthCompleted],
    ["Cash sales", data.monthCashSales],
    ["Wasfaty sales", data.monthWasSales],
    ["Avg order value", data.monthTotalCount > 0 ? data.monthAll / data.monthTotalCount : 0],
    ["Verified invoices", data.totalVerified],
    ["Non-verified", data.totalNonVerified],
    ["Verification rate (%)", Number(data.verifRate.toFixed(2))],
    ["Verified value", data.totalVerifiedValue],
    [],
    ["Complaints", ""],
    ["Total complaints", data.cmpTotal],
    ["In progress", data.cmpInProg],
    ["Resolved", data.cmpResolved],
    ["Resolution rate (%)", Number(data.cmpResolutionRate.toFixed(2))],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summary), "Summary");

  const sheet = (name: string, rows: any[]) => {
    if (!rows || rows.length === 0) return;
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), name.slice(0, 31));
  };
  sheet("Daily Sales", (data.byDay ?? []).map((d: any) => ({ Date: d.date, "All Sales": d.total, "Completed Sales": d.completed })));
  sheet("By Status", (data.byStatus ?? []).map((s: any) => ({ Status: s.name, Count: s.value })));
  sheet("By Team", (data.byTeam ?? []).map((t: any) => ({ Team: t.name, Orders: t.count, "Completed Sales": t.sales, "Completion Rate %": Number(t.rate.toFixed(1)) })));
  sheet("By Agent", (data.byAgent ?? []).map((a: any) => ({ Agent: a.name, Orders: a.count, "Completed Sales": a.sales, "Completion Rate %": Number(a.rate.toFixed(1)) })));
  sheet("By Branch", (data.byBranch ?? []).map((b: any) => ({ Branch: b.name, Orders: b.count, "Completed Sales": b.sales, "Completion Rate %": Number(b.rate.toFixed(1)) })));
  sheet("By City", (data.byCity ?? []).map((c: any) => ({ City: c.name, Orders: c.count, "Completed Sales": c.sales, "Completion Rate %": Number(c.rate.toFixed(1)) })));
  sheet("Delivery Methods", (data.byDelivery ?? []).map((d: any) => ({ Method: d.name, Orders: d.count, "Completed Sales": d.sales, "Completion Rate %": Number(d.rate.toFixed(1)) })));
  sheet("CC Verification by Agent", (data.verifAgentRows ?? []).map((r: any) => ({ Agent: r.name, "Total Orders": r.total, Verified: r.verified, "Non-verified": r.nonVerified, "Rate %": Number(r.rate.toFixed(1)), "Verified Value": r.verifiedValue })));
  sheet("Complaints by Branch", (data.cmpBranchRows ?? []).map((r: any) => ({ Branch: r.name, Total: r.total, Resolved: r.resolved, Open: r.open, "Resolution Rate %": Number(r.rate.toFixed(1)) })));
  sheet("Complaints by City", (data.cmpCityRows ?? []).map((r: any) => ({ City: r.name, Total: r.total, "Resolution Rate %": Number(r.rate.toFixed(1)) })));

  XLSX.writeFile(wb, `dashboard_${ctx.from}_${ctx.to}.xlsx`);
}
