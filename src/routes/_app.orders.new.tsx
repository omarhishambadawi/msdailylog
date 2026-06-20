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
import { ArrowLeft, Check, ChevronsUpDown, Trash2 } from "lucide-react";
import { ORDER_TYPES, DELIVERY_TYPES, STATUSES, TEAMS } from "@/lib/branches";
import { cn } from "@/lib/utils";
import { z } from "zod";

const schema = z.object({
  order_date: z.string().min(1),
  team: z.enum(["customer_care", "telesales"]),
  order_type: z.string().min(1),
  branch_no: z.string().nullable().optional(),
  delivery_type: z.string().nullable().optional(),
  order_no: z.string().max(50).optional().nullable(),
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
  const { user, role } = useAuth();
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
    branch_no: "" as string | null,
    delivery_type: "Store Pickup",
    order_no: "",
    invoice_no: "",
    invoice_value: "",
    notes: "",
    status: "Pending",
  });
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (existing) {
      setForm({
        order_date: existing.order_date,
        team: existing.team === "admin" ? "customer_care" : existing.team,
        order_type: existing.order_type,
        branch_no: existing.branch_no ?? "",
        delivery_type: existing.delivery_type ?? "",
        order_no: existing.order_no ?? "",
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
    setBusy(true);
    try {
      const parsed = schema.parse({
        ...form,
        branch_no: form.branch_no || null,
        delivery_type: form.delivery_type || null,
        order_no: form.order_no || null,
        invoice_no: form.invoice_no || null,
        notes: form.notes || null,
      });
      if (mode === "create") {
        const { error } = await supabase.from("orders").insert({ ...parsed, agent_id: user.id });
        if (error) throw error;
        toast.success("Order saved");
      } else {
        const { error } = await supabase.from("orders").update(parsed).eq("id", id!);
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
    if (!confirm("Delete this order?")) return;
    const { error } = await supabase.from("orders").delete().eq("id", id);
    if (error) { toast.error(error.message); return; }
    toast.success("Deleted");
    qc.invalidateQueries({ queryKey: ["orders"] });
    navigate({ to: "/orders" });
  };

  return (
    <div className="max-w-3xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <Link to="/orders" className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4 mr-1" /> Back to orders</Link>
        {mode === "edit" && role === "admin" && (
          <Button variant="outline" size="sm" onClick={del}><Trash2 className="h-4 w-4 mr-2" />Delete</Button>
        )}
      </div>
      <Card>
        <CardHeader><CardTitle>{mode === "create" ? "New order" : "Edit order"}</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={submit} className="grid md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Date</Label>
              <Input type="date" value={form.order_date} onChange={(e) => setForm({ ...form, order_date: e.target.value })} required />
            </div>
            <div className="space-y-2">
              <Label>Team</Label>
              <Select value={form.team} onValueChange={(v) => setForm({ ...form, team: v as any })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{TEAMS.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Order type</Label>
              <Select value={form.order_type} onValueChange={(v) => setForm({ ...form, order_type: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{ORDER_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Status</Label>
              <Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{STATUSES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Branch No.</Label>
              <Popover open={open} onOpenChange={setOpen}>
                <PopoverTrigger asChild>
                  <Button variant="outline" role="combobox" className="w-full justify-between font-normal">
                    {form.branch_no || "Select branch…"}
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
              <Input value={cityFor(form.branch_no)} readOnly className="bg-muted" placeholder="—" />
            </div>
            <div className="space-y-2">
              <Label>Delivery & Pickup</Label>
              <Select value={form.delivery_type} onValueChange={(v) => setForm({ ...form, delivery_type: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{DELIVERY_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Invoice value</Label>
              <Input type="number" step="0.01" min="0" value={form.invoice_value} onChange={(e) => setForm({ ...form, invoice_value: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>Order No.</Label>
              <Input value={form.order_no} onChange={(e) => setForm({ ...form, order_no: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>Invoice No.</Label>
              <Input value={form.invoice_no} onChange={(e) => setForm({ ...form, invoice_no: e.target.value })} />
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label>Notes / Customer No.</Label>
              <Textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>
            <div className="md:col-span-2 flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => navigate({ to: "/orders" })}>Cancel</Button>
              <Button type="submit" disabled={busy}>{busy ? "Saving…" : mode === "create" ? "Save order" : "Update order"}</Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
