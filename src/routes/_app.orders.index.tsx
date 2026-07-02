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
const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 25;
const PAGE_SIZE_STORAGE_KEY = "orders.pageSize";
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
  const [pageSize, setPageSizeState] = useState<number>(() => {
    if (typeof window === "undefined") return DEFAULT_PAGE_SIZE;
    const v = Number(window.sessionStorage.getItem(PAGE_SIZE_STORAGE_KEY));
    return PAGE_SIZE_OPTIONS.includes(v as any) ? v : DEFAULT_PAGE_SIZE;
  });
  const setPageSize = (n: number) => {
    setPageSizeState(n);
    setPage(0);
    if (typeof window !== "undefined") window.sessionStorage.setItem(PAGE_SIZE_STORAGE_KEY, String(n));
  };

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
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(page, totalPages - 1);
  const pageRows = rows.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const rangeStart = rows.length === 0 ? 0 : currentPage * pageSize + 1;
  const rangeEnd = Math.min(rows.length, (currentPage + 1) * pageSize);

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
          {/* Desktop / tablet table — raw table so overflow-x-auto works correctly */}
          <div className="hidden md:block w-full overflow-x-auto">
            <table className="w-full caption-bottom text-sm border-separate border-spacing-0" style={{ minWidth: 1240 }}>
              <colgroup>
                <col style={{ width: 48 }} />
                <col style={{ width: 180 }} />
                <col style={{ width: 104 }} />
                <col style={{ width: 220 }} />
                <col style={{ width: 170 }} />
                <col style={{ width: 130 }} />
                <col style={{ width: 88 }} />
                <col style={{ width: 120 }} />
                <col style={{ width: 130 }} />
                <col style={{ width: 140 }} />
                <col style={{ width: 56 }} />
              </colgroup>
              <thead className="sticky top-0 z-20 bg-muted/95 backdrop-blur">
                <tr className="text-[10.5px] uppercase tracking-[0.08em] font-semibold text-muted-foreground">
                  <th className="text-center px-3 py-3.5 border-b border-border/70 sticky left-0 z-30 bg-muted"></th>
                  <th className="text-left px-4 py-3.5 border-b border-border/70 sticky left-[48px] z-30 bg-muted shadow-[1px_0_0_0_var(--border)]">Order</th>

                  <th className="text-left px-3 py-3.5 border-b border-border/70">Date</th>
                  <th className="text-left px-4 py-3.5 border-b border-border/70">Customer</th>
                  <th className="text-left px-4 py-3.5 border-b border-border/70">Agent</th>
                  <th className="text-left px-4 py-3.5 border-b border-border/70">Invoice No.</th>
                  <th className="text-left px-3 py-3.5 border-b border-border/70">Type</th>
                  <th className="text-left px-4 py-3.5 border-b border-border/70">Branch</th>
                  <th className="text-right px-4 py-3.5 border-b border-border/70">Value</th>
                  <th className="text-left px-4 py-3.5 border-b border-border/70">Status</th>
                  <th className="px-2 py-3.5 border-b border-border/70 sticky right-0 z-30 bg-muted shadow-[-1px_0_0_0_var(--border)]"></th>
                </tr>
              </thead>
              <tbody>
                {isLoading && <tr><td colSpan={11} className="text-center text-muted-foreground py-14 border-b border-border/50">Loading…</td></tr>}
                {!isLoading && pageRows.length === 0 && <tr><td colSpan={11} className="text-center text-muted-foreground py-14 border-b border-border/50">No orders found</td></tr>}
                {pageRows.map((o: any, idx: number) => {
                  const editable = canEditOrder(o);
                  const canVerifyRow = canVerifyOrder(o);
                  const verified = !!o.call_center_verified;
                  const zebra = idx % 2 === 1;
                  const rowBg = verified
                    ? "bg-primary/[0.06] dark:bg-primary/[0.12]"
                    : zebra ? "bg-muted/25" : "bg-background";
                  const cellCls = "align-middle border-b border-border/40 py-4";
                  const stickyBg = verified ? "bg-primary/10" : "bg-background";

                  return (
                    <tr
                      key={o.id}
                      className={cn("group transition-colors hover:bg-accent/50", rowBg)}
                    >
                      <td className={cn("text-center px-3 relative sticky left-0 z-10 group-hover:bg-accent", stickyBg, cellCls)} onClick={(e) => e.stopPropagation()}>
                        {verified && <span aria-hidden className="absolute left-0 top-0 bottom-0 w-[3px] bg-primary" />}
                        <Checkbox checked={verified} disabled={!canVerifyRow} onCheckedChange={(v) => toggleVerified(o, !!v)} aria-label="Call Center invoice verified" />
                      </td>
                      <td className={cn("px-4 sticky left-[48px] z-10 group-hover:bg-accent shadow-[1px_0_0_0_var(--border)]", stickyBg, cellCls)}>
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="font-mono font-semibold text-[13px] tracking-tight whitespace-nowrap text-foreground">{formatOrderNo(o.team, o.display_no)}</span>
                          <TeamBadge team={o.team} />
                        </div>
                      </td>
                      <td className={cn("px-3 text-xs text-muted-foreground whitespace-nowrap tabular-nums", cellCls)}>{o.order_date}</td>
                      <td className={cn("px-4 text-sm", cellCls)}>
                        <div className="truncate font-semibold text-foreground leading-tight">{o.customer_name || <span className="text-muted-foreground font-normal">—</span>}</div>
                        {o.customer_phone && <div className="mt-0.5 truncate text-[11px] text-muted-foreground font-mono">{o.customer_phone}</div>}
                      </td>
                      <td className={cn("px-4 text-sm", cellCls)}>
                        <div className="truncate text-foreground leading-tight">{o.agent_name || <span className="text-muted-foreground">—</span>}</div>
                        {o.agent_code && <div className="mt-0.5 truncate text-[11px] text-muted-foreground font-mono">{o.agent_code}</div>}
                      </td>
                      <td className={cn("px-4 text-[13px] font-mono text-foreground/90", cellCls)}>
                        <div className="truncate">{o.invoice_no || <span className="text-muted-foreground font-sans">—</span>}</div>
                      </td>
                      <td className={cn("px-3 text-xs text-muted-foreground whitespace-nowrap", cellCls)}>{o.order_type}</td>
                      <td className={cn("px-4 text-sm", cellCls)}>
                        <div className="font-mono font-medium truncate leading-tight">{o.branch_no ?? "—"}</div>
                        {o.city && <div className="mt-0.5 text-[11px] text-muted-foreground truncate">{o.city}</div>}
                      </td>
                      <td className={cn("px-4 text-right text-sm font-mono font-semibold tabular-nums whitespace-nowrap text-foreground", cellCls)}>{fmtSAR(o.invoice_value)}</td>
                      <td onClick={(e) => e.stopPropagation()} className={cn("px-4", cellCls)}>
                        {editable ? (
                          <Select value={o.status} onValueChange={(v) => updateStatus(o, v)}>
                            <SelectTrigger className={cn("h-8 w-full border px-2.5 text-xs font-semibold rounded-md", STATUS_STYLES[o.status] ?? "")}><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        ) : (
                          <StatusBadge s={o.status} />
                        )}
                      </td>
                      <td className={cn("px-2 text-center sticky right-0 z-10 group-hover:bg-accent/50 shadow-[-1px_0_0_0_hsl(var(--border)/0.4)]", stickyBg, cellCls)}>
                        <Button variant="ghost" size="icon" className="h-8 w-8 opacity-70 group-hover:opacity-100 transition-opacity" onClick={() => navigate({ to: "/orders/$id", params: { id: o.id } })} aria-label={editable ? "Edit order" : "View order"}>
                          {editable ? <Pencil className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>


          {/* Mobile card list */}
          <div className="md:hidden divide-y">
            {isLoading && <div className="text-center text-muted-foreground py-10 text-sm">Loading…</div>}
            {!isLoading && pageRows.length === 0 && <div className="text-center text-muted-foreground py-10 text-sm">No orders found</div>}
            {pageRows.map((o: any) => {
              const editable = canEditOrder(o);
              const canVerifyRow = canVerifyOrder(o);
              const verified = !!o.call_center_verified;
              return (
                <div key={o.id} className={cn("relative p-4 transition-colors active:bg-accent/40", verified && "bg-primary/[0.06] dark:bg-primary/[0.12] border-l-[3px] border-l-primary pl-[13px]")}>
                  <div className="flex items-start gap-3">
                    <div onClick={(e) => e.stopPropagation()} className="pt-1">
                      <Checkbox checked={verified} disabled={!canVerifyRow} onCheckedChange={(v) => toggleVerified(o, !!v)} aria-label="Call Center invoice verified" />
                    </div>
                    <div className="min-w-0 flex-1" onClick={() => navigate({ to: "/orders/$id", params: { id: o.id } })}>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono font-semibold text-sm whitespace-nowrap">{formatOrderNo(o.team, o.display_no)}</span>
                        <TeamBadge team={o.team} />
                        <span className="text-xs text-muted-foreground ml-auto">{o.order_date}</span>
                      </div>
                      <div className="mt-2 text-sm font-medium truncate">{o.customer_name || <span className="text-muted-foreground font-normal">No customer</span>}</div>
                      {o.customer_phone && <div className="text-xs text-muted-foreground font-mono truncate">{o.customer_phone}</div>}
                      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                        <div className="min-w-0"><dt className="text-muted-foreground">Agent</dt><dd className="truncate">{o.agent_name || "—"}</dd></div>
                        <div className="min-w-0"><dt className="text-muted-foreground">Invoice</dt><dd className="truncate font-mono">{o.invoice_no || "—"}</dd></div>
                        <div className="min-w-0"><dt className="text-muted-foreground">Type</dt><dd className="truncate">{o.order_type}</dd></div>
                        <div className="min-w-0"><dt className="text-muted-foreground">Branch</dt><dd className="truncate font-mono">{o.branch_no ?? "—"}{o.city ? ` · ${o.city}` : ""}</dd></div>
                      </dl>
                    </div>
                    <div className="flex flex-col items-end gap-2 shrink-0">
                      <div className="text-sm font-mono font-semibold whitespace-nowrap tabular-nums">{fmtSAR(o.invoice_value)}</div>
                      <div onClick={(e) => e.stopPropagation()}>
                        {editable ? (
                          <Select value={o.status} onValueChange={(v) => updateStatus(o, v)}>
                            <SelectTrigger className={cn("h-7 border px-2 text-[11px] font-medium rounded-md w-[112px]", STATUS_STYLES[o.status] ?? "")}><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        ) : (
                          <StatusBadge s={o.status} />
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>




          <div className="sticky bottom-0 z-10 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 flex flex-wrap items-center justify-between gap-3 p-3 border-t text-sm">
            <div className="text-muted-foreground">
              {rows.length === 0
                ? "No orders"
                : <>Showing <span className="font-medium text-foreground">{rangeStart}–{rangeEnd}</span> of <span className="font-medium text-foreground">{rows.length}</span> orders</>}
            </div>
            <div className="flex items-center gap-2 ml-auto">
              <span className="text-xs text-muted-foreground hidden sm:inline">Rows per page</span>
              <Select value={String(pageSize)} onValueChange={(v) => setPageSize(Number(v))}>
                <SelectTrigger className="h-8 w-[72px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PAGE_SIZE_OPTIONS.map((n) => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}
                </SelectContent>
              </Select>
              <span className="text-xs text-muted-foreground px-2 whitespace-nowrap">Page {currentPage + 1} of {totalPages}</span>
              <Button size="sm" variant="outline" disabled={currentPage === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
                <ChevronLeft className="h-4 w-4 sm:mr-1" /><span className="hidden sm:inline">Prev</span>
              </Button>
              <Button size="sm" variant="outline" disabled={currentPage + 1 >= totalPages} onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}>
                <span className="hidden sm:inline">Next</span><ChevronRight className="h-4 w-4 sm:ml-1" />
              </Button>
            </div>
          </div>

        </CardContent>
      </Card>
    </div>
  );
}

function TeamBadge({ team }: { team: string }) {
  const isTs = team === "telesales";
  const cls = isTs
    ? "bg-chart-3/10 text-chart-3 border-chart-3/25"
    : "bg-primary/10 text-primary border-primary/25";
  const full = isTs ? "Telesales" : "Customer Care";
  const abbr = isTs ? "TS" : "CC";
  return (
    <span
      title={full}
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[10px] font-medium leading-none shrink-0",
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
