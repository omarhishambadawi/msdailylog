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
import { CalendarIcon, CheckCircle2, ChevronLeft, ChevronRight, Download, Pencil, Plus, Search } from "lucide-react";
import { format } from "date-fns";
import type { DateRange } from "react-day-picker";
import * as XLSX from "xlsx";
import { STATUSES, STATUS_STYLES, TEAMS, CURRENCY, fmtSAR, formatOrderNo, stripOrderPrefix } from "@/lib/branches";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/orders/")({
  head: () => ({ meta: [{ title: "Orders" }] }),
  component: OrdersList,
});

const toISO = (d: Date) => format(d, "yyyy-MM-dd");
const PAGE_SIZE = 50;

function OrdersList() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { user, role } = useAuth();
  const isAdmin = role === "admin";

  const today = new Date();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  // Orders default = Today (per spec). Quick range presets still available.
  const [range, setRange] = useState<DateRange | undefined>({ from: today, to: today });
  const from = range?.from ? toISO(range.from) : toISO(today);
  const to = range?.to ? toISO(range.to) : from;

  const [q, setQ] = useState("");
  const [team, setTeam] = useState<string>("all");
  const [agent, setAgent] = useState<string>("all");
  const [status, setStatus] = useState<string>("all");
  const [mineOnly, setMineOnly] = useState<boolean>(false);
  const [dateOpen, setDateOpen] = useState(false);
  const [page, setPage] = useState(0);

  const searching = q.trim().length > 0;
  const term = q.trim();

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

  // Filter agent list according to selected team (Customer Care vs Telesales)
  const filteredAgentOpts = useMemo(() => {
    if (!agentOpts) return [];
    if (team === "all") return agentOpts;
    return agentOpts.filter((a: any) => a.role === team || a.role === "admin");
  }, [agentOpts, team]);


  const { data, isLoading } = useQuery({
    queryKey: ["orders", from, to, team, agent, status, mineOnly, user?.id, term],
    queryFn: async () => {
      let qb = supabase.from("orders").select("*");
      if (searching) {
        // Database-wide search ignores date filter so results from any page surface
        const numeric = stripOrderPrefix(term);
        const orParts = [
          `display_no.ilike.%${numeric}%`,
          `invoice_no.ilike.%${term}%`,
          `customer_name.ilike.%${term}%`,
          `customer_phone.ilike.%${term}%`,
          `branch_no.ilike.%${term}%`,
          `notes.ilike.%${term}%`,
        ];
        qb = qb.or(orParts.join(","));
      } else {
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
      return (orders ?? []).map((o: any) => ({
        ...o,
        agent_name: nm.get(o.agent_id)?.full_name ?? "—",
        agent_code: nm.get(o.agent_id)?.agent_code ?? "",
        city: bm.get(o.branch_no) ?? "",
      }));
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
      cashSales: sum(cash), cashCompletedSales: sum(completed(cash)), cashCount: cash.length,
      wasSales: sum(was), wasCompletedSales: sum(completed(was)), wasCount: was.length,
      totalSales: sum(rows), totalCompletedSales: sum(completed(rows)),
      totalCount: rows.length, completedCount: completed(rows).length,
    };
  }, [rows]);

  const dateLabel = useMemo(() => {
    if (!range?.from) return "Pick a date";
    if (!range.to || toISO(range.from) === toISO(range.to)) return format(range.from, "PP");
    return `${format(range.from, "PP")} — ${format(range.to, "PP")}`;
  }, [range]);

  const setQuick = (kind: "today" | "7d" | "30d" | "month") => {
    const t = new Date();
    if (kind === "today") { setRange({ from: t, to: t }); return; }
    if (kind === "7d") { const f = new Date(); f.setDate(f.getDate() - 6); setRange({ from: f, to: t }); return; }
    if (kind === "30d") { const f = new Date(); f.setDate(f.getDate() - 29); setRange({ from: f, to: t }); return; }
    if (kind === "month") { setRange({ from: new Date(t.getFullYear(), t.getMonth(), 1), to: new Date(t.getFullYear(), t.getMonth() + 1, 0) }); return; }
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
    qc.invalidateQueries({ queryKey: ["dashboard"] });
  };

  const exportXlsx = () => {
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
          <Button size="sm" onClick={() => navigate({ to: "/orders/new" })}><Plus className="h-4 w-4 sm:mr-2" /><span className="hidden sm:inline">New order</span></Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-3 sm:p-4 flex flex-wrap items-center gap-2 lg:gap-3">
          <div className="relative flex-1 min-w-[200px] lg:max-w-xs">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input placeholder="Search order, invoice, customer, phone…" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} className="pl-9 h-10" />
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
          <Popover open={dateOpen} onOpenChange={setDateOpen}>
            <PopoverTrigger asChild>
              <Button variant="outline" disabled={searching} className={cn("h-10 justify-start font-normal min-w-[200px]", !range?.from && "text-muted-foreground")}>
                <CalendarIcon className="mr-2 h-4 w-4 shrink-0" />
                <span className="truncate">{searching ? "Searching all orders" : dateLabel}</span>
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0 pointer-events-auto" align="start">
              <div className="flex flex-wrap gap-1 p-2 border-b">
                <Button size="sm" variant="ghost" onClick={() => setQuick("today")}>Today</Button>
                <Button size="sm" variant="ghost" onClick={() => setQuick("7d")}>Last 7 days</Button>
                <Button size="sm" variant="ghost" onClick={() => setQuick("30d")}>Last 30 days</Button>
                <Button size="sm" variant="ghost" onClick={() => setQuick("month")}>This month</Button>
              </div>
              <Calendar mode="range" selected={range} onSelect={(r) => { setRange(r); setPage(0); }} numberOfMonths={1} defaultMonth={range?.from} className="pointer-events-auto [--cell-size:2.25rem]" />
            </PopoverContent>
          </Popover>
          <Button variant="outline" size="sm" onClick={exportXlsx} className="h-10 ml-auto"><Download className="h-4 w-4 mr-2" />Export</Button>
        </CardContent>
      </Card>

      {/* Minimal grouped summary */}
      <Card>
        <CardContent className="p-3 sm:p-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <SummaryBlock label="Cash" tone="from-amber-50 to-transparent dark:from-amber-500/10">
              <SummaryLine label="Sales" value={fmtSAR(summary.cashSales)} muted />
              <SummaryLine label="Completed" value={fmtSAR(summary.cashCompletedSales)} accent />
              <SummaryFoot value={`${summary.cashCount} orders`} />
            </SummaryBlock>
            <SummaryBlock label="Wasfaty" tone="from-sky-50 to-transparent dark:from-sky-500/10">
              <SummaryLine label="Sales" value={fmtSAR(summary.wasSales)} muted />
              <SummaryLine label="Completed" value={fmtSAR(summary.wasCompletedSales)} accent />
              <SummaryFoot value={`${summary.wasCount} orders`} />
            </SummaryBlock>
            <SummaryBlock label="Total" tone="from-primary/10 to-transparent" highlight>
              <SummaryLine label="Sales" value={fmtSAR(summary.totalSales)} muted />
              <SummaryLine label="Completed" value={fmtSAR(summary.totalCompletedSales)} accent />
              <SummaryFoot value={`${summary.completedCount} / ${summary.totalCount} completed`} />
            </SummaryBlock>
            <SummaryBlock label="Completed orders" tone="from-emerald-50 to-transparent dark:from-emerald-500/10">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-xs text-muted-foreground">Count</span>
                <span className="text-2xl font-bold tabular-nums text-green-600 dark:text-green-400">{summary.completedCount}</span>
              </div>
              <SummaryLine label="Total orders" value={String(summary.totalCount)} muted />
              <SummaryFoot value={summary.totalCount > 0 ? `${((summary.completedCount / summary.totalCount) * 100).toFixed(1)}% completion rate` : "—"} />
            </SummaryBlock>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead className="w-12 text-center">CC ✓</TableHead>
                  <TableHead className="text-xs uppercase tracking-wider font-semibold">Order #</TableHead>
                  <TableHead className="hidden sm:table-cell text-xs uppercase tracking-wider font-semibold">Date</TableHead>
                  <TableHead className="hidden lg:table-cell text-xs uppercase tracking-wider font-semibold">Team</TableHead>
                  <TableHead className="hidden md:table-cell text-xs uppercase tracking-wider font-semibold">Agent</TableHead>
                  <TableHead className="text-xs uppercase tracking-wider font-semibold">Customer</TableHead>
                  <TableHead className="hidden md:table-cell text-xs uppercase tracking-wider font-semibold">Phone</TableHead>
                  <TableHead className="hidden lg:table-cell text-xs uppercase tracking-wider font-semibold">Type</TableHead>
                  <TableHead className="hidden md:table-cell text-xs uppercase tracking-wider font-semibold">Branch</TableHead>
                  <TableHead className="hidden xl:table-cell text-xs uppercase tracking-wider font-semibold">City</TableHead>
                  <TableHead className="text-xs uppercase tracking-wider font-semibold">Invoice #</TableHead>
                  <TableHead className="text-right text-xs uppercase tracking-wider font-semibold">Value</TableHead>
                  <TableHead className="text-xs uppercase tracking-wider font-semibold">Status</TableHead>
                  <TableHead className="w-10"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading && <TableRow><TableCell colSpan={14} className="text-center text-muted-foreground py-8">Loading…</TableCell></TableRow>}
                {!isLoading && pageRows.length === 0 && <TableRow><TableCell colSpan={14} className="text-center text-muted-foreground py-8">No orders found</TableCell></TableRow>}
                {pageRows.map((o: any, idx: number) => {
                  const owned = user?.id === o.agent_id;
                  const editable = owned || isAdmin;
                  const verified = !!o.call_center_verified;
                  return (
                    <TableRow key={o.id} className={cn("transition-colors", idx % 2 === 1 && "bg-muted/20", verified && "bg-green-50/60 dark:bg-green-500/5", "hover:bg-accent/40")}>
                      <TableCell className="text-center" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-center gap-1">
                          <Checkbox checked={verified} disabled={!editable} onCheckedChange={(v) => toggleVerified(o.id, !!v)} aria-label="Call Center invoice verified" />
                          {verified && <CheckCircle2 className="h-4 w-4 text-green-600" />}
                        </div>
                      </TableCell>
                      <TableCell className="font-mono font-semibold whitespace-nowrap">{formatOrderNo(o.team, o.display_no)}</TableCell>
                      <TableCell className="hidden sm:table-cell whitespace-nowrap">{o.order_date}</TableCell>
                      <TableCell className="hidden lg:table-cell"><TeamBadge team={o.team} /></TableCell>
                      <TableCell className="hidden md:table-cell whitespace-nowrap">{o.agent_name}</TableCell>
                      <TableCell className="whitespace-nowrap">{o.customer_name || "—"}</TableCell>
                      <TableCell className="hidden md:table-cell whitespace-nowrap font-mono text-xs">{o.customer_phone || "—"}</TableCell>
                      <TableCell className="hidden lg:table-cell">{o.order_type}</TableCell>
                      <TableCell className="hidden md:table-cell">{o.branch_no ?? "—"}</TableCell>
                      <TableCell className="hidden xl:table-cell">{o.city || "—"}</TableCell>
                      <TableCell className="font-mono text-xs">{o.invoice_no || "—"}</TableCell>
                      <TableCell className="text-right whitespace-nowrap">{fmtSAR(o.invoice_value)}</TableCell>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        {editable ? (
                          <Select value={o.status} onValueChange={(v) => updateStatus(o.id, v)}>
                            <SelectTrigger className={`h-8 w-[130px] border ${STATUS_STYLES[o.status] ?? ""}`}><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        ) : (
                          <StatusBadge s={o.status} />
                        )}
                      </TableCell>
                      <TableCell>
                        {editable && (
                          <Button variant="ghost" size="icon" onClick={() => navigate({ to: "/orders/$id", params: { id: o.id } })} aria-label="Edit order">
                            <Pencil className="h-4 w-4" />
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
  if (team === "telesales") {
    return <span className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium bg-chart-3/15 text-chart-3 border-chart-3/30">Telesales</span>;
  }
  return <span className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium bg-primary/15 text-primary border-primary/30">Customer Care</span>;
}

function StatusBadge({ s }: { s: string }) {
  return <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${STATUS_STYLES[s] ?? "bg-muted"}`}>{s}</span>;
}

function SummaryBlock({ label, tone, highlight, children }: { label: string; tone: string; highlight?: boolean; children: React.ReactNode }) {
  return (
    <div className={cn("relative rounded-lg border bg-gradient-to-br p-3", tone, highlight && "border-primary/30")}>
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">{label}</div>
      <div className="mt-2 space-y-1.5">{children}</div>
    </div>
  );
}
function SummaryLine({ label, value, accent, muted }: { label: string; value: string; accent?: boolean; muted?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn("text-sm sm:text-base font-semibold tabular-nums truncate", accent && "text-green-600 dark:text-green-400", muted && !accent && "text-foreground")}>{value}</span>
    </div>
  );
}
function SummaryFoot({ value }: { value: string }) {
  return <div className="text-[11px] text-muted-foreground mt-1 pt-1.5 border-t border-border/60">{value}</div>;
}
