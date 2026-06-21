import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, CartesianGrid, PieChart, Pie, Cell, Legend } from "recharts";
import { fmtSAR } from "@/lib/branches";

export const Route = createFileRoute("/_app/dashboard")({
  head: () => ({ meta: [{ title: "Dashboard — MilaServ Daily Log" }] }),
  component: Dashboard,
});

function Dashboard() {
  const { user } = useAuth();
  const [mineOnly, setMineOnly] = useState(false);

  const { data } = useQuery({
    queryKey: ["dashboard", mineOnly, user?.id],
    queryFn: async () => {
      const today = new Date().toISOString().slice(0, 10);
      const start = new Date(); start.setDate(start.getDate() - 30);
      const startISO = start.toISOString().slice(0, 10);
      const monthStart = new Date(); monthStart.setDate(1);
      const monthISO = monthStart.toISOString().slice(0, 10);
      const earliest = monthISO < startISO ? monthISO : startISO;
      let qb = supabase.from("orders")
        .select("id,order_date,team,agent_id,branch_no,invoice_value,status,order_type,delivery_type")
        .gte("order_date", earliest);
      if (mineOnly && user?.id) qb = qb.eq("agent_id", user.id);
      const [{ data: orders }, { data: branches }, { data: profiles }] = await Promise.all([
        qb,
        supabase.from("branches").select("branch_no,city"),
        supabase.from("profiles").select("id,full_name"),
      ]);
      const cityMap = new Map((branches ?? []).map((b: any) => [b.branch_no, b.city]));
      const nameMap = new Map((profiles ?? []).map((p: any) => [p.id, p.full_name]));
      const all = (orders ?? []).filter((o: any) => o.order_date >= startISO);
      const todayOrders = (orders ?? []).filter((o: any) => o.order_date === today);
      const monthOrders = (orders ?? []).filter((o: any) => o.order_date >= monthISO);

      const num = (v: any) => Number(v ?? 0);
      const sum = (rows: any[]) => rows.reduce((s, o) => s + num(o.invoice_value), 0);
      const completedRows = (rows: any[]) => rows.filter((o) => o.status === "Completed");

      const monthAll = sum(monthOrders);
      const monthCompleted = sum(completedRows(monthOrders));
      const monthCompletedCount = completedRows(monthOrders).length;
      const completionRate = monthOrders.length > 0 ? (monthCompletedCount / monthOrders.length) * 100 : 0;

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
      for (const o of monthOrders) byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;

      const byDay: Record<string, { date: string; total: number; completed: number }> = {};
      for (const o of all) {
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
        monthAll,
        monthCompleted,
        monthCompletedCount,
        monthTotalCount: monthOrders.length,
        completionRate,
        byAgent: groupAgg(monthOrders, (o) => nameMap.get(o.agent_id) ?? "Unknown").sort((a, b) => b.sales - a.sales).slice(0, 10),
        byTeam: groupAgg(monthOrders, (o) => o.team === "telesales" ? "Telesales" : "Customer Care"),
        byBranch: groupAgg(monthOrders, (o) => o.branch_no ?? "—").sort((a, b) => b.sales - a.sales).slice(0, 10),
        byCity: groupAgg(monthOrders, (o) => cityMap.get(o.branch_no) ?? "—").sort((a, b) => b.sales - a.sales),
        byDelivery: groupAgg(monthOrders, (o) => o.delivery_type ?? "—"),
        byDeliveryBranch: (() => {
          const m: Record<string, Record<string, number>> = {};
          for (const o of completedRows(monthOrders)) {
            const b = o.branch_no ?? "—";
            const d = o.delivery_type ?? "—";
            if (!m[b]) m[b] = {};
            m[b][d] = (m[b][d] ?? 0) + num(o.invoice_value);
          }
          return m;
        })(),
        byDeliveryCity: (() => {
          const m: Record<string, Record<string, number>> = {};
          for (const o of completedRows(monthOrders)) {
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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground">{mineOnly ? "Your performance" : "Team performance"} — today and last 30 days</p>
        </div>
        <Button variant={mineOnly ? "default" : "outline"} size="sm" onClick={() => setMineOnly((v) => !v)}>
          {mineOnly ? "My data" : "All data"}
        </Button>
      </div>

      <div>
        <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">Today</div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label="Orders today" value={data?.todayCount ?? "—"} />
          <Stat label="Completed today" value={data?.todayCompletedCount ?? "—"} accent="text-green-600 dark:text-green-400" />
          <Stat label="Sales today" value={data ? fmtSAR(data.todaySales) : "—"} />
          <Stat label="Completed sales today" value={data ? fmtSAR(data.todayCompletedSales) : "—"} accent="text-green-600 dark:text-green-400" />
        </div>
      </div>

      <div>
        <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">This month</div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label="Total sales (all orders)" value={data ? fmtSAR(data.monthAll) : "—"} />
          <Stat label="Completed sales" value={data ? fmtSAR(data.monthCompleted) : "—"} accent="text-green-600 dark:text-green-400" />
          <Stat label="Completed orders" value={data?.monthCompletedCount ?? "—"} sub={`of ${data?.monthTotalCount ?? 0}`} />
          <Stat label="Completion rate" value={data ? `${data.completionRate.toFixed(1)}%` : "—"} />
        </div>
      </div>

      <div>
        <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">Status overview (month)</div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label="Pending" value={data?.pending ?? 0} accent="text-yellow-600 dark:text-yellow-400" />
          <Stat label="Cancelled" value={data?.cancelled ?? 0} accent="text-red-600 dark:text-red-400" />
          <Stat label="Completed" value={data?.monthCompletedCount ?? 0} accent="text-green-600 dark:text-green-400" />
          <Stat label="Total orders" value={data?.monthTotalCount ?? 0} />
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader><CardTitle className="text-base">Daily sales trend (30d)</CardTitle></CardHeader>
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
          <CardHeader><CardTitle className="text-base">Orders by status (month)</CardTitle></CardHeader>
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
          <CardHeader><CardTitle className="text-base">Sales by team (month)</CardTitle></CardHeader>
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
          <CardHeader><CardTitle className="text-base">Top agents by sales (month)</CardTitle></CardHeader>
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
        <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">Delivery methods (month)</div>
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
