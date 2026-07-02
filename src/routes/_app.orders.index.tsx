import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth, isAdministrator } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ChevronLeft, ChevronRight, Download, Eye, Pencil, Plus, Search } from "lucide-react";
import { format } from "date-fns";
import type { DateRange } from "react-day-picker";
import * as XLSX from "xlsx";
import { STATUSES, STATUS_STYLES, TEAMS, CURRENCY, fmtSAR, formatOrderNo } from "@/lib/branches";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { DateRangePicker } from "@/components/date-range-picker";
import { hasPerm } from "@/lib/permissions";

export const Route = createFileRoute("/_app/orders/")({
  head: () => ({ meta: [{ title: "Orders" }] }),
  component: OrdersList,
});

const toISO = (d: Date) => format(d, "yyyy-MM-dd");
const PAGE_SIZE = 50;
const normalizeSearchTerm = (value: string) => value.replace(/[,%.*()]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);

function OrdersList() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { user, role, profile } = useAuth();
  const isAdmin = isAdministrator(role);
  const canView = hasPerm(role, profile?.permissions as any, "view_orders");
  const canCreate = hasPerm(role, profile?.permissions as any, "create_orders");
  const canEditAll = isAdmin || hasPerm(role, profile?.permissions as any, "edit_all_orders");
  const canEditOwn = hasPerm(role, profile?.permissions as any, "edit_orders");
  const canVerifyAll = isAdmin || hasPerm(role, profile?.permissions as any, "verify_all_orders");
  const canVerifyOwn = hasPerm(role, profile?.permissions as any, "verify_own_orders");

  const today = new Date();
  const [range, setRange] = useState<DateRange | undefined>({ from: today, to: today });
  const from = range?.from ? toISO(range.from) : toISO(today);
  const to = range?.to ? toISO(range.to) : from;

  const [q, setQ] = useState("");
  const [team, setTeam] = useState<string>("all");
  const [agent, setAgent] = useState<string>("all");
  const [status, setStatus] = useState<string>("all");
  const [mineOnly, setMineOnly] = useState<boolean>(false);
  const [page, setPage] = useState(0);

  const searching = q.trim().length > 0;
  const term = normalizeSearchTerm(q);

  // Agents list for admin filter, with role for team-based dependency
  const { data: agentOpts } = useQuery({
    queryKey: ["orders-agents"],
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

  // Filter agent list: only operational agents (exclude admin/auditor), further narrow by selected team
  const filteredAgentOpts = useMemo(() => {
    if (!agentOpts) return [];
    const base = agentOpts.filter((a: any) => a.role === "customer_care" || a.role === "telesales");
    if (team === "all") return base;
    return base.filter((a: any) => a.role === team);
  }, [agentOpts, team]);


  const { data, isLoading } = useQuery({
    queryKey: ["orders", from, to, team, agent, status, mineOnly, user?.id, term],
    queryFn: async () => {
      let qb = supabase.from("orders").select("*");
      if (!searching || !term) {
        qb = qb.gte("order_date", from).lte("order_date", to);
      }
      qb = qb.order("order_date", { ascending: false }).order("created_at", { ascending: false }).limit(2000);
      if (team !== "all") qb = qb.eq("team", team as "customer_care" | "telesales");
      if (status !== "all") qb = qb.eq("status", status);
      if (mineOnly && user?.id) qb = qb.eq("agent_id", user.id);
      if (isAdmin && agent !== "all") qb = qb.eq("agent_id", agent);

      const [{ data: orders, error }, { data: profiles }, { data: branches }] = await Promise.all([
        qb,
        supabase.from("profiles").select("id,full_name,agent_code"),
        supabase.from("branches").select("branch_no,city"),
      ]);
      if (error) throw error;
      const nm = new Map((profiles ?? []).map((p: any) => [p.id, p]));
      const bm = new Map((branches ?? []).map((b: any) => [b.branch_no, b.city]));
      const mapped = (orders ?? []).map((o: any) => ({
        ...o,
        agent_name: nm.get(o.agent_id)?.full_name ?? "—",
        agent_code: nm.get(o.agent_id)?.agent_code ?? "",
        city: bm.get(o.branch_no) ?? "",
      }));
      if (!searching || !term) return mapped;
      const needle = term.toLowerCase();
      return mapped.filter((o: any) => [
        formatOrderNo(o.team, o.display_no),
        o.display_no,
        o.invoice_no,
        o.customer_name,
        o.customer_phone,
        o.branch_no,
        o.city,
        o.notes,
        o.agent_name,
      ].filter(Boolean).some((v) => String(v).toLowerCase().includes(needle)));
    },
  });

  const rows = data ?? [];
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const pageRows = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const summary = useMemo(() => {
    const num = (v: any) => Number(v ?? 0);
    const cash = rows.filter((o: any) => o.order_type === "Cash");
    const was = rows.filter((o: any) => o.order_type === "Wasfaty");
    const completed = (xs: any[]) => xs.filter((o: any) => o.status === "Completed");
    const sum = (xs: any[]) => xs.reduce((s, o) => s + num(o.invoice_value), 0);
    return {
      cashSales: sum(cash), cashCompletedSales: sum(completed(cash)), cashCount: cash.length, cashCompletedCount: completed(cash).length,
      wasSales: sum(was), wasCompletedSales: sum(completed(was)), wasCount: was.length, wasCompletedCount: completed(was).length,
      totalSales: sum(rows), totalCompletedSales: sum(completed(rows)),
      totalCount: rows.length, completedCount: completed(rows).length,
    };
  }, [rows]);

  const dateLabel = useMemo(() => {
    if (!range?.from) return "Pick a date";
    if (!range.to || toISO(range.from) === toISO(range.to)) return format(range.from, "PP");
    return `${format(range.from, "PP")} — ${format(range.to, "PP")}`;
  }, [range]);

  const canEditOrder = (order: any) => canEditAll || (user?.id === order.agent_id && canEditOwn);
  const canVerifyOrder = (order: any) => canVerifyAll || (user?.id === order.agent_id && canVerifyOwn);

  const updateStatus = async (order: any, newStatus: string) => {
    if (!canEditOrder(order)) { toast.error("You don't have permission to edit this order"); return; }
    const orderId = order.id;
    const { error } = await supabase.from("orders").update({ status: newStatus }).eq("id", orderId);
    if (error) { toast.error(error.message); return; }
    toast.success("Status updated");
    qc.invalidateQueries({ queryKey: ["orders"] });
    qc.invalidateQueries({ queryKey: ["dashboard"] });
  };

  const toggleVerified = async (order: any, value: boolean) => {
    if (!canVerifyOrder(order)) { toast.error("You don't have permission to verify this order"); return; }
    const orderId = order.id;
    const { error } = await supabase.from("orders").update({ call_center_verified: value } as any).eq("id", orderId);
    if (error) { toast.error(error.message); return; }
    qc.invalidateQueries({ queryKey: ["orders"] });
    qc.invalidateQueries({ queryKey: ["dashboard"] });
  };

  const exportXlsx = () => {
    if (!hasPerm(role, profile?.permissions as any, "export_reports")) { toast.error("You don't have permission to export reports"); return; }
    const xrows = rows.map((o: any) => ({
      "Order #": formatOrderNo(o.team, o.display_no),
      Date: o.order_date,
      Team: o.team === "telesales" ? "Telesales" : "Customer Care",
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
    const ws = XLSX.utils.json_to_sheet(xrows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Orders");
    XLSX.writeFile(wb, `orders_${from}_${to}.xlsx`);
  };

  // Reset to first page when filters change
  const onFilterChange = (fn: () => void) => { fn(); setPage(0); };

  if (!canView) {
    return <div className="text-center py-16"><Eye className="mx-auto h-10 w-10 text-muted-foreground" /><p className="mt-2 text-sm text-muted-foreground">You don't have access to Orders.</p></div>;
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 sm:flex sm:flex-wrap sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight truncate">Orders</h1>
          <p className="text-xs sm:text-sm text-muted-foreground truncate">
            <span className="font-medium text-foreground">{rows.length}</span> {mineOnly ? "of your" : ""} orders · {searching ? "search results" : dateLabel}
          </p>
        </div>
        <div className="flex gap-2 items-center shrink-0">
          <Button variant={mineOnly ? "default" : "outline"} size="sm" onClick={() => onFilterChange(() => setMineOnly((v) => !v))}>
            {mineOnly ? "My orders" : "All orders"}
          </Button>
          {canCreate && <Button size="sm" onClick={() => navigate({ to: "/orders/new" })}><Plus className="h-4 w-4 sm:mr-2" /><span className="hidden sm:inline">New order</span></Button>}
        </div>
      </div>

      <Card>
        <CardContent className="p-3 sm:p-4 flex flex-wrap items-center gap-2 lg:gap-3">
          <div className="relative flex-1 min-w-[200px] lg:max-w-xs">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input placeholder="Search order, invoice, customer, phone…" value={q} maxLength={80} onChange={(e) => { setQ(e.target.value); setPage(0); }} className="pl-9 h-10" />
          </div>
          <Select value={team} onValueChange={(v) => onFilterChange(() => { setTeam(v); setAgent("all"); })}>
            <SelectTrigger className="h-10 w-[150px]"><SelectValue placeholder="Team" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All teams</SelectItem>
              {TEAMS.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
            </SelectContent>
          </Select>
          {isAdmin && (
            <Select value={agent} onValueChange={(v) => onFilterChange(() => setAgent(v))}>
              <SelectTrigger className="h-10 w-[180px]"><SelectValue placeholder="Agent" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All agents</SelectItem>
                {filteredAgentOpts.map((a: any) => (
                  <SelectItem key={a.id} value={a.id}>{a.full_name}{a.agent_code ? ` (${a.agent_code})` : ""}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Select value={status} onValueChange={(v) => onFilterChange(() => setStatus(v))}>
            <SelectTrigger className="h-10 w-[140px]"><SelectValue placeholder="Status" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
            </SelectContent>
          </Select>
          <DateRangePicker range={range} onChange={(r) => { setRange(r); setPage(0); }} disabled={searching} />
          {hasPerm(role, profile?.permissions as any, "export_reports") && <Button variant="outline" size="sm" onClick={exportXlsx} className="h-10 ml-auto"><Download className="h-4 w-4 mr-2" />Export</Button>}
        </CardContent>
      </Card>

      {/* KPI summary: 3 cards — Cash · Wasfaty · Total (each shows sales + completed sales + total/completed orders split) */}
      <div className="grid gap-3 sm:grid-cols-3">
        <KpiCard label="Cash" tone="from-amber-50 to-transparent dark:from-amber-500/10"
          totalSales={summary.cashSales} completedSales={summary.cashCompletedSales}
          totalOrders={summary.cashCount} completedOrders={summary.cashCompletedCount} />
        <KpiCard label="Wasfaty" tone="from-sky-50 to-transparent dark:from-sky-500/10"
          totalSales={summary.wasSales} completedSales={summary.wasCompletedSales}
          totalOrders={summary.wasCount} completedOrders={summary.wasCompletedCount} />
        <KpiCard label="Total" tone="from-primary/10 to-transparent" highlight
          totalSales={summary.totalSales} completedSales={summary.totalCompletedSales}
          totalOrders={summary.totalCount} completedOrders={summary.completedCount} />
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="w-full overflow-hidden">
            <Table className="table-fixed w-full">
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead className="w-8 text-center px-1">✓</TableHead>
                  <TableHead className="text-xs uppercase tracking-wider font-semibold">Order</TableHead>
                  <TableHead className="hidden md:table-cell text-xs uppercase tracking-wider font-semibold w-20">Date</TableHead>
                  <TableHead className="hidden sm:table-cell text-xs uppercase tracking-wider font-semibold w-[22%] md:w-[18%]">Customer</TableHead>
                  <TableHead className="hidden lg:table-cell text-xs uppercase tracking-wider font-semibold w-16">Type</TableHead>
                  <TableHead className="hidden md:table-cell text-xs uppercase tracking-wider font-semibold w-20">Branch</TableHead>
                  <TableHead className="text-right text-xs uppercase tracking-wider font-semibold w-[74px] sm:w-24">Value</TableHead>
                  <TableHead className="text-xs uppercase tracking-wider font-semibold w-[92px] sm:w-[116px]">Status</TableHead>
                  <TableHead className="w-8 sm:w-10 px-0"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading && <TableRow><TableCell colSpan={9} className="text-center text-muted-foreground py-8">Loading…</TableCell></TableRow>}
                {!isLoading && pageRows.length === 0 && <TableRow><TableCell colSpan={9} className="text-center text-muted-foreground py-8">No orders found</TableCell></TableRow>}
                {pageRows.map((o: any, idx: number) => {
                  const editable = canEditOrder(o);
                  const canVerifyRow = canVerifyOrder(o);
                  const verified = !!o.call_center_verified;
                  return (
                    <TableRow key={o.id} className={cn("transition-colors", idx % 2 === 1 && "bg-muted/20", verified && "bg-green-50/60 dark:bg-green-500/5", "hover:bg-accent/40")}>
                      <TableCell className="text-center px-1" onClick={(e) => e.stopPropagation()}>
                        <Checkbox checked={verified} disabled={!canVerifyRow} onCheckedChange={(v) => toggleVerified(o, !!v)} aria-label="Call Center invoice verified" />
                      </TableCell>
                      <TableCell className="font-mono font-semibold overflow-hidden">
                        <div className="truncate">{formatOrderNo(o.team, o.display_no)}</div>
                        <div className="mt-1 flex min-w-0 flex-wrap gap-x-1 gap-y-0.5 text-[10px] font-sans font-normal text-muted-foreground">
                          <TeamBadge team={o.team} />
                          <span className="sm:hidden truncate max-w-full">{o.customer_name || "—"}</span>
                          <span className="md:hidden">{o.order_date}</span>
                          {o.branch_no && <span className="md:hidden">· {o.branch_no}{o.city ? ` — ${o.city}` : ""}</span>}
                          {o.delivery_type && <span>· {o.delivery_type}</span>}
                          {o.invoice_no && <span>· Inv {o.invoice_no}</span>}
                          {o.agent_name && <span>· {o.agent_name}</span>}
                        </div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell whitespace-nowrap text-xs">{o.order_date}</TableCell>
                      <TableCell className="hidden sm:table-cell truncate overflow-hidden">{o.customer_name || "—"}</TableCell>
                      <TableCell className="hidden lg:table-cell text-xs truncate">{o.order_type}</TableCell>
                      <TableCell className="hidden md:table-cell font-mono text-xs truncate">{o.branch_no ?? "—"}</TableCell>
                      <TableCell className="text-right whitespace-nowrap text-[11px] sm:text-xs font-mono">{fmtSAR(o.invoice_value)}</TableCell>
                      <TableCell onClick={(e) => e.stopPropagation()} className="px-1 sm:px-2">
                        {editable ? (
                          <Select value={o.status} onValueChange={(v) => updateStatus(o, v)}>
                            <SelectTrigger className={`h-8 w-full border px-1.5 sm:px-2 text-[11px] sm:text-xs ${STATUS_STYLES[o.status] ?? ""}`}><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        ) : (
                          <StatusBadge s={o.status} />
                        )}
                      </TableCell>
                      <TableCell className="px-0 text-center">
                        {editable ? (
                          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => navigate({ to: "/orders/$id", params: { id: o.id } })} aria-label="Edit order">
                            <Pencil className="h-4 w-4" />
                          </Button>
                        ) : (
                          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => navigate({ to: "/orders/$id", params: { id: o.id } })} aria-label="View order">
                            <Eye className="h-4 w-4" />
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>


          {rows.length > PAGE_SIZE && (
            <div className="flex items-center justify-between p-3 border-t text-sm">
              <div className="text-muted-foreground">
                Page {page + 1} of {totalPages} · showing {pageRows.length} of {rows.length}
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
                  <ChevronLeft className="h-4 w-4 mr-1" />Prev
                </Button>
                <Button size="sm" variant="outline" disabled={page + 1 >= totalPages} onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}>
                  Next<ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function TeamBadge({ team }: { team: string }) {
  const isTs = team === "telesales";
  const cls = isTs
    ? "bg-chart-3/15 text-chart-3 border-chart-3/30"
    : "bg-primary/15 text-primary border-primary/30";
  const full = isTs ? "Telesales" : "Customer Care";
  const abbr = isTs ? "TS" : "CC";
  return (
    <span
      title={full}
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[10px] sm:text-xs font-medium",
        cls,
      )}
    >
      <span className="sm:hidden">{abbr}</span>
      <span className="hidden sm:inline">{full}</span>
    </span>
  );
}

function StatusBadge({ s }: { s: string }) {
  return <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${STATUS_STYLES[s] ?? "bg-muted"}`}>{s}</span>;
}

function KpiCard({ label, tone, highlight, totalSales, completedSales, totalOrders, completedOrders }: {
  label: string; tone: string; highlight?: boolean;
  totalSales: number; completedSales: number; totalOrders: number; completedOrders: number;
}) {
  return (
    <div className={cn("relative rounded-xl border bg-gradient-to-br p-4 shadow-sm", tone, highlight && "border-primary/40 shadow-md")}>
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">{label}</div>
      <div className="mt-3 space-y-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-xs text-muted-foreground">Total sales</span>
          <span className="text-base font-semibold tabular-nums truncate">{fmtSAR(totalSales)}</span>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-xs text-muted-foreground">Completed sales</span>
          <span className="text-base font-semibold tabular-nums truncate text-green-600 dark:text-green-400">{fmtSAR(completedSales)}</span>
        </div>
      </div>
      <div className="mt-3 pt-3 border-t border-border/60 grid grid-cols-2 gap-2">
        <div className="text-left">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Total orders</div>
          <div className="text-2xl font-bold tabular-nums leading-tight">{totalOrders}</div>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Completed</div>
          <div className="text-2xl font-bold tabular-nums leading-tight text-green-600 dark:text-green-400">{completedOrders}</div>
        </div>
      </div>
    </div>
  );
}
