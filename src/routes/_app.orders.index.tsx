import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CalendarIcon, CheckCircle2, Download, Plus, Search } from "lucide-react";
import { format } from "date-fns";
import type { DateRange } from "react-day-picker";
import * as XLSX from "xlsx";
import { STATUSES, STATUS_STYLES, TEAMS, CURRENCY, fmtSAR } from "@/lib/branches";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/orders/")({
  head: () => ({ meta: [{ title: "Orders" }] }),
  component: OrdersList,
});

const toISO = (d: Date) => format(d, "yyyy-MM-dd");

function OrdersList() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { profile, user, role } = useAuth();

  const today = new Date();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  const [range, setRange] = useState<DateRange | undefined>({ from: monthStart, to: monthEnd });
  const from = range?.from ? toISO(range.from) : toISO(monthStart);
  const to = range?.to ? toISO(range.to) : from;

  const [q, setQ] = useState("");
  const [team, setTeam] = useState<string>("all");
  const [status, setStatus] = useState<string>("all");
  const [mineOnly, setMineOnly] = useState<boolean>(false);
  const [dateOpen, setDateOpen] = useState(false);

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

  // Summary now reflects the SELECTED date range (single day or range), and the My Orders toggle.
  const summary = useMemo(() => {
    const num = (v: any) => Number(v ?? 0);
    const cash = filtered.filter((o: any) => o.order_type === "Cash");
    const was = filtered.filter((o: any) => o.order_type === "Wasfaty");
    const completed = (rows: any[]) => rows.filter((o: any) => o.status === "Completed");
    const sum = (rows: any[]) => rows.reduce((s, o) => s + num(o.invoice_value), 0);
    return {
      cashSales: sum(cash),
      cashCompletedSales: sum(completed(cash)),
      cashCount: cash.length,
      wasSales: sum(was),
      wasCompletedSales: sum(completed(was)),
      wasCount: was.length,
      totalSales: sum(filtered),
      totalCompletedSales: sum(completed(filtered)),
      totalCount: filtered.length,
      completedCount: completed(filtered).length,
    };
  }, [filtered]);

  const dateLabel = useMemo(() => {
    if (!range?.from) return "Pick a date";
    if (!range.to || toISO(range.from) === toISO(range.to)) return format(range.from, "PP");
    return `${format(range.from, "PP")} — ${format(range.to, "PP")}`;
  }, [range]);

  const setQuick = (kind: "today" | "7d" | "30d" | "month") => {
    const today = new Date();
    if (kind === "today") { setRange({ from: today, to: today }); return; }
    if (kind === "7d") { const f = new Date(); f.setDate(f.getDate() - 6); setRange({ from: f, to: today }); return; }
    if (kind === "30d") { const f = new Date(); f.setDate(f.getDate() - 29); setRange({ from: f, to: today }); return; }
    if (kind === "month") { const f = new Date(today.getFullYear(), today.getMonth(), 1); setRange({ from: f, to: today }); return; }
  };

  const updateStatus = async (orderId: string, newStatus: string) => {
    const { error } = await supabase.from("orders").update({ status: newStatus }).eq("id", orderId);
    if (error) { toast.error(error.message); return; }
    toast.success("Status updated");
    qc.invalidateQueries({ queryKey: ["orders"] });
    qc.invalidateQueries({ queryKey: ["dashboard"] });
  };

  const toggleVerified = async (orderId: string, value: boolean) => {
    const { error } = await supabase.from("orders").update({ call_center_verified: value } as any).eq("id", orderId);
    if (error) { toast.error(error.message); return; }
    qc.invalidateQueries({ queryKey: ["orders"] });
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
      "CC Verified": o.call_center_verified ? "Yes" : "No",
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
          <p className="text-sm text-muted-foreground">Showing <span className="font-medium text-foreground">{filtered.length}</span> {mineOnly ? "of your" : ""} orders · {dateLabel}</p>
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
          <div className="md:col-span-2">
            <label className="text-xs text-muted-foreground">Date</label>
            <Popover open={dateOpen} onOpenChange={setDateOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" className={cn("w-full justify-start font-normal", !range?.from && "text-muted-foreground")}>
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {dateLabel}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0 pointer-events-auto" align="start">
                <div className="flex flex-wrap gap-1 p-2 border-b">
                  <Button size="sm" variant="ghost" onClick={() => setQuick("today")}>Today</Button>
                  <Button size="sm" variant="ghost" onClick={() => setQuick("7d")}>Last 7 days</Button>
                  <Button size="sm" variant="ghost" onClick={() => setQuick("30d")}>Last 30 days</Button>
                  <Button size="sm" variant="ghost" onClick={() => setQuick("month")}>This month</Button>
                </div>
                <Calendar
                  mode="range"
                  selected={range}
                  onSelect={setRange}
                  numberOfMonths={2}
                  defaultMonth={range?.from}
                  className="pointer-events-auto"
                />
              </PopoverContent>
            </Popover>
          </div>
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

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <SummaryCard label="Cash sales" value={fmtSAR(summary.cashSales)} sub={`${summary.cashCount} orders`} />
        <SummaryCard label="Completed cash" value={fmtSAR(summary.cashCompletedSales)} accent="text-[oklch(0.62_0.15_155)]" />
        <SummaryCard label="Wasfaty sales" value={fmtSAR(summary.wasSales)} sub={`${summary.wasCount} orders`} />
        <SummaryCard label="Completed Wasfaty" value={fmtSAR(summary.wasCompletedSales)} accent="text-[oklch(0.62_0.15_155)]" />
        <SummaryCard label="Total sales" value={fmtSAR(summary.totalSales)} sub={`${summary.totalCount} orders`} />
        <SummaryCard label="Completed sales" value={fmtSAR(summary.totalCompletedSales)} sub={`${summary.completedCount} completed`} accent="text-[oklch(0.62_0.15_155)]" />
        <SummaryCard label="Total orders" value={summary.totalCount} />
        <SummaryCard label="Completed orders" value={summary.completedCount} accent="text-[oklch(0.62_0.15_155)]" />
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">CC ✓</TableHead>
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
                {isLoading && <TableRow><TableCell colSpan={12} className="text-center text-muted-foreground py-8">Loading…</TableCell></TableRow>}
                {!isLoading && filtered.length === 0 && <TableRow><TableCell colSpan={12} className="text-center text-muted-foreground py-8">No orders found</TableCell></TableRow>}
                {filtered.map((o: any) => {
                  const editable = profile?.id === o.agent_id || role === "admin";
                  const verified = !!o.call_center_verified;
                  const go = () => editable && navigate({ to: "/orders/$id", params: { id: o.id } });
                  return (
                    <TableRow key={o.id} className={cn(editable && "cursor-pointer", verified && "bg-green-50/60 dark:bg-green-500/5")}>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center gap-1">
                          <Checkbox
                            checked={verified}
                            onCheckedChange={(v) => toggleVerified(o.id, !!v)}
                            aria-label="Call Center invoice verified"
                          />
                          {verified && <CheckCircle2 className="h-4 w-4 text-green-600" />}
                        </div>
                      </TableCell>
                      <TableCell className="font-mono font-semibold" onClick={go}>{o.display_no ?? "—"}</TableCell>
                      <TableCell onClick={go}>{o.order_date}</TableCell>
                      <TableCell><TeamBadge team={o.team} /></TableCell>
                      <TableCell className="whitespace-nowrap" onClick={go}>{o.agent_name}</TableCell>
                      <TableCell className="whitespace-nowrap">{o.customer_name || "—"}</TableCell>
                      <TableCell className="whitespace-nowrap font-mono text-xs">{o.customer_phone || "—"}</TableCell>
                      <TableCell>{o.order_type}</TableCell>
                      <TableCell>{o.branch_no ?? "—"}</TableCell>
                      <TableCell>{o.city || "—"}</TableCell>
                      <TableCell className="text-right whitespace-nowrap">{fmtSAR(o.invoice_value)}</TableCell>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        {editable ? (
                          <Select value={o.status} onValueChange={(v) => updateStatus(o.id, v)}>
                            <SelectTrigger className={`h-8 w-[140px] border ${STATUS_STYLES[o.status] ?? ""}`}><SelectValue /></SelectTrigger>
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
    return <span className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium bg-chart-3/15 text-chart-3 border-chart-3/30">Telesales</span>;
  }
  return <span className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium bg-primary/15 text-primary border-primary/30">Customer Care</span>;
}

function StatusBadge({ s }: { s: string }) {
  return <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[s] ?? "bg-muted"}`}>{s}</span>;
}

function SummaryCard({ label, value, sub, accent }: { label: string; value: string | number; sub?: string; accent?: string }) {
  return (
    <Card>
      <CardContent className="p-3">
        <div className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</div>
        <div className={`text-lg font-semibold mt-0.5 ${accent ?? ""}`}>{value}</div>
        {sub && <div className="text-[11px] text-muted-foreground mt-0.5">{sub}</div>}
      </CardContent>
    </Card>
  );
}
