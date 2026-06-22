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
import { CalendarIcon } from "lucide-react";
import { cn } from "@/lib/utils";

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

  const { data: agents } = useQuery({
    queryKey: ["dashboard-agents"],
    queryFn: async () => {
      const { data } = await supabase.from("profiles").select("id,full_name,agent_code").order("full_name");
      return data ?? [];
    },
    enabled: isAdmin,
  });

  const { data } = useQuery({
    queryKey: ["dashboard", from, to, effectiveAgent],
    queryFn: async () => {
      const todayISO = toISO(new Date());
      let qb = supabase.from("orders")
        .select("id,order_date,team,agent_id,branch_no,invoice_value,status,order_type,delivery_type")
        .gte("order_date", from).lte("order_date", to);
      if (effectiveAgent !== "all") qb = qb.eq("agent_id", effectiveAgent);
      const [{ data: orders }, { data: branches }, { data: profiles }] = await Promise.all([
        qb,
        supabase.from("branches").select("branch_no,city"),
        supabase.from("profiles").select("id,full_name"),
      ]);
      const cityMap = new Map((branches ?? []).map((b: any) => [b.branch_no, b.city]));
      const nameMap = new Map((profiles ?? []).map((p: any) => [p.id, p.full_name]));
      const rangeOrders = orders ?? [];
      const todayOrders = rangeOrders.filter((o: any) => o.order_date === todayISO);

      const num = (v: any) => Number(v ?? 0);
      const sum = (rows: any[]) => rows.reduce((s, o) => s + num(o.invoice_value), 0);
      const completedRows = (rows: any[]) => rows.filter((o) => o.status === "Completed");
      const cash = (rows: any[]) => rows.filter((o: any) => o.order_type === "Cash");
      const was = (rows: any[]) => rows.filter((o: any) => o.order_type === "Wasfaty");

      const monthAll = sum(rangeOrders);
      const monthCompleted = sum(completedRows(rangeOrders));
      const monthCompletedCount = completedRows(rangeOrders).length;
      const completionRate = rangeOrders.length > 0 ? (monthCompletedCount / rangeOrders.length) * 100 : 0;

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
        return Object.entries(m).map(([name, v]) => ({ name, ...v }));
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

      return {
        todayCount: todayOrders.length,
        todayCompletedCount: completedRows(todayOrders).length,
        todaySales: sum(todayOrders),
        todayCompletedSales: sum(completedRows(todayOrders)),
        todayCashSales: sum(cash(todayOrders)),
        todayWasSales: sum(was(todayOrders)),
        monthAll,
        monthCompleted,
        monthCompletedCount,
        monthTotalCount: rangeOrders.length,
        monthCashSales: sum(cash(rangeOrders)),
        monthWasSales: sum(was(rangeOrders)),
        completionRate,
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
      };
    },
  });

  const COLORS = ["var(--color-chart-1)", "var(--color-chart-2)", "var(--color-chart-3)", "var(--color-chart-4)", "var(--color-chart-5)"];
  const STATUS_COLORS: Record<string, string> = {
    Pending: "#eab308",
    Completed: "#16a34a",
    Cancelled: "#dc2626",
    "Follow-up": "#2563eb",
    "No Answer": "#6b7280",
  };

  const Stat = ({ label, value, accent, sub }: { label: string; value: string | number; accent?: string; sub?: string }) => (
    <Card>
      <CardContent className="p-4">
        <div className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</div>
        <div className={`text-xl font-semibold mt-1 ${accent ?? ""}`}>{value}</div>
        {sub && <div className="text-[11px] text-muted-foreground mt-0.5">{sub}</div>}
      </CardContent>
    </Card>
  );

  const deliveryMethods = Array.from(new Set((data?.byDelivery ?? []).map((d) => d.name)));
  const selectedAgentLabel = isAdmin && agentFilter !== "all"
    ? (agents?.find((a: any) => a.id === agentFilter)?.full_name ?? "agent")
    : null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            {selectedAgentLabel ? `Performance for ${selectedAgentLabel}` : mineOnly ? "Your performance" : "Team performance"} · {dateLabel}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Popover open={dateOpen} onOpenChange={setDateOpen}>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className={cn("font-normal", !range?.from && "text-muted-foreground")}>
                <CalendarIcon className="mr-2 h-4 w-4" />
                {dateLabel}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0 pointer-events-auto" align="end">
              <div className="flex flex-wrap gap-1 p-2 border-b">
                <Button size="sm" variant="ghost" onClick={() => setQuick("today")}>Today</Button>
                <Button size="sm" variant="ghost" onClick={() => setQuick("7d")}>Last 7 days</Button>
                <Button size="sm" variant="ghost" onClick={() => setQuick("30d")}>Last 30 days</Button>
                <Button size="sm" variant="ghost" onClick={() => setQuick("month")}>This month</Button>
              </div>
              <Calendar mode="range" selected={range} onSelect={setRange} numberOfMonths={2} defaultMonth={range?.from} className="pointer-events-auto" />
            </PopoverContent>
          </Popover>
          {isAdmin ? (
            <Select value={agentFilter} onValueChange={setAgentFilter}>
              <SelectTrigger className="h-9 w-[200px]"><SelectValue placeholder="All agents" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All agents</SelectItem>
                {(agents ?? []).map((a: any) => (
                  <SelectItem key={a.id} value={a.id}>{a.full_name}{a.agent_code ? ` (${a.agent_code})` : ""}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Button variant={mineOnly ? "default" : "outline"} size="sm" onClick={() => setMineOnly((v) => !v)}>
              {mineOnly ? "My data" : "All data"}
            </Button>
          )}
        </div>
      </div>

      <div>
        <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">Today</div>
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
          <Stat label="Orders today" value={data?.todayCount ?? "—"} />
          <Stat label="Completed today" value={data?.todayCompletedCount ?? "—"} accent="text-green-600 dark:text-green-400" />
          <Stat label="Cash sales today" value={data ? fmtSAR(data.todayCashSales) : "—"} />
          <Stat label="Wasfaty sales today" value={data ? fmtSAR(data.todayWasSales) : "—"} />
          <Stat label="Sales today" value={data ? fmtSAR(data.todaySales) : "—"} />
          <Stat label="Completed sales today" value={data ? fmtSAR(data.todayCompletedSales) : "—"} accent="text-green-600 dark:text-green-400" />
        </div>
      </div>

      <div>
        <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">Selected range</div>
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
          <Stat label="Total orders" value={data?.monthTotalCount ?? "—"} />
          <Stat label="Completed orders" value={data?.monthCompletedCount ?? "—"} sub={`of ${data?.monthTotalCount ?? 0}`} accent="text-green-600 dark:text-green-400" />
          <Stat label="Cash sales" value={data ? fmtSAR(data.monthCashSales) : "—"} />
          <Stat label="Wasfaty sales" value={data ? fmtSAR(data.monthWasSales) : "—"} />
          <Stat label="Total sales" value={data ? fmtSAR(data.monthAll) : "—"} />
          <Stat label="Completed sales" value={data ? fmtSAR(data.monthCompleted) : "—"} accent="text-green-600 dark:text-green-400" />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3">
          <Stat label="Pending" value={data?.pending ?? 0} accent="text-yellow-600 dark:text-yellow-400" />
          <Stat label="Cancelled" value={data?.cancelled ?? 0} accent="text-red-600 dark:text-red-400" />
          <Stat label="Completion rate" value={data ? `${data.completionRate.toFixed(1)}%` : "—"} />
          <Stat label="Avg order value" value={data && data.monthTotalCount > 0 ? fmtSAR(data.monthAll / data.monthTotalCount) : "—"} />
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
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

      <div>
        <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">Delivery methods</div>
        <div className="grid lg:grid-cols-2 gap-4">
          <Card>
            <CardHeader><CardTitle className="text-base">Orders & sales by delivery method</CardTitle></CardHeader>
            <CardContent className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data?.byDelivery ?? []}>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--color-border)" />
                  <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                  <YAxis yAxisId="l" tick={{ fontSize: 11 }} />
                  <YAxis yAxisId="r" orientation="right" tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Legend />
                  <Bar yAxisId="l" dataKey="count" name="Orders" fill="var(--color-chart-1)" radius={[4, 4, 0, 0]} />
                  <Bar yAxisId="r" dataKey="sales" name="Completed sales" fill="#16a34a" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">Delivery method distribution</CardTitle></CardHeader>
            <CardContent className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={data?.byDelivery ?? []} dataKey="count" nameKey="name" outerRadius={80} label>
                    {(data?.byDelivery ?? []).map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                  </Pie>
                  <Legend />
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </div>

        <div className="grid lg:grid-cols-2 gap-4 mt-4">
          <DeliveryMatrix title="Sales by branch × delivery method" matrix={data?.byDeliveryBranch ?? {}} methods={deliveryMethods} />
          <DeliveryMatrix title="Sales by city × delivery method" matrix={data?.byDeliveryCity ?? {}} methods={deliveryMethods} />
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
