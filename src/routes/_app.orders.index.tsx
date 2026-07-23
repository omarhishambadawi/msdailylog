import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth, isAdministrator } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";

import { Check, ChevronLeft, ChevronRight, Copy, Download, Eye, Pencil, Plus, Search, ShieldCheck } from "lucide-react";
import { format, parseISO } from "date-fns";
import type { DateRange } from "react-day-picker";
// xlsx is lazy-loaded inside the export handler to keep it out of the initial route chunk.
import { STATUSES, STATUS_STYLES, TEAMS, CURRENCY, fmtSAR, formatOrderNo } from "@/lib/branches";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { DateRangePicker } from "@/components/date-range-picker";
import { hasPerm } from "@/lib/permissions";
import { queryKeys } from "@/lib/query-keys";
import { useAgentDirectory } from "@/lib/directory";

export const Route = createFileRoute("/_app/orders/")({
  head: () => ({ meta: [{ title: "Orders" }] }),
  component: OrdersList,
});

const toISO = (d: Date) => format(d, "yyyy-MM-dd");
const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 25;
const PAGE_SIZE_STORAGE_KEY = "orders.pageSize";
const normalizeSearchTerm = (value: string) => value.replace(/[,%.*()]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);

/** Format ISO date as "Friday, Jul 10, 2026". */
const fmtOrderDate = (iso: string | null | undefined) => {
  if (!iso) return "—";
  try { return format(parseISO(iso), "EEEE, MMM d, yyyy"); } catch { return String(iso); }
};

/** Short form for mobile / dense cells: "Fri, Jul 10". */
const fmtOrderDateShort = (iso: string | null | undefined) => {
  if (!iso) return "—";
  try { return format(parseISO(iso), "EEE, MMM d"); } catch { return String(iso); }
};

// In-memory filter cache. Survives SPA navigation (e.g. edit an order and come
// back) but is wiped on a full page refresh because the JS module reloads.
type OrdersFilterCache = {
  range?: { from?: string; to?: string };
  q: string;
  team: string;
  agent: string;
  status: string;
  mineOnly: boolean;
  page: number;
};
let ordersFilterCache: OrdersFilterCache | null = null;

/** Build an .or() filter string for PostgREST across searchable columns. */
function buildSearchOr(term: string): string {
  // PostgREST .or() needs values with commas escaped; we already normalised
  // out `,` / `%` / `*` / `.` / `(` / `)` in normalizeSearchTerm().
  const t = `%${term}%`;
  return [
    `customer_name.ilike.${t}`,
    `customer_phone.ilike.${t}`,
    `invoice_no.ilike.${t}`,
    `display_no.ilike.${t}`,
    `branch_no.ilike.${t}`,
    `notes.ilike.${t}`,
  ].join(",");
}

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
  const initial = ordersFilterCache;
  const [range, setRange] = useState<DateRange | undefined>(() => {
    if (initial?.range?.from) {
      return { from: new Date(initial.range.from), to: initial.range.to ? new Date(initial.range.to) : undefined };
    }
    return { from: today, to: today };
  });
  const from = range?.from ? toISO(range.from) : toISO(today);
  const to = range?.to ? toISO(range.to) : from;

  const [q, setQ] = useState(initial?.q ?? "");
  const [team, setTeam] = useState<string>(initial?.team ?? "all");
  const [agent, setAgent] = useState<string>(initial?.agent ?? "all");
  const [status, setStatus] = useState<string>(initial?.status ?? "all");
  const [mineOnly, setMineOnly] = useState<boolean>(initial?.mineOnly ?? false);
  const [page, setPage] = useState(initial?.page ?? 0);
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

  // Debounce the search input so we don't fire a query per keystroke.
  const [debouncedQ, setDebouncedQ] = useState(q);
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQ(q), 300);
    return () => window.clearTimeout(t);
  }, [q]);

  // Persist filter state on every render so returning from edit restores it.
  ordersFilterCache = {
    range: range?.from ? { from: range.from.toISOString(), to: range.to?.toISOString() } : undefined,
    q, team, agent, status, mineOnly, page,
  };

  const term = normalizeSearchTerm(debouncedQ);
  const searching = term.length > 0;

  // Shared agent directory (profiles + user_roles). Powers both the admin filter
  // dropdown and the per-row name/code enrichment below, so it stays enabled for
  // every user (RLS scopes non-admins to their own row, as before).
  const { data: agentOpts } = useAgentDirectory();

  // Filter agent list: only operational agents (exclude admin/auditor), further narrow by selected team
  const filteredAgentOpts = useMemo(() => {
    if (!agentOpts) return [];
    const base = agentOpts.filter((a: any) => a.role === "customer_care" || a.role === "telesales");
    if (team === "all") return base;
    return base.filter((a: any) => a.role === team);
  }, [agentOpts, team]);

  // Name lookup for row enrichment, derived from the shared directory.
  const namesById = useMemo(
    () => new Map((agentOpts ?? []).map((p: any) => [p.id, p])),
    [agentOpts],
  );

  // City lookup for branch enrichment (small table).
  const { data: cities } = useQuery({
    queryKey: queryKeys.lookups.ordersDirectory(),
    queryFn: async () => {
      const { data: branches } = await supabase.from("branches").select("branch_no,city");
      return new Map((branches ?? []).map((b: any) => [b.branch_no, b.city]));
    },
  });

  const filterKey = { from, to, team, agent, status, mineOnly, term, userId: user?.id };

  // Apply the shared filter set to a PostgREST query builder.
  const applyFilters = (qb: any) => {
    if (!searching) qb = qb.gte("order_date", from).lte("order_date", to);
    if (team !== "all") qb = qb.eq("team", team as "customer_care" | "telesales");
    if (status !== "all") qb = qb.eq("status", status);
    if (mineOnly && user?.id) qb = qb.eq("agent_id", user.id);
    if (isAdmin && agent !== "all") qb = qb.eq("agent_id", agent);
    if (searching) qb = qb.or(buildSearchOr(term));
    return qb;
  };

  // Paginated page fetch (server-side range + count).
  const { data: pageData, isLoading, isFetching } = useQuery({
    queryKey: queryKeys.orders.page(filterKey, page, pageSize),
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const offset = page * pageSize;
      let qb = supabase.from("orders").select("*", { count: "exact" });
      qb = applyFilters(qb);
      qb = qb.order("order_date", { ascending: false }).order("created_at", { ascending: false });
      qb = qb.range(offset, offset + pageSize - 1);
      const { data, count, error } = await qb;
      if (error) throw error;
      return { rows: (data ?? []) as any[], total: count ?? 0 };
    },
  });

  // KPI totals across the entire filtered set (server-side aggregation).
  const { data: kpi } = useQuery({
    queryKey: queryKeys.orders.kpi(filterKey),
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("orders_kpi_summary" as any, {
        _from: from,
        _to: to,
        _team: team,
        _agent: isAdmin && agent !== "all" ? agent : null,
        _status: status,
        _mine: mineOnly && !!user?.id,
        _q: searching ? term : null,
      });
      if (error) throw error;
      return (data ?? {}) as Record<string, number>;
    },
  });

  const enrichedRows = useMemo(() => {
    const rowsRaw = pageData?.rows ?? [];
    return rowsRaw.map((o: any) => ({
      ...o,
      agent_name: namesById.get(o.agent_id)?.full_name ?? "—",
      agent_code: namesById.get(o.agent_id)?.agent_code ?? "",
      city: cities?.get(o.branch_no) ?? "",
    }));
  }, [pageData, namesById, cities]);

  const total = pageData?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(page, totalPages - 1);
  const rangeStart = total === 0 ? 0 : currentPage * pageSize + 1;
  const rangeEnd = Math.min(total, (currentPage + 1) * pageSize);
  const pageRows = enrichedRows;

  const summary = {
    cashSales: Number(kpi?.cash_sales ?? 0),
    cashCompletedSales: Number(kpi?.cash_completed_sales ?? 0),
    cashCount: Number(kpi?.cash_count ?? 0),
    cashCompletedCount: Number(kpi?.cash_completed_count ?? 0),
    wasSales: Number(kpi?.was_sales ?? 0),
    wasCompletedSales: Number(kpi?.was_completed_sales ?? 0),
    wasCount: Number(kpi?.was_count ?? 0),
    wasCompletedCount: Number(kpi?.was_completed_count ?? 0),
    totalSales: Number(kpi?.total_sales ?? 0),
    totalCompletedSales: Number(kpi?.total_completed_sales ?? 0),
    totalCount: Number(kpi?.total_count ?? 0),
    completedCount: Number(kpi?.completed_count ?? 0),
  };

  const dateLabel = useMemo(() => {
    if (!range?.from) return "Pick a date";
    if (!range.to || toISO(range.from) === toISO(range.to)) return format(range.from, "PP");
    return `${format(range.from, "PP")} — ${format(range.to, "PP")}`;
  }, [range]);

  const canEditOrder = (order: any) => canEditAll || (user?.id === order.agent_id && canEditOwn);
  const canVerifyOrder = (order: any) => canVerifyAll || (user?.id === order.agent_id && canVerifyOwn);

  const updateStatus = async (order: any, newStatus: string) => {
    if (!canEditOrder(order)) { toast.error("You don't have permission to edit this order"); return; }
    const { error } = await supabase.from("orders").update({ status: newStatus }).eq("id", order.id);
    if (error) { toast.error(error.message); return; }
    toast.success("Status updated");
    qc.invalidateQueries({ queryKey: queryKeys.orders.all() });
    qc.invalidateQueries({ queryKey: queryKeys.dashboard.all() });
  };

  const toggleVerified = async (order: any, value: boolean) => {
    if (!canVerifyOrder(order)) { toast.error("You don't have permission to verify this order"); return; }
    const { error } = await supabase.from("orders").update({ call_center_verified: value } as any).eq("id", order.id);
    if (error) { toast.error(error.message); return; }
    qc.invalidateQueries({ queryKey: queryKeys.orders.all() });
    qc.invalidateQueries({ queryKey: queryKeys.dashboard.all() });
  };

  const exportXlsx = async () => {
    if (!hasPerm(role, profile?.permissions as any, "export_reports")) { toast.error("You don't have permission to export reports"); return; }
    toast.info("Preparing export…");
    // Fetch every row that matches the current filter, in batches, respecting RLS.
    const BATCH = 1000;
    const all: any[] = [];
    for (let start = 0; ; start += BATCH) {
      let qb = supabase.from("orders").select("*");
      qb = applyFilters(qb);
      qb = qb.order("order_date", { ascending: false }).order("created_at", { ascending: false });
      qb = qb.range(start, start + BATCH - 1);
      const { data, error } = await qb;
      if (error) { toast.error(error.message); return; }
      all.push(...(data ?? []));
      if (!data || data.length < BATCH) break;
    }
    const names = namesById;
    const XLSX = await import("xlsx");
    const xrows = all.map((o: any) => ({
      "Order #": formatOrderNo(o.team, o.display_no),
      Date: fmtOrderDate(o.order_date),
      Team: o.team === "telesales" ? "Telesales" : "Customer Care",
      Agent: names?.get(o.agent_id)?.full_name ?? "",
      "Agent Code": names?.get(o.agent_id)?.agent_code ?? "",
      Customer: o.customer_name,
      "Phone Number": o.customer_phone,
      "Order Type": o.order_type,
      "Branch No.": o.branch_no,
      City: cities?.get(o.branch_no) ?? "",
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
            <span className="font-medium text-foreground">{total}</span> {mineOnly ? "of your" : ""} orders · {searching ? "search results" : dateLabel}
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
        <KpiCard label="Cash" tone="from-[var(--tint-cash)] to-transparent"
          totalSales={summary.cashSales} completedSales={summary.cashCompletedSales}
          totalOrders={summary.cashCount} completedOrders={summary.cashCompletedCount} />
        <KpiCard label="Wasfaty" tone="from-[var(--tint-wasfaty)] to-transparent"
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
            <table className="w-full caption-bottom text-sm border-separate border-spacing-0" style={{ minWidth: 1200 }}>
              <colgroup>
                <col style={{ width: 44 }} />
                <col style={{ width: 168 }} />
                <col style={{ width: 176 }} />
                <col style={{ width: 210 }} />
                <col style={{ width: 160 }} />
                <col style={{ width: 140 }} />
                <col style={{ width: 76 }} />
                <col style={{ width: 118 }} />
                <col style={{ width: 122 }} />
                <col style={{ width: 132 }} />
                <col style={{ width: 48 }} />
              </colgroup>
              <thead className="sticky top-0 z-10 bg-muted/95 backdrop-blur">
                <tr className="text-[10.5px] uppercase tracking-[0.08em] font-semibold text-muted-foreground">
                  <th className="text-center px-2 py-3 border-b border-border/70" title="Call Center verified">
                    <ShieldCheck className="h-4 w-4 mx-auto text-primary/80" aria-label="Verified" />
                  </th>
                  <th className="text-left px-3 py-3 border-b border-border/70">Order</th>
                  <th className="text-left px-3 py-3 border-b border-border/70">Date</th>
                  <th className="text-left px-3 py-3 border-b border-border/70">Customer</th>
                  <th className="text-left px-3 py-3 border-b border-border/70">Agent</th>
                  <th className="text-left px-3 py-3 border-b border-border/70">Invoice No.</th>
                  <th className="text-left px-2 py-3 border-b border-border/70">Type</th>
                  <th className="text-left px-3 py-3 border-b border-border/70">Branch</th>
                  <th className="text-right px-3 py-3 border-b border-border/70">Value</th>
                  <th className="text-left px-3 py-3 border-b border-border/70">Status</th>
                  <th className="px-1 py-3 border-b border-border/70"></th>
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
                    ? "bg-[var(--tint-row)]"
                    : zebra ? "bg-muted/25" : "bg-background";
                  const cellCls = "align-middle border-b border-border/40 py-3";
                  return (
                    <tr
                      key={o.id}
                      className={cn("group transition-colors hover:bg-accent/50", rowBg)}
                    >
                      <td className={cn("text-center px-2 relative", cellCls)} onClick={(e) => e.stopPropagation()}>
                        {verified && <span aria-hidden className="absolute left-0 top-0 bottom-0 w-[3px] bg-primary" />}
                        <Checkbox checked={verified} disabled={!canVerifyRow} onCheckedChange={(v) => toggleVerified(o, !!v)} aria-label="Call Center invoice verified" />
                      </td>
                      <td className={cn("px-3", cellCls)}>
                        <div className="flex flex-col items-start gap-1 min-w-0">
                          <CopyableOrderNo value={formatOrderNo(o.team, o.display_no)} />
                          <TeamBadge team={o.team} />
                        </div>
                      </td>

                      <td className={cn("px-3 text-xs text-muted-foreground whitespace-nowrap tabular-nums", cellCls)}>{fmtOrderDate(o.order_date)}</td>
                      <td className={cn("px-3 text-sm", cellCls)}>
                        <div className="truncate font-semibold text-foreground leading-tight">{o.customer_name || <span className="text-muted-foreground font-normal">—</span>}</div>
                        {o.customer_phone && <div className="mt-0.5 truncate text-[11px] text-muted-foreground font-mono">{o.customer_phone}</div>}
                      </td>
                      <td className={cn("px-3 text-sm", cellCls)}>
                        <div className="truncate text-foreground leading-tight">{o.agent_name || <span className="text-muted-foreground">—</span>}</div>
                        {o.agent_code && <div className="mt-0.5 truncate text-[11px] text-muted-foreground font-mono">{o.agent_code}</div>}
                      </td>
                      <td className={cn("px-3 text-[13px] font-mono text-foreground/90", cellCls)}>
                        <InvoiceCell value={o.invoice_no} />
                      </td>
                      <td className={cn("px-2 text-xs text-muted-foreground whitespace-nowrap", cellCls)}>{o.order_type}</td>
                      <td className={cn("px-3 text-sm", cellCls)}>
                        <div className="font-mono font-medium truncate leading-tight">{o.branch_no ?? "—"}</div>
                        {o.city && <div className="mt-0.5 text-[11px] text-muted-foreground truncate">{o.city}</div>}
                      </td>
                      <td className={cn("px-3 text-right text-sm font-mono font-semibold tabular-nums whitespace-nowrap text-foreground", cellCls)}>{fmtSAR(o.invoice_value)}</td>
                      <td onClick={(e) => e.stopPropagation()} className={cn("px-3", cellCls)}>
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
                      <td className={cn("px-1 text-center", cellCls)}>
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
                <div key={o.id} className={cn("relative p-4 transition-colors active:bg-accent/40", verified && "bg-[var(--tint-row)] border-l-[3px] border-l-primary pl-[13px]")}>
                  <div className="flex items-start gap-3">
                    <div onClick={(e) => e.stopPropagation()} className="pt-1">
                      <Checkbox checked={verified} disabled={!canVerifyRow} onCheckedChange={(v) => toggleVerified(o, !!v)} aria-label="Call Center invoice verified" />
                    </div>
                    <div className="min-w-0 flex-1" onClick={() => navigate({ to: "/orders/$id", params: { id: o.id } })}>
                      <div className="flex items-start gap-2 flex-wrap">
                        <div className="flex flex-col items-start gap-1 min-w-0">
                          <CopyableOrderNo value={formatOrderNo(o.team, o.display_no)} alwaysShowIcon />
                          <TeamBadge team={o.team} />
                        </div>

                        <span className="text-xs text-muted-foreground ml-auto">{fmtOrderDateShort(o.order_date)}</span>
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
              {total === 0
                ? "No orders"
                : <>Showing <span className="font-medium text-foreground">{rangeStart}–{rangeEnd}</span> of <span className="font-medium text-foreground">{total}</span> orders</>}

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

function CopyableOrderNo({ value, alwaysShowIcon = false }: { value: string; alwaysShowIcon?: boolean }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async (e: ReactMouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Copy failed");
    }
  };
  return (
    <span className="inline-flex items-center gap-1.5 min-w-0">
      <span className="font-mono font-semibold text-[13px] tracking-tight whitespace-nowrap text-foreground">{value}</span>
      <button
        type="button"
        onClick={onCopy}
        aria-label={copied ? "Copied" : "Copy order number"}
        className={cn(
          "inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-opacity",
          alwaysShowIcon ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus:opacity-100",
          copied && "opacity-100 text-[var(--positive-alt)]",
        )}
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </span>
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
          <span className="text-base font-semibold tabular-nums truncate text-[var(--positive)]">{fmtSAR(completedSales)}</span>
        </div>
      </div>
      <div className="mt-3 pt-3 border-t border-border/60 grid grid-cols-2 gap-2">
        <div className="text-left">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Total orders</div>
          <div className="text-2xl font-bold tabular-nums leading-tight">{totalOrders}</div>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Completed</div>
          <div className="text-2xl font-bold tabular-nums leading-tight text-[var(--positive)]">{completedOrders}</div>
        </div>
      </div>
    </div>
  );
}

/** Displays one or many invoice numbers. Splits on comma/newline, shows the
 *  first inline with a "+N" chip listing the rest in a tooltip title. */
function InvoiceCell({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="text-muted-foreground font-sans">—</span>;
  const parts = String(value).split(/[,\n]+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return <span className="text-muted-foreground font-sans">—</span>;
  const [first, ...rest] = parts;
  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <span className="truncate">{first}</span>
      {rest.length > 0 && (
        <span
          className="shrink-0 inline-flex items-center rounded-full bg-primary/10 text-primary text-[10px] font-sans font-semibold px-1.5 py-0.5 leading-none"
          title={parts.join(", ")}
        >
          +{rest.length}
        </span>
      )}
    </div>
  );
}
