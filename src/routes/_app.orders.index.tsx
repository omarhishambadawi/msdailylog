import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Download, Plus, Search } from "lucide-react";
import * as XLSX from "xlsx";
import { STATUSES, STATUS_STYLES, TEAMS, CURRENCY, fmtSAR } from "@/lib/branches";
import { toast } from "sonner";

export const Route = createFileRoute("/_app/orders/")({
  head: () => ({ meta: [{ title: "Orders" }] }),
  component: OrdersList,
});

function OrdersList() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { profile, user, role } = useAuth();
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(); monthAgo.setDate(monthAgo.getDate() - 30);
  const [from, setFrom] = useState(monthAgo.toISOString().slice(0, 10));
  const [to, setTo] = useState(today);
  const [q, setQ] = useState("");
  const [team, setTeam] = useState<string>("all");
  const [status, setStatus] = useState<string>("all");
  const [mineOnly, setMineOnly] = useState<boolean>(false);

  const { data, isLoading } = useQuery({
    queryKey: ["orders", from, to, team, status, mineOnly, user?.id],
    queryFn: async () => {
      let qb = supabase.from("orders").select("*").gte("order_date", from).lte("order_date", to).order("order_date", { ascending: false }).order("created_at", { ascending: false }).limit(2000);
      if (team !== "all") qb = qb.eq("team", team as "customer_care" | "telesales");
      if (status !== "all") qb = qb.eq("status", status);
      if (mineOnly && user?.id) qb = qb.eq("agent_id", user.id);
      const [{ data: orders, error }, { data: profiles }, { data: branches }] = await Promise.all([
        qb,
        supabase.from("profiles").select("id,full_name,agent_code"),
        supabase.from("branches").select("branch_no,city"),
      ]);
      if (error) throw error;
      const nm = new Map((profiles ?? []).map((p: any) => [p.id, p]));
      const bm = new Map((branches ?? []).map((b: any) => [b.branch_no, b.city]));
      return (orders ?? []).map((o: any) => ({
        ...o,
        agent_name: nm.get(o.agent_id)?.full_name ?? "—",
        agent_code: nm.get(o.agent_id)?.agent_code ?? "",
        city: bm.get(o.branch_no) ?? "",
      }));
    },
  });

  const filtered = useMemo(() => {
    if (!data) return [];
    const term = q.trim().toLowerCase();
    if (!term) return data;
    return data.filter((o: any) =>
      [o.display_no, o.invoice_no, o.branch_no, o.city, o.agent_name, o.customer_name, o.customer_phone, o.notes, o.delivery_type, o.order_type]
        .filter(Boolean).some((v: string) => String(v).toLowerCase().includes(term)),
    );
  }, [data, q]);

  const todayMine = useMemo(() => {
    if (!user?.id) return 0;
    return (data ?? []).filter((o: any) => o.agent_id === user.id && o.order_date === today).length;
  }, [data, user?.id, today]);

  const todaySummary = useMemo(() => {
    const todays = filtered.filter((o: any) => o.order_date === today);
    const num = (v: any) => Number(v ?? 0);
    const cash = todays.filter((o: any) => o.order_type === "Cash");
    const was = todays.filter((o: any) => o.order_type === "Wasfaty");
    const completed = (rows: any[]) => rows.filter((o: any) => o.status === "Completed");
    const sum = (rows: any[]) => rows.reduce((s, o) => s + num(o.invoice_value), 0);
    return {
      cashSales: sum(cash),
      cashCompletedSales: sum(completed(cash)),
      cashCount: cash.length,
      wasSales: sum(was),
      wasCompletedSales: sum(completed(was)),
      wasCount: was.length,
      dailySales: sum(todays),
      dailyCompletedSales: sum(completed(todays)),
      totalCount: todays.length,
      completedCount: completed(todays).length,
    };
  }, [filtered, today]);

  const todayMine = useMemo(() => {
    if (!user?.id) return 0;
    return (data ?? []).filter((o: any) => o.agent_id === user.id && o.order_date === today).length;
  }, [data, user?.id, today]);

  const updateStatus = async (orderId: string, newStatus: string) => {
    const { error } = await supabase.from("orders").update({ status: newStatus }).eq("id", orderId);
    if (error) { toast.error(error.message); return; }
    toast.success("Status updated");
    qc.invalidateQueries({ queryKey: ["orders"] });
    qc.invalidateQueries({ queryKey: ["dashboard"] });
  };

  const exportXlsx = () => {
    const rows = filtered.map((o: any) => ({
      "Order #": o.display_no,
      Date: o.order_date,
      Team: o.team === "customer_care" ? "Customer Care" : "Telesales",
      Agent: o.agent_name,
      "Agent Code": o.agent_code,
      "Customer Name": o.customer_name,
      "Customer Phone": o.customer_phone,
      "Order Type": o.order_type,
      "Branch No.": o.branch_no,
      City: o.city,
      "Delivery & Pickup": o.delivery_type,
      "Invoice No.": o.invoice_no,
      [`Order Value (${CURRENCY})`]: o.invoice_value,
      Notes: o.notes,
      Status: o.status,
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Orders");
    XLSX.writeFile(wb, `orders_${from}_${to}.xlsx`);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Orders</h1>
          <p className="text-sm text-muted-foreground">
            {mineOnly ? <>Showing your orders · <span className="font-medium text-foreground">{todayMine}</span> logged today</> : "Search, filter, edit and export"}
          </p>
        </div>
        <div className="flex gap-2 items-center">
          <Button variant={mineOnly ? "default" : "outline"} size="sm" onClick={() => setMineOnly((v) => !v)}>
            {mineOnly ? "My orders" : "All orders"}
          </Button>
          <Button variant="outline" onClick={exportXlsx}><Download className="h-4 w-4 mr-2" />Export Excel</Button>
          <Button onClick={() => navigate({ to: "/orders/new" })}><Plus className="h-4 w-4 mr-2" />New order</Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-4 grid gap-3 md:grid-cols-6">
          <div className="md:col-span-2 relative">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input placeholder="Search order/customer/phone/branch/agent…" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
          </div>
          <div><label className="text-xs text-muted-foreground">From</label><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div><label className="text-xs text-muted-foreground">To</label><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
          <div>
            <label className="text-xs text-muted-foreground">Team</label>
            <Select value={team} onValueChange={setTeam}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All teams</SelectItem>
                {TEAMS.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Status</label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                {STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Order #</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Team</TableHead>
                  <TableHead>Agent</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Branch</TableHead>
                  <TableHead>City</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading && <TableRow><TableCell colSpan={11} className="text-center text-muted-foreground py-8">Loading…</TableCell></TableRow>}
                {!isLoading && filtered.length === 0 && <TableRow><TableCell colSpan={11} className="text-center text-muted-foreground py-8">No orders found</TableCell></TableRow>}
                {filtered.map((o: any) => {
                  const editable = profile?.id === o.agent_id || role === "admin";
                  return (
                    <TableRow key={o.id} className={editable ? "cursor-pointer" : ""}>
                      <TableCell className="font-mono font-semibold" onClick={() => editable && navigate({ to: "/orders/$id", params: { id: o.id } })}>{o.display_no ?? "—"}</TableCell>
                      <TableCell onClick={() => editable && navigate({ to: "/orders/$id", params: { id: o.id } })}>{o.order_date}</TableCell>
                      <TableCell><TeamBadge team={o.team} /></TableCell>
                      <TableCell className="whitespace-nowrap" onClick={() => editable && navigate({ to: "/orders/$id", params: { id: o.id } })}>{o.agent_name}</TableCell>
                      <TableCell className="whitespace-nowrap">{o.customer_name || "—"}</TableCell>
                      <TableCell className="whitespace-nowrap font-mono text-xs">{o.customer_phone || "—"}</TableCell>
                      <TableCell>{o.order_type}</TableCell>
                      <TableCell>{o.branch_no ?? "—"}</TableCell>
                      <TableCell>{o.city || "—"}</TableCell>
                      <TableCell className="text-right whitespace-nowrap">{fmtSAR(o.invoice_value)}</TableCell>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        {editable ? (
                          <Select value={o.status} onValueChange={(v) => updateStatus(o.id, v)}>
                            <SelectTrigger className="h-8 w-[140px]"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        ) : (
                          <StatusBadge s={o.status} />
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function TeamBadge({ team }: { team: string }) {
  if (team === "telesales") {
    return <span className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium bg-chart-2/15 text-chart-2 border-chart-2/30">Telesales</span>;
  }
  return <span className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium bg-chart-1/15 text-chart-1 border-chart-1/30">Customer Care</span>;
}

function StatusBadge({ s }: { s: string }) {
  const tone: Record<string, string> = {
    Completed: "bg-success/15 text-success border-success/30",
    Pending: "bg-warning/15 text-warning-foreground border-warning/30",
    Closed: "bg-muted text-muted-foreground border-border",
    Cancelled: "bg-destructive/10 text-destructive border-destructive/30",
    "Follow-up": "bg-chart-3/15 text-chart-3 border-chart-3/30",
    "No Answer": "bg-chart-4/15 text-chart-4 border-chart-4/30",
  };
  return <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${tone[s] ?? "bg-muted"}`}>{s}</span>;
}
