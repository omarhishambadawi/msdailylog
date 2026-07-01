import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, CartesianGrid, PieChart, Pie, Cell, Legend } from "recharts";
import { PhoneCall, PhoneMissed, PhoneIncoming, PhoneOutgoing, PhoneOff, Phone } from "lucide-react";
import { getYeastarCallStats } from "@/lib/yeastar.functions";

interface Props {
  from: string;
  to: string;
  team: "customer_care" | "telesales" | "all";
  agentId?: string;
}

const COLORS = {
  answered: "#10b981",
  missed: "#ef4444",
  inbound: "#3b82f6",
  outbound: "#f59e0b",
  cc: "#6366f1",
  ts: "#14b8a6",
};

function Stat({ icon: Icon, label, value, tone }: { icon: any; label: string; value: number | string; tone?: string }) {
  return (
    <Card>
      <CardContent className="p-3 sm:p-4 flex items-center gap-3">
        <div className={`shrink-0 h-9 w-9 rounded-md flex items-center justify-center ${tone ?? "bg-primary/10 text-primary"}`}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <div className="text-[10px] sm:text-[11px] uppercase tracking-wider text-muted-foreground truncate">{label}</div>
          <div className="text-lg sm:text-xl font-semibold tabular-nums truncate">{value}</div>
        </div>
      </CardContent>
    </Card>
  );
}

export function CallCenterAnalytics({ from, to, team, agentId }: Props) {
  const fetchStats = useServerFn(getYeastarCallStats);
  const { data, isLoading, isError } = useQuery({
    queryKey: ["yeastar-stats", from, to, team, agentId ?? "all"],
    queryFn: () => fetchStats({ data: { from, to, team, agentId } }),
    staleTime: 60_000, // cache 1 min
    refetchOnWindowFocus: false,
  });

  if (isLoading) {
    return <Card><CardContent className="p-6 text-sm text-muted-foreground">Loading call center analytics…</CardContent></Card>;
  }
  if (isError || !data) {
    return <Card><CardContent className="p-6 text-sm text-muted-foreground">Unable to load call center analytics.</CardContent></Card>;
  }

  if (!("configured" in data) || !data.configured) {
    return (
      <Card>
        <CardHeader><CardTitle className="text-base">Call Center Analytics</CardTitle></CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Yeastar PBX is not connected yet. Ask an administrator to set the <code className="px-1 py-0.5 rounded bg-muted">YEASTAR_BASE_URL</code> secret pointing to your PBX (e.g. <code className="px-1 py-0.5 rounded bg-muted">https://your-pbx.example.com</code>) to enable call analytics.
        </CardContent>
      </Card>
    );
  }

  if ("error" in data && data.error) {
    return (
      <Card>
        <CardHeader><CardTitle className="text-base">Call Center Analytics</CardTitle></CardHeader>
        <CardContent className="text-sm text-muted-foreground">{String(data.error)}</CardContent>
      </Card>
    );
  }

  const teamData = [
    { name: "Customer Care", calls: data.byTeam.customerCare, fill: COLORS.cc },
    { name: "Telesales", calls: data.byTeam.telesales, fill: COLORS.ts },
  ];
  const answeredMissed = [
    { name: "Answered", value: data.answered, fill: COLORS.answered },
    { name: "Missed", value: data.missed, fill: COLORS.missed },
  ];
  const inboundOutbound = [
    { name: "Inbound", value: data.inbound, fill: COLORS.inbound },
    { name: "Outbound", value: data.outbound, fill: COLORS.outbound },
  ];
  const topAgents = data.byAgent.slice(0, 10);

  return (
    <div className="space-y-3 sm:space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 sm:gap-3">
        <Stat icon={Phone} label="Total calls" value={data.total} />
        <Stat icon={PhoneCall} label="Answered" value={data.answered} tone="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" />
        <Stat icon={PhoneMissed} label="Missed" value={data.missed} tone="bg-red-500/10 text-red-600 dark:text-red-400" />
        <Stat icon={PhoneIncoming} label="Inbound" value={data.inbound} tone="bg-sky-500/10 text-sky-600 dark:text-sky-400" />
        <Stat icon={PhoneOutgoing} label="Outbound" value={data.outbound} tone="bg-amber-500/10 text-amber-600 dark:text-amber-400" />
      </div>

      <div className="grid lg:grid-cols-3 gap-3 sm:gap-4">
        <Card>
          <CardHeader><CardTitle className="text-base">Calls by team</CardTitle></CardHeader>
          <CardContent className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={teamData}>
                <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip />
                <Bar dataKey="calls" radius={[4, 4, 0, 0]}>
                  {teamData.map((t, i) => <Cell key={i} fill={t.fill} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Answered vs Missed</CardTitle></CardHeader>
          <CardContent className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={answeredMissed} dataKey="value" nameKey="name" outerRadius={70} label>
                  {answeredMissed.map((s, i) => <Cell key={i} fill={s.fill} />)}
                </Pie>
                <Legend />
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Inbound vs Outbound</CardTitle></CardHeader>
          <CardContent className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={inboundOutbound} dataKey="value" nameKey="name" outerRadius={70} label>
                  {inboundOutbound.map((s, i) => <Cell key={i} fill={s.fill} />)}
                </Pie>
                <Legend />
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Calls by agent</CardTitle></CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="px-3 py-2">Agent</th>
                <th className="px-3 py-2 text-right">Total</th>
                <th className="px-3 py-2 text-right">Answered</th>
                <th className="px-3 py-2 text-right">Missed</th>
                <th className="px-3 py-2 text-right">Inbound</th>
                <th className="px-3 py-2 text-right">Outbound</th>
              </tr>
            </thead>
            <tbody>
              {topAgents.length === 0 && (
                <tr><td colSpan={6} className="text-center text-muted-foreground py-6">No calls in this period</td></tr>
              )}
              {topAgents.map((a) => (
                <tr key={a.extension} className="border-b last:border-0">
                  <td className="px-3 py-2 font-medium whitespace-nowrap">{a.agentName}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{a.total}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-emerald-600 dark:text-emerald-400">{a.answered}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-red-600 dark:text-red-400">{a.missed}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{a.inbound}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{a.outbound}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.byAgent.length > 10 && (
            <div className="px-3 py-2 text-xs text-muted-foreground border-t">Showing top 10 of {data.byAgent.length} agents.</div>
          )}
        </CardContent>
      </Card>

      <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
        <PhoneOff className="h-3 w-3" /> Call data provided by Yeastar PBX · cached for 1 minute · follows the dashboard's date, team and agent filters.
      </p>
    </div>
  );
}
