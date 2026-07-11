import { createFileRoute, useNavigate, useParams, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { toast } from "sonner";
import { ArrowLeft, Check, ChevronsUpDown, Clock, Plus, ShieldAlert, Trash2, X } from "lucide-react";
import { ORDER_TYPES, DELIVERY_TYPES, TEAMS, CURRENCY, formatOrderNo } from "@/lib/branches";
import { cn } from "@/lib/utils";
import { z } from "zod";
import { hasPerm } from "@/lib/permissions";

const schema = z.object({
  order_date: z.string().min(1),
  team: z.enum(["customer_care", "telesales"]),
  order_type: z.string().min(1, "Order type is required"),
  customer_name: z.string().trim().max(120).optional().nullable(),
  customer_phone: z.string().trim().max(40).optional().nullable(),
  branch_no: z.string().min(1, "Branch number is required"),
  delivery_type: z.string().min(1, "Delivery / pickup method is required"),
  invoice_no: z.string().max(50).optional().nullable(),
  invoice_value: z.preprocess((v) => (v === "" || v == null ? null : Number(v)), z.number().nonnegative().nullable()),
  notes: z.string().max(500).optional().nullable(),
  status: z.string().min(1),
});

function defaultTeam(role: string | null): "customer_care" | "telesales" {
  return role === "telesales" ? "telesales" : "customer_care";
}

export const Route = createFileRoute("/_app/orders/new")({
  head: () => ({ meta: [{ title: "New Order" }] }),
  component: () => <OrderForm mode="create" />,
});

export function OrderForm({ mode }: { mode: "create" | "edit" }) {
  const navigate = useNavigate();
  const { user, role, profile } = useAuth();
  const qc = useQueryClient();
  const params = useParams({ strict: false }) as { id?: string };
  const id = params?.id;

  const { data: branches } = useQuery({
    queryKey: ["branches"],
    queryFn: async () => {
      const { data, error } = await supabase.from("branches").select("branch_no,city").order("branch_no");
      if (error) throw error;
      return data ?? [];
    },
  });

  const { data: existing } = useQuery({
    queryKey: ["order", id],
    enabled: mode === "edit" && !!id,
    queryFn: async () => {
      const { data, error } = await supabase.from("orders").select("*").eq("id", id!).maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const [form, setForm] = useState({
    order_date: new Date().toISOString().slice(0, 10),
    team: defaultTeam(role),
    order_type: "Cash",
    customer_name: "",
    customer_phone: "",
    branch_no: "" as string | null,
    delivery_type: "",
    invoice_value: "",
    notes: "",
    status: "Pending",
  });
  const [invoices, setInvoices] = useState<string[]>([""]);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const canView = hasPerm(role, profile?.permissions as any, "view_orders");
  const canCreate = hasPerm(role, profile?.permissions as any, "create_orders");
  const canEditAll = hasPerm(role, profile?.permissions as any, "edit_all_orders");
  const canEditOwn = hasPerm(role, profile?.permissions as any, "edit_orders");
  const canDelete = hasPerm(role, profile?.permissions as any, "delete_orders");
  const isOwner = !!existing && !!user && existing.agent_id === user.id;
  const canEditThis = mode === "create" ? canCreate : (canEditAll || (isOwner && canEditOwn));
  const readOnly = mode === "edit" && !canEditThis;

  useEffect(() => {
    if (existing) {
      const t = (existing.team === "customer_care" || existing.team === "telesales") ? existing.team : "customer_care";
      setForm({
        order_date: existing.order_date,
        team: t,
        order_type: existing.order_type,
        customer_name: (existing as any).customer_name ?? "",
        customer_phone: (existing as any).customer_phone ?? "",
        branch_no: existing.branch_no ?? "",
        delivery_type: existing.delivery_type ?? "",
        invoice_no: existing.invoice_no ?? "",
        invoice_value: existing.invoice_value?.toString() ?? "",
        notes: existing.notes ?? "",
        status: existing.status,
      });
    }
  }, [existing]);

  useEffect(() => {
    if (mode === "create") setForm((f) => ({ ...f, team: defaultTeam(role) }));
  }, [role, mode]);

  const cityFor = useMemo(() => (b: string | null) => branches?.find((x) => x.branch_no === b)?.city ?? "", [branches]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    if (!canEditThis) { toast.error("You don't have permission to modify this order"); return; }
    setBusy(true);
    try {
      const parsed = schema.parse({
        ...form,
        customer_name: form.customer_name || null,
        customer_phone: form.customer_phone || null,
        branch_no: form.branch_no || "",
        invoice_no: form.invoice_no || null,
        notes: form.notes || null,
        status: mode === "create" ? "Pending" : form.status,
      });
      if (mode === "create") {
        const { error } = await supabase.from("orders").insert({ ...parsed, agent_id: user.id } as any);
        if (error) throw error;
        toast.success("Order saved");
      } else {
        const { error } = await supabase.from("orders").update(parsed as any).eq("id", id!);
        if (error) throw error;
        toast.success("Order updated");
      }
      qc.invalidateQueries({ queryKey: ["orders"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      navigate({ to: "/orders" });
    } catch (e: any) {
      toast.error(e.message ?? "Failed to save");
    } finally {
      setBusy(false);
    }
  };

  const del = async () => {
    if (!id) return;
    if (!canDelete) { toast.error("You don't have permission to delete orders"); return; }
    if (!confirm("Delete this order?")) return;
    const { error } = await supabase.from("orders").delete().eq("id", id);
    if (error) { toast.error(error.message); return; }
    toast.success("Deleted");
    qc.invalidateQueries({ queryKey: ["orders"] });
    navigate({ to: "/orders" });
  };

  if (mode === "create" && !canCreate) {
    return <div className="text-center py-16"><ShieldAlert className="mx-auto h-10 w-10 text-destructive" /><p className="mt-2 text-sm text-muted-foreground">You don't have permission to create orders.</p></div>;
  }

  if (mode === "edit" && existing && !canView) {
    return <div className="text-center py-16"><ShieldAlert className="mx-auto h-10 w-10 text-destructive" /><p className="mt-2 text-sm text-muted-foreground">You don't have access to this order.</p></div>;
  }

  return (
    <div className="max-w-3xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <Link to="/orders" className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4 mr-1" /> Back to orders</Link>
        {mode === "edit" && canDelete && (
          <Button variant="outline" size="sm" onClick={del}><Trash2 className="h-4 w-4 mr-2" />Delete</Button>
        )}
      </div>
      <Card>
        <CardHeader><CardTitle>{mode === "create" ? "New order" : `${readOnly ? "View" : "Edit"} order ${formatOrderNo(existing?.team, existing?.display_no)}`}</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={submit} className="grid md:grid-cols-2 gap-4">
            <fieldset disabled={readOnly} className="contents">
            <div className="space-y-2">
              <Label>Date</Label>
              <Input type="date" value={form.order_date} onChange={(e) => setForm({ ...form, order_date: e.target.value })} required />
            </div>
            <div className="space-y-2">
              <Label>Team</Label>
              <Select value={form.team} onValueChange={(v) => setForm({ ...form, team: v as any })} disabled={readOnly || (mode === "edit" && !canEditAll)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{TEAMS.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Customer name <span className="text-xs text-muted-foreground">(optional)</span></Label>
              <Input value={form.customer_name} onChange={(e) => setForm({ ...form, customer_name: e.target.value })} placeholder="Optional" />
            </div>
            <div className="space-y-2">
              <Label>Customer phone <span className="text-xs text-muted-foreground">(optional)</span></Label>
              <Input value={form.customer_phone} onChange={(e) => setForm({ ...form, customer_phone: e.target.value })} placeholder="Optional" />
            </div>
            <div className="space-y-2">
              <Label>Order type <span className="text-destructive">*</span></Label>
              <Select value={form.order_type} onValueChange={(v) => setForm({ ...form, order_type: v })} disabled={readOnly}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{ORDER_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Delivery & Pickup <span className="text-destructive">*</span></Label>
              <Select value={form.delivery_type} onValueChange={(v) => setForm({ ...form, delivery_type: v })} disabled={readOnly}>
                <SelectTrigger><SelectValue placeholder="Select a method…" /></SelectTrigger>
                <SelectContent>{DELIVERY_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Branch No. <span className="text-destructive">*</span></Label>
              <Popover open={open} onOpenChange={setOpen}>
                <PopoverTrigger asChild>
                  <Button variant="outline" role="combobox" className="w-full justify-between font-normal" disabled={readOnly}>
                    {form.branch_no ? `${form.branch_no} — ${cityFor(form.branch_no)}` : "Select branch…"}
                    <ChevronsUpDown className="h-4 w-4 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="p-0 w-[280px]">
                  <Command>
                    <CommandInput placeholder="Search branch…" />
                    <CommandList>
                      <CommandEmpty>No branch.</CommandEmpty>
                      <CommandGroup>
                        {(branches ?? []).map((b) => (
                          <CommandItem key={b.branch_no} value={`${b.branch_no} ${b.city}`} onSelect={() => { setForm({ ...form, branch_no: b.branch_no }); setOpen(false); }}>
                            <Check className={cn("mr-2 h-4 w-4", form.branch_no === b.branch_no ? "opacity-100" : "opacity-0")} />
                            <span className="font-mono mr-2">{b.branch_no}</span>
                            <span className="text-muted-foreground text-xs">{b.city}</span>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>
            <div className="space-y-2">
              <Label>City (auto)</Label>
              <Input value={cityFor(form.branch_no) || ""} readOnly className="h-10 bg-muted/60 leading-normal py-2" placeholder="—" />
            </div>
            <div className="space-y-2">
              <Label>Order value ({CURRENCY})</Label>
              <Input type="number" step="0.01" min="0" value={form.invoice_value} onChange={(e) => setForm({ ...form, invoice_value: e.target.value })} placeholder="0.00" />
            </div>
            <div className="space-y-2">
              <Label>Invoice No.</Label>
              <Input value={form.invoice_no} onChange={(e) => setForm({ ...form, invoice_no: e.target.value })} />
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label>Notes</Label>
              <Textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>
            </fieldset>
            <div className="md:col-span-2 flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => navigate({ to: "/orders" })}>{readOnly ? "Close" : "Cancel"}</Button>
              {!readOnly && <Button type="submit" disabled={busy}>{busy ? "Saving…" : mode === "create" ? "Save order" : "Update order"}</Button>}
            </div>
          </form>
        </CardContent>
      </Card>

      {mode === "edit" && id && <OrderActivityTimeline orderId={id} />}
    </div>
  );
}

function OrderActivityTimeline({ orderId }: { orderId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["order-activity", orderId],
    queryFn: async () => {
      const [{ data: events }, { data: profiles }] = await Promise.all([
        supabase.from("order_activity" as any).select("*").eq("order_id", orderId).order("created_at", { ascending: false }),
        supabase.from("profiles").select("id,full_name"),
      ]);
      const nm = new Map((profiles ?? []).map((p: any) => [p.id, p.full_name]));
      return ((events as any[]) ?? []).map((e: any) => ({ ...e, actor_name: nm.get(e.actor_id) ?? "System" }));
    },
  });

  const fmtCairo = (iso: string) => {
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "Africa/Cairo", year: "numeric", month: "short", day: "2-digit",
        hour: "numeric", minute: "2-digit", hour12: true,
      }).format(new Date(iso));
    } catch { return iso; }
  };

  const describe = (e: any) => {
    const d = e.details ?? {};
    if (e.action === "created") return "Created the order";
    if (e.action === "status_changed") return `Changed status from ${d.from ?? "—"} to ${d.to ?? "—"}`;
    if (e.action === "verification_changed") return d.verified ? "Marked Call Center invoice verified" : "Removed Call Center invoice verification";
    if (e.action === "edited") {
      const keys = Object.keys(d);
      if (keys.length === 0) return "Edited the order";
      return `Updated ${keys.join(", ")}`;
    }
    return e.action;
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2"><Clock className="h-4 w-4" /> Activity timeline</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
        {!isLoading && (data?.length ?? 0) === 0 && <div className="text-sm text-muted-foreground">No activity yet.</div>}
        <ol className="space-y-3">
          {(data ?? []).map((e: any) => (
            <li key={e.id} className="flex gap-3 text-sm">
              <div className="mt-1.5 h-2 w-2 rounded-full bg-primary shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="font-medium">{describe(e)}</div>
                <div className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{e.actor_name}</span> · {fmtCairo(e.created_at)}
                </div>
              </div>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}
