import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, CartesianGrid, PieChart, Pie, Cell, Legend } from "recharts";

export const Route = createFileRoute("/_app/dashboard")({
  head: () => ({ meta: [{ title: "Dashboard — Orders" }] }),
  component: Dashboard,
});

function Dashboard() {
  const { data } = useQuery({
    queryKey: ["dashboard"],
    queryFn: async () => {
      const today = new Date().toISOString().slice(0, 10);
      const start = new Date(); start.setDate(start.getDate() - 30);
      const startISO = start.toISOString().slice(0, 10);
      const [{ data: orders }, { data: branches }, { data: profiles }] = await Promise.all([
        supabase.from("orders").select("id,order_date,team,agent_id,branch_no,invoice_value,status").gte("order_date", startISO),
        supabase.from("branches").select("branch_no,city"),
        supabase.from("profiles").select("id,full_name"),
      ]);
      const cityMap = new Map((branches ?? []).map((b: any) => [b.branch_no, b.city]));
      const nameMap = new Map((profiles ?? []).map((p: any) => [p.id, p.full_name]));
      const all = orders ?? [];
      const todayCount = all.filter((o: any) => o.order_date === today).length;
      const totalValue = all.reduce((s: number, o: any) => s + Number(o.invoice_value ?? 0), 0);
      const completed = all.filter((o: any) => o.status === "Completed").length;
      const cityAgg: Record<string, number> = {};
      const branchAgg: Record<string, number> = {};
      const agentAgg: Record<string, number> = {};
      const teamAgg: Record<string, number> = { customer_care: 0, telesales: 0 };
      const dayAgg: Record<string, number> = {};
      for (const o of all) {
        const c = cityMap.get(o.branch_no) ?? "—";
        cityAgg[c] = (cityAgg[c] ?? 0) + 1;
        branchAgg[o.branch_no ?? "—"] = (branchAgg[o.branch_no ?? "—"] ?? 0) + 1;
        const an = nameMap.get(o.agent_id) ?? "Unknown";
        agentAgg[an] = (agentAgg[an] ?? 0) + 1;
        teamAgg[o.team] = (teamAgg[o.team] ?? 0) + 1;
        dayAgg[o.order_date] = (dayAgg[o.order_date] ?? 0) + 1;
      }
      return {
        todayCount, totalValue, completed, total: all.length,
        byCity: Object.entries(cityAgg).map(([city, count]) => ({ city, count })).sort((a, b) => b.count - a.count),
        byBranch: Object.entries(branchAgg).map(([branch, count]) => ({ branch, count })).sort((a, b) => b.count - a.count).slice(0, 10),
        byAgent: Object.entries(agentAgg).map(([agent, count]) => ({ agent, count })).sort((a, b) => b.count - a.count).slice(0, 10),
        byTeam: [
          { name: "Customer Care", value: teamAgg.customer_care },
          { name: "Telesales", value: teamAgg.telesales },
        ],
        byDay: Object.entries(dayAgg).map(([date, count]) => ({ date: date.slice(5), count })).sort((a, b) => a.date.localeCompare(b.date)),
      };
    },
  });

  const COLORS = ["var(--color-chart-1)", "var(--color-chart-2)", "var(--color-chart-3)", "var(--color-chart-4)", "var(--color-chart-5)"];

  const Stat = ({ label, value }: { label: string; value: string | number }) => (
    <Card><CardContent className="p-5"><div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div><div className="text-2xl font-semibold mt-1">{value}</div></CardContent></Card>
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">Last 30 days · live data</p>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Stat label="Today's orders" value={data?.todayCount ?? "—"} />
        <Stat label="Orders (30d)" value={data?.total ?? "—"} />
        <Stat label="Completed (30d)" value={data?.completed ?? "—"} />
        <Stat label="Invoice value (30d)" value={data ? data.totalValue.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—"} />
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader><CardTitle className="text-base">Orders per day</CardTitle></CardHeader>
          <CardContent className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data?.byDay ?? []}>
                <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip />
                <Bar dataKey="count" fill="var(--color-chart-1)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">Customer Care vs Telesales</CardTitle></CardHeader>
          <CardContent className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={data?.byTeam ?? []} dataKey="value" nameKey="name" outerRadius={80} label>
                  {(data?.byTeam ?? []).map((_, i) => <Cell key={i} fill={COLORS[i]} />)}
                </Pie>
                <Legend />
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">Orders by city</CardTitle></CardHeader>
          <CardContent className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data?.byCity ?? []} layout="vertical">
                <CartesianGrid horizontal={false} strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis type="number" tick={{ fontSize: 11 }} allowDecimals={false} />
                <YAxis type="category" dataKey="city" width={80} tick={{ fontSize: 11 }} />
                <Tooltip />
                <Bar dataKey="count" fill="var(--color-chart-2)" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">Top agents</CardTitle></CardHeader>
          <CardContent className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data?.byAgent ?? []} layout="vertical">
                <CartesianGrid horizontal={false} strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis type="number" tick={{ fontSize: 11 }} allowDecimals={false} />
                <YAxis type="category" dataKey="agent" width={130} tick={{ fontSize: 11 }} />
                <Tooltip />
                <Bar dataKey="count" fill="var(--color-chart-3)" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
