import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useMemo, useState } from "react";
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, CartesianGrid, PieChart, Pie, Cell, Legend, AreaChart, Area } from "recharts";
import { fmtSAR } from "@/lib/branches";
import { format } from "date-fns";
import type { DateRange } from "react-day-picker";
import { Download, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";
// xlsx is lazy-loaded inside exportDashboard() to keep it out of this route's
// initial chunk — Dashboard is the default landing route for most roles, and the
// library is only needed once the user clicks Export.
import { DateRangePicker } from "@/components/date-range-picker";
import { hasPerm } from "@/lib/permissions";
import { SaudiSalesMap } from "@/components/saudi-sales-map";

import { fetchAllPaginated } from "@/lib/supabase-paginate";
import { queryKeys } from "@/lib/query-keys";



export const Route = createFileRoute("/_app/dashboard")({
  head: () => ({ meta: [{ title: "Dashboard — MilaServ Portal" }] }),
  component: Dashboard,
});

const toISO = (d: Date) => format(d, "yyyy-MM-dd");

type KpiRow = {
  bucket: string;
  total_sales: number;
  completed_sales: number;
  order_count: number;
  completed_count: number;
  pending_count: number;
  cancelled_count: number;
  completion_rate: number;
};

function Dashboard() {
  const { user, role, profile } = useAuth();
  const canViewDashboard = hasPerm(role, profile?.permissions as any, "view_dashboard");
  const canViewTeamAnalytics = hasPerm(role, profile?.permissions as any, "view_team_analytics");
  const canViewAllAgents = hasPerm(role, profile?.permissions as any, "view_all_agents");
  const canExport = hasPerm(role, profile?.permissions as any, "export_reports");
  const isAdmin = canViewAllAgents;
  const [mineOnly, setMineOnly] = useState(false);
  const [agentFilter, setAgentFilter] = useState<string>("all");
  const [teamFilter, setTeamFilter] = useState<string>("all");

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


  const effectiveAgent = canViewAllAgents ? agentFilter : (!canViewTeamAnalytics && user?.id ? user.id : (mineOnly && user?.id ? user.id : "all"));
  const effectiveTeam = canViewTeamAnalytics ? teamFilter : "all";

  // Identity of every dashboard aggregation query. Complaints have no team
  // dimension, so those two queries use the `team`-less subset.
  const dashFilters = { from, to, agent: effectiveAgent, team: effectiveTeam };
  const cmpFilters = { from, to, agent: effectiveAgent };

  const { data: agents } = useQuery({
    queryKey: queryKeys.lookups.dashboardAgents(),
    queryFn: async () => {
      const [{ data: profiles }, { data: roles }] = await Promise.all([
        supabase.from("profiles").select("id,full_name,agent_code").order("full_name"),
        supabase.from("user_roles").select("user_id,role"),
      ]);
      const rm = new Map((roles ?? []).map((r: any) => [r.user_id, r.role]));
      return (profiles ?? []).map((p: any) => ({ ...p, role: rm.get(p.id) ?? null }));
    },
    enabled: canViewAllAgents,
  });

  const filteredAgents = useMemo(() => {
    if (!agents) return [];
    const base = agents.filter((a: any) => a.role === "customer_care" || a.role === "telesales");
    if (teamFilter === "all") return base;
    return base.filter((a: any) => a.role === teamFilter);
  }, [agents, teamFilter]);

  // Legacy full-row aggregation retained ONLY to power the Excel export, and
  // now fetched on demand (enabled: false + refetch on Export click) so it no
  // longer pulls every order/complaint on each page load. All on-screen widgets
  // read the focused orders_*/complaints_* RPCs above.
  const { refetch: refetchExport, isFetching: exportBusy } = useQuery({
    queryKey: queryKeys.dashboard.exportData({ ...dashFilters, isAdmin, userId: user?.id }),
    enabled: false,
    queryFn: async () => {
      const buildOrders = () => {
        let qb = supabase.from("orders")
          .select("id,order_date,team,agent_id,branch_no,invoice_value,status,order_type,delivery_type,call_center_verified")
          .gte("order_date", from).lte("order_date", to)
          .order("order_date", { ascending: false });
        if (effectiveAgent !== "all") qb = qb.eq("agent_id", effectiveAgent);
        if (effectiveTeam !== "all") qb = qb.eq("team", effectiveTeam as "customer_care" | "telesales");
        return qb;
      };

      const buildComplaints = () => {
        let cb = supabase.from("complaints" as any).select("id,complaint_date,branch_no,status,agent_id")
          .gte("complaint_date", from).lte("complaint_date", to)
          .order("complaint_date", { ascending: false });
        if (effectiveAgent !== "all") cb = cb.eq("agent_id", effectiveAgent);
        return cb;
      };

      const [orders, { data: branches }, { data: profiles }, complaints] = await Promise.all([
        fetchAllPaginated<any>(buildOrders),
        supabase.from("branches").select("branch_no,city"),
        supabase.from("profiles").select("id,full_name"),
        fetchAllPaginated<any>(buildComplaints),
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
        const m: Record<string, { count: number; sales: number; completed: number; total: number }> = {};
        for (const o of rows) {
          const k = keyFn(o) || "—";
          if (!m[k]) m[k] = { count: 0, sales: 0, completed: 0, total: 0 };
          m[k].count += 1;
          m[k].total += num(o.invoice_value);
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
      // Privacy scoping is enforced by RLS ([H4]): non-privileged agents
      // only receive their own order rows from the database, so a client-
      // side filter here would be redundant.


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

      const buildStats = (rows: any[]) => {
        const completed = completedRows(rows);
        const pending = rows.filter((o: any) => o.status === "Pending").length;
        const cancelled = rows.filter((o: any) => o.status === "Cancelled").length;
        return {
          totalSales: sum(rows),
          completedSales: sum(completed),
          totalOrders: rows.length,
          completedOrders: completed.length,
          pending,
          cancelled,
          completionRate: rows.length > 0 ? (completed.length / rows.length) * 100 : 0,
        };
      };
      const cashStats = buildStats(cash(rangeOrders));
      const wasStats = buildStats(was(rangeOrders));
      const totalStats = buildStats(rangeOrders);

      return {
        monthAll, monthCompleted, monthCompletedCount,
        monthTotalCount: rangeOrders.length,
        monthCashSales: cashStats.totalSales,
        monthWasSales: wasStats.totalSales,
        cashStats, wasStats, totalStats,
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
            const label = b;
            const d = o.delivery_type ?? "—";
            if (!m[label]) m[label] = {};
            m[label][d] = (m[label][d] ?? 0) + num(o.invoice_value);
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

  // Headline KPI cards now come from the orders_kpis RPC (server-side
  // aggregation) instead of the client-side cash/wasfaty/total reduction.
  // Scoped by the same effective team/agent filters; RLS applies.
  const { data: kpiRows } = useQuery({
    queryKey: queryKeys.dashboard.kpis(dashFilters),
    queryFn: async () => {
      const { data, error } = await supabase.rpc("orders_kpis" as any, {
        _from: from,
        _to: to,
        _team: effectiveTeam,
        _agent: effectiveAgent === "all" ? null : effectiveAgent,
        _mine: false,
      });
      if (error) throw error;
      return (data ?? []) as KpiRow[];
    },
    enabled: canViewDashboard,
  });

  const kpiByBucket = useMemo(() => {
    const m = new Map((kpiRows ?? []).map((r) => [r.bucket, r]));
    const toStats = (b?: KpiRow): DashKpiStats | undefined =>
      b
        ? {
            totalSales: Number(b.total_sales),
            completedSales: Number(b.completed_sales),
            totalOrders: Number(b.order_count),
            completedOrders: Number(b.completed_count),
            pending: Number(b.pending_count),
            cancelled: Number(b.cancelled_count),
            completionRate: Number(b.completion_rate),
          }
        : undefined;
    return { cash: toStats(m.get("cash")), wasfaty: toStats(m.get("wasfaty")), total: toStats(m.get("total")) };
  }, [kpiRows]);

  // Daily sales trend from orders_daily RPC. Rows arrive ordered by full date
  // (fixes the year-boundary ordering); the label is formatted client-side.
  const { data: dailyRows } = useQuery({
    queryKey: queryKeys.dashboard.daily(dashFilters),
    queryFn: async () => {
      const { data, error } = await supabase.rpc("orders_daily" as any, {
        _from: from,
        _to: to,
        _team: effectiveTeam,
        _agent: effectiveAgent === "all" ? null : effectiveAgent,
        _mine: false,
      });
      if (error) throw error;
      return (data ?? []) as Array<{ day: string; total_sales: number; completed_sales: number }>;
    },
    enabled: canViewDashboard,
  });
  const dailyData = useMemo(
    () => (dailyRows ?? []).map((r) => ({ date: r.day.slice(5), total: Number(r.total_sales), completed: Number(r.completed_sales) })),
    [dailyRows],
  );

  // Orders-by-status distribution from orders_status RPC.
  const { data: statusRows } = useQuery({
    queryKey: queryKeys.dashboard.status(dashFilters),
    queryFn: async () => {
      const { data, error } = await supabase.rpc("orders_status" as any, {
        _from: from,
        _to: to,
        _team: effectiveTeam,
        _agent: effectiveAgent === "all" ? null : effectiveAgent,
        _mine: false,
      });
      if (error) throw error;
      return (data ?? []) as Array<{ status: string; order_count: number }>;
    },
    enabled: canViewDashboard,
  });
  const statusData = useMemo(
    () => (statusRows ?? []).map((r) => ({ name: r.status, value: Number(r.order_count) })),
    [statusRows],
  );

  // Sales by team from orders_teams RPC.
  const teamLabel = (t: string) => (t === "telesales" ? "Telesales" : "Customer Care");
  const { data: teamRows } = useQuery({
    queryKey: queryKeys.dashboard.teams(dashFilters),
    queryFn: async () => {
      const { data, error } = await supabase.rpc("orders_teams" as any, {
        _from: from,
        _to: to,
        _team: effectiveTeam,
        _agent: effectiveAgent === "all" ? null : effectiveAgent,
        _mine: false,
      });
      if (error) throw error;
      return (data ?? []) as Array<{ team: string; order_count: number; completed_sales: number; completion_rate: number }>;
    },
    enabled: canViewDashboard,
  });
  const teamData = useMemo(
    () => (teamRows ?? []).map((r) => ({ name: teamLabel(r.team), sales: Number(r.completed_sales) })),
    [teamRows],
  );

  // Top agents by sales from orders_agents RPC (top 10 for the chart).
  const { data: agentRows } = useQuery({
    queryKey: queryKeys.dashboard.agentSales(dashFilters),
    queryFn: async () => {
      const { data, error } = await supabase.rpc("orders_agents" as any, {
        _from: from,
        _to: to,
        _team: effectiveTeam,
        _agent: effectiveAgent === "all" ? null : effectiveAgent,
        _mine: false,
      });
      if (error) throw error;
      return (data ?? []) as Array<{ agent_id: string; agent_name: string; completed_sales: number }>;
    },
    enabled: canViewDashboard,
  });
  const agentSalesData = useMemo(
    () => (agentRows ?? []).slice(0, 10).map((r) => ({ name: r.agent_name, sales: Number(r.completed_sales) })),
    [agentRows],
  );

  // Sales by branch / city + heat map from orders_locations RPC.
  const { data: locationRows } = useQuery({
    queryKey: queryKeys.dashboard.locations(dashFilters),
    queryFn: async () => {
      const { data, error } = await supabase.rpc("orders_locations" as any, {
        _from: from,
        _to: to,
        _team: effectiveTeam,
        _agent: effectiveAgent === "all" ? null : effectiveAgent,
        _mine: false,
      });
      if (error) throw error;
      return (data ?? []) as Array<{
        location_type: string; location: string; order_count: number;
        completed_sales: number; completed_count: number; total_sales: number; completion_rate: number;
      }>;
    },
    enabled: canViewDashboard,
  });
  const branchData = useMemo(
    () => (locationRows ?? []).filter((r) => r.location_type === "branch")
      .map((r) => ({ name: r.location, sales: Number(r.completed_sales) }))
      .sort((a, b) => b.sales - a.sales).slice(0, 10),
    [locationRows],
  );
  const cityData = useMemo(
    () => (locationRows ?? []).filter((r) => r.location_type === "city")
      .map((r) => ({ name: r.location, sales: Number(r.completed_sales) }))
      .sort((a, b) => b.sales - a.sales),
    [locationRows],
  );
  const cityMapData = useMemo(
    () => (locationRows ?? []).filter((r) => r.location_type === "city").map((r) => ({
      name: r.location, sales: Number(r.completed_sales), count: Number(r.order_count),
      total: Number(r.total_sales), completed: Number(r.completed_count),
    })),
    [locationRows],
  );

  // Delivery method performance from orders_delivery RPC.
  const { data: deliveryRows } = useQuery({
    queryKey: queryKeys.dashboard.delivery(dashFilters),
    queryFn: async () => {
      const { data, error } = await supabase.rpc("orders_delivery" as any, {
        _from: from,
        _to: to,
        _team: effectiveTeam,
        _agent: effectiveAgent === "all" ? null : effectiveAgent,
        _mine: false,
      });
      if (error) throw error;
      return (data ?? []) as Array<{ delivery_type: string; order_count: number; completed_sales: number; completion_rate: number }>;
    },
    enabled: canViewDashboard,
  });
  const deliveryData = useMemo(
    () => (deliveryRows ?? []).map((r) => ({ name: r.delivery_type, count: Number(r.order_count), sales: Number(r.completed_sales), rate: Number(r.completion_rate) })),
    [deliveryRows],
  );

  // Branch x method / city x method crosstabs from orders_delivery_matrix RPC.
  const { data: matrixRows } = useQuery({
    queryKey: queryKeys.dashboard.deliveryMatrix(dashFilters),
    queryFn: async () => {
      const { data, error } = await supabase.rpc("orders_delivery_matrix" as any, {
        _from: from,
        _to: to,
        _team: effectiveTeam,
        _agent: effectiveAgent === "all" ? null : effectiveAgent,
        _mine: false,
      });
      if (error) throw error;
      return (data ?? []) as Array<{ location_type: string; location: string; delivery_type: string; completed_sales: number }>;
    },
    enabled: canViewDashboard,
  });
  const pivotMatrix = (type: "branch" | "city") => {
    const m: Record<string, Record<string, number>> = {};
    for (const r of matrixRows ?? []) {
      if (r.location_type !== type) continue;
      (m[r.location] ??= {})[r.delivery_type] = Number(r.completed_sales);
    }
    return m;
  };
  const deliveryBranchMatrix = useMemo(() => pivotMatrix("branch"), [matrixRows]);
  const deliveryCityMatrix = useMemo(() => pivotMatrix("city"), [matrixRows]);

  // CC invoice verification per agent from orders_verification RPC (top 12).
  const { data: verificationRows } = useQuery({
    queryKey: queryKeys.dashboard.verification(dashFilters),
    queryFn: async () => {
      const { data, error } = await supabase.rpc("orders_verification" as any, {
        _from: from,
        _to: to,
        _team: effectiveTeam,
        _agent: effectiveAgent === "all" ? null : effectiveAgent,
        _mine: false,
      });
      if (error) throw error;
      return (data ?? []) as Array<{
        agent_id: string; agent_name: string; total_orders: number;
        verified: number; non_verified: number; verified_value: number; rate: number;
      }>;
    },
    enabled: canViewDashboard,
  });
  const verifData = useMemo(
    () => (verificationRows ?? []).slice(0, 12).map((r) => ({
      name: r.agent_name, total: Number(r.total_orders), verified: Number(r.verified),
      nonVerified: Number(r.non_verified), rate: Number(r.rate), verifiedValue: Number(r.verified_value),
    })),
    [verificationRows],
  );

  // Complaints analytics (scoped by date + agent only; complaints have no team).
  const cmpAgent = effectiveAgent === "all" ? null : effectiveAgent;
  const { data: cmpKpiRows } = useQuery({
    queryKey: queryKeys.dashboard.complaintsKpis(cmpFilters),
    queryFn: async () => {
      const { data, error } = await supabase.rpc("complaints_kpis" as any, { _from: from, _to: to, _agent: cmpAgent, _mine: false });
      if (error) throw error;
      return (data ?? []) as Array<{ total: number; in_progress: number; resolved: number; resolution_rate: number }>;
    },
    enabled: canViewDashboard,
  });
  const cmpKpi = cmpKpiRows?.[0];
  const { data: cmpLocRows } = useQuery({
    queryKey: queryKeys.dashboard.complaintsLocations(cmpFilters),
    queryFn: async () => {
      const { data, error } = await supabase.rpc("complaints_locations" as any, { _from: from, _to: to, _agent: cmpAgent, _mine: false });
      if (error) throw error;
      return (data ?? []) as Array<{ location_type: string; location: string; total: number; resolved: number; open: number; rate: number }>;
    },
    enabled: canViewDashboard,
  });
  const cmpBranchData = useMemo(
    () => (cmpLocRows ?? []).filter((r) => r.location_type === "branch")
      .map((r) => ({ name: r.location, total: Number(r.total), resolved: Number(r.resolved), open: Number(r.open) }))
      .sort((a, b) => b.total - a.total).slice(0, 10),
    [cmpLocRows],
  );
  const cmpCityData = useMemo(
    () => (cmpLocRows ?? []).filter((r) => r.location_type === "city")
      .map((r) => ({ name: r.location, total: Number(r.total), rate: Number(r.rate) }))
      .sort((a, b) => b.total - a.total),
    [cmpLocRows],
  );

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

  const deliveryMethods = Array.from(new Set(deliveryData.map((d) => d.name)));
  const selectedAgentLabel = canViewAllAgents && agentFilter !== "all"
    ? (agents?.find((a: any) => a.id === agentFilter)?.full_name ?? "agent")
    : null;

  // Caption reads the scope that was actually applied rather than `mineOnly`
  // alone. `effectiveAgent` narrows to the current user in two ways: via the
  // toggle, and implicitly for users without `view_team_analytics` — the latter
  // used to be labelled "Team performance" while showing only their own rows.
  // Display only; `effectiveAgent` itself is untouched.
  const scopedToSelf = !!user?.id && effectiveAgent === user.id;

  if (!canViewDashboard) {
    return <div className="text-center py-16"><ShieldAlert className="mx-auto h-10 w-10 text-destructive" /><p className="mt-2 text-sm text-muted-foreground">You don't have access to Dashboard.</p></div>;
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 sm:flex sm:flex-wrap sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight truncate">Dashboard</h1>
          <p className="text-xs sm:text-sm text-muted-foreground truncate">
            {selectedAgentLabel ? `Performance for ${selectedAgentLabel}` : scopedToSelf ? "Your performance" : "Team performance"} · {dateLabel}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <DateRangePicker range={range} onChange={setRange} align="end" size="sm" />
          {canViewTeamAnalytics && (
            <Select value={teamFilter} onValueChange={(v) => { setTeamFilter(v); setAgentFilter("all"); }}>
              <SelectTrigger className="h-9 w-[150px]"><SelectValue placeholder="All teams" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All teams</SelectItem>
                <SelectItem value="customer_care">Customer Care</SelectItem>
                <SelectItem value="telesales">Telesales</SelectItem>
              </SelectContent>
            </Select>
          )}
          {canViewTeamAnalytics && canViewAllAgents && (
            <Select value={agentFilter} onValueChange={setAgentFilter}>
              <SelectTrigger className="h-9 w-[170px] sm:w-[200px]"><SelectValue placeholder="All agents" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All agents</SelectItem>
                {filteredAgents.map((a: any) => (
                  <SelectItem key={a.id} value={a.id}>{a.full_name}{a.agent_code ? ` (${a.agent_code})` : ""}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {/* Scope toggle for the one tier `effectiveAgent` defers to `mineOnly`:
              users who may see team-wide figures but have no agent picker to narrow
              with (customer_care, call_center). It previously sat in the FALSE branch
              of a `canViewTeamAnalytics ?` ternary and re-tested `canViewTeamAnalytics
              &&`, so it could never render and `mineOnly` was frozen at false. */}
          {canViewTeamAnalytics && !canViewAllAgents && (
            <Button variant={mineOnly ? "default" : "outline"} size="sm" onClick={() => setMineOnly((v) => !v)}>
              {mineOnly ? "My data" : "All data"}
            </Button>
          )}
          {canExport && <Button variant="outline" size="sm" onClick={async () => {
            const r = await refetchExport();
            if (r.data) await exportDashboard(r.data, { from, to, agentLabel: selectedAgentLabel, teamLabel: teamFilter });
          }} disabled={exportBusy}>
            <Download className="h-4 w-4 mr-2" />{exportBusy ? "Preparing…" : "Export"}
          </Button>}
        </div>
      </div>

      <div>
        <SectionTitle title="Performance for selected period" />
        <div className="grid gap-3 sm:grid-cols-3">
          <DashKpiCard label="Cash" tone="from-[var(--tint-cash)] to-transparent" stats={kpiByBucket.cash} />
          <DashKpiCard label="Wasfaty" tone="from-[var(--tint-wasfaty)] to-transparent" stats={kpiByBucket.wasfaty} />
          <DashKpiCard label="Total" tone="from-primary/10 to-transparent" highlight stats={kpiByBucket.total} />
        </div>
      </div>

      {/* Call Center Invoice Verification — details table (redundant KPI cards removed per spec) */}
      <div>
        <SectionTitle title="Call Center Invoice verification" />

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
                {verifData.length === 0 && <tr><td colSpan={6} className="text-center text-muted-foreground py-6">No data</td></tr>}
                {verifData.map((r) => (
                  <tr key={r.name} className="border-b last:border-0">
                    <td className="px-3 py-2 font-medium whitespace-nowrap">{r.name}</td>
                    <td className="px-3 py-2 text-right">{r.total}</td>
                    <td className="px-3 py-2 text-right text-[var(--positive)] font-semibold">{r.verified}</td>
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
              <AreaChart data={dailyData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="dailyAll" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--color-chart-1)" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="var(--color-chart-1)" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="dailyCompleted" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#16a34a" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="#16a34a" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} tickMargin={6} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 11 }} axisLine={false} tickLine={false} width={48} />
                <Tooltip
                  formatter={(v: any) => fmtSAR(v)}
                  contentStyle={{ borderRadius: 8, border: "1px solid var(--color-border)", fontSize: 12 }}
                />
                <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
                <Area type="monotone" dataKey="total" name="All" stroke="var(--color-chart-1)" strokeWidth={2} fill="url(#dailyAll)" activeDot={{ r: 4 }} isAnimationActive animationDuration={500} />
                <Area type="monotone" dataKey="completed" name="Completed" stroke="#16a34a" strokeWidth={2} fill="url(#dailyCompleted)" activeDot={{ r: 4 }} isAnimationActive animationDuration={600} />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Orders by status</CardTitle></CardHeader>
          <CardContent className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={statusData} dataKey="value" nameKey="name" outerRadius={80} label>
                  {statusData.map((s, i) => <Cell key={i} fill={STATUS_COLORS[s.name] ?? COLORS[i % COLORS.length]} />)}
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
              <BarChart data={teamData}>
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
              <BarChart data={agentSalesData} layout="vertical">
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
              <BarChart data={branchData} layout="vertical">
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
              <BarChart data={cityData} layout="vertical">
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

      {/* Geographic heat map */}
      <div>
        <SectionTitle title="Geographic distribution" />
        <div className="mt-3">
          <SaudiSalesMap cities={cityMapData} />
        </div>
      </div>

      {/* Call center analytics moved to /call-center */}





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
                {deliveryData.length === 0 && <tr><td colSpan={4} className="text-center text-muted-foreground py-6">No data</td></tr>}
                {deliveryData.map((d) => (
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
          <DeliveryMatrix title="Sales by branch × delivery method" matrix={deliveryBranchMatrix} methods={deliveryMethods} />
          <DeliveryMatrix title="Sales by city × delivery method" matrix={deliveryCityMatrix} methods={deliveryMethods} />
        </div>
      </div>

      {/* Complaints analytics */}
      <div>
        <SectionTitle title="Complaints" />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
          <Stat label="Total complaints" value={Number(cmpKpi?.total ?? 0)} />
          <Stat label="In progress" value={Number(cmpKpi?.in_progress ?? 0)} accent="text-[var(--attention)]" />
          <Stat label="Resolved" value={Number(cmpKpi?.resolved ?? 0)} accent="text-[var(--positive)]" />
          <Stat label="Resolution rate" value={cmpKpi ? `${Number(cmpKpi.resolution_rate).toFixed(1)}%` : "—"} />
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
                  {cmpBranchData.length === 0 && <tr><td colSpan={4} className="text-center text-muted-foreground py-6">No data</td></tr>}
                  {cmpBranchData.map((r) => (
                    <tr key={r.name} className="border-b last:border-0">
                      <td className="px-3 py-2 font-medium">{r.name}</td>
                      <td className="px-3 py-2 text-right">{r.total}</td>
                      <td className="px-3 py-2 text-right text-[var(--positive)]">{r.resolved}</td>
                      <td className="px-3 py-2 text-right text-[var(--attention)]">{r.open}</td>
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
                  {cmpCityData.length === 0 && <tr><td colSpan={3} className="text-center text-muted-foreground py-6">No data</td></tr>}
                  {cmpCityData.map((r) => (
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

type DashKpiStats = {
  totalSales: number; completedSales: number;
  totalOrders: number; completedOrders: number;
  pending: number; cancelled: number; completionRate: number;
};
function DashKpiCard({ label, tone, highlight, stats }: {
  label: string; tone: string; highlight?: boolean; stats?: DashKpiStats;
}) {
  const s: DashKpiStats = stats ?? {
    totalSales: 0, completedSales: 0, totalOrders: 0, completedOrders: 0,
    pending: 0, cancelled: 0, completionRate: 0,
  };
  return (
    <div className={cn("relative rounded-xl border bg-gradient-to-br p-4 shadow-sm", tone, highlight && "border-primary/40 shadow-md")}>
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">{label}</div>
      <div className="mt-3 space-y-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-xs text-muted-foreground">Total sales</span>
          <span className="text-base font-semibold tabular-nums truncate">{fmtSAR(s.totalSales)}</span>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-xs text-muted-foreground">Completed sales</span>
          <span className="text-base font-semibold tabular-nums truncate text-[var(--positive)]">{fmtSAR(s.completedSales)}</span>
        </div>
      </div>
      <div className="mt-3 pt-3 border-t border-border/60 grid grid-cols-2 gap-2">
        <div className="text-left">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Total orders</div>
          <div className="text-2xl font-bold tabular-nums leading-tight">{s.totalOrders}</div>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Completed</div>
          <div className="text-2xl font-bold tabular-nums leading-tight text-[var(--positive)]">{s.completedOrders}</div>
        </div>
      </div>
      <div className="mt-2 pt-2 border-t border-border/40 grid grid-cols-3 gap-1 text-[11px]">
        <div><span className="text-muted-foreground">Rate </span><span className="font-semibold">{s.completionRate.toFixed(1)}%</span></div>
        <div><span className="text-muted-foreground">Pending </span><span className="font-semibold text-[var(--attention)]">{s.pending}</span></div>
        <div><span className="text-muted-foreground">Cancelled </span><span className="font-semibold text-[var(--negative)]">{s.cancelled}</span></div>
      </div>
    </div>
  );
}


async function exportDashboard(
  data: any,
  ctx: { from: string; to: string; agentLabel: string | null; teamLabel: string },
) {
  if (!data) return;
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();
  const teamLbl = ctx.teamLabel === "customer_care" ? "Customer Care" : ctx.teamLabel === "telesales" ? "Telesales" : "All Teams";
  const summary = [
    ["MilaServ Portal — Dashboard Export"],
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
