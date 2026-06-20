import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Download, Plus, Search } from "lucide-react";
import * as XLSX from "xlsx";
import { STATUSES, TEAMS } from "@/lib/branches";

export const Route = createFileRoute("/_app/orders/")({
  head: () => ({ meta: [{ title: "Orders" }] }),
  component: OrdersList,
});

function OrdersList() {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(); monthAgo.setDate(monthAgo.getDate() - 30);
  const [from, setFrom] = useState(monthAgo.toISOString().slice(0, 10));
  const [to, setTo] = useState(today);
  const [q, setQ] = useState("");
  const [team, setTeam] = useState<string>("all");
  const [status, setStatus] = useState<string>("all");

  const { data, isLoading } = useQuery({
    queryKey: ["orders", from, to, team, status],
    queryFn: async () => {
      let qb = supabase.from("orders").select("*").gte("order_date", from).lte("order_date", to).order("order_date", { ascending: false }).order("created_at", { ascending: false }).limit(2000);
      if (team !== "all") qb = qb.eq("team", team);
      if (status !== "all") qb = qb.eq("status", status);
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
      [o.order_no, o.invoice_no, o.branch_no, o.city, o.agent_name, o.notes, o.delivery_type, o.order_type]
        .filter(Boolean).some((v: string) => String(v).toLowerCase().includes(term)),
    );
  }, [data, q]);

  const exportXlsx = () => {
    const rows = filtered.map((o: any) => ({
      Date: o.order_date,
      Team: o.team === "customer_care" ? "Customer Care" : "Telesales",
      Agent: o.agent_name,
      "Agent Code": o.agent_code,
      "Order Type": o.order_type,
      "Branch No.": o.branch_no,
      City: o.city,
      "Delivery & Pickup": o.delivery_type,
      "Order No.": o.order_no,
      "Invoice No.": o.invoice_no,
      "Invoice Value": o.invoice_value,
      "Notes / Customer No.": o.notes,
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
          <p className="text-sm text-muted-foreground">Search, filter, edit and export</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={exportXlsx}><Download className="h-4 w-4 mr-2" />Export Excel</Button>
          <Button onClick={() => navigate({ to: "/orders/new" })}><Plus className="h-4 w-4 mr-2" />New order</Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-4 grid gap-3 md:grid-cols-6">
          <div className="md:col-span-2 relative">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input placeholder="Search order/invoice/branch/agent…" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
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
                  <TableHead>Date</TableHead>
                  <TableHead>Team</TableHead>
                  <TableHead>Agent</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Branch</TableHead>
                  <TableHead>City</TableHead>
                  <TableHead>Delivery</TableHead>
                  <TableHead>Order #</TableHead>
                  <TableHead>Invoice #</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading && <TableRow><TableCell colSpan={11} className="text-center text-muted-foreground py-8">Loading…</TableCell></TableRow>}
                {!isLoading && filtered.length === 0 && <TableRow><TableCell colSpan={11} className="text-center text-muted-foreground py-8">No orders found</TableCell></TableRow>}
                {filtered.map((o: any) => {
                  const editable = profile?.id === o.agent_id || profile?.id === undefined;
                  return (
                    <TableRow key={o.id} className="cursor-pointer" onClick={() => editable && navigate({ to: "/orders/$id", params: { id: o.id } })}>
                      <TableCell>{o.order_date}</TableCell>
                      <TableCell><Badge variant="outline" className="capitalize">{o.team.replace("_", " ")}</Badge></TableCell>
                      <TableCell className="whitespace-nowrap">{o.agent_name}</TableCell>
                      <TableCell>{o.order_type}</TableCell>
                      <TableCell>{o.branch_no ?? "—"}</TableCell>
                      <TableCell>{o.city || "—"}</TableCell>
                      <TableCell>{o.delivery_type ?? "—"}</TableCell>
                      <TableCell>{o.order_no ?? "—"}</TableCell>
                      <TableCell>{o.invoice_no ?? "—"}</TableCell>
                      <TableCell className="text-right">{o.invoice_value ?? "—"}</TableCell>
                      <TableCell><StatusBadge s={o.status} /></TableCell>
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

function StatusBadge({ s }: { s: string }) {
  const tone: Record<string, string> = {
    Completed: "bg-success/15 text-success border-success/30",
    Pending: "bg-warning/15 text-warning-foreground border-warning/30",
    Closed: "bg-muted text-muted-foreground border-border",
    Holded: "bg-destructive/10 text-destructive border-destructive/30",
    "Complaint - Solved": "bg-accent text-accent-foreground border-border",
  };
  return <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${tone[s] ?? "bg-muted"}`}>{s}</span>;
}
