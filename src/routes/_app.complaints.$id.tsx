import { createFileRoute, Link, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { toast } from "sonner";
import { ArrowLeft, Check, ChevronsUpDown, ShieldAlert, Trash2 } from "lucide-react";
import { hasPerm } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import { z } from "zod";

export const Route = createFileRoute("/_app/complaints/$id")({
  head: () => ({ meta: [{ title: "Edit Complaint" }] }),
  component: () => <ComplaintForm mode="edit" />,
});

const schema = z.object({
  complaint_date: z.string().min(1),
  customer_name: z.string().trim().max(120).nullable().optional(),
  customer_phone: z.string().trim().max(40).nullable().optional(),
  branch_no: z.string().nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  status: z.enum(["In Progress", "Resolved"]),
});

export function ComplaintForm({ mode }: { mode: "create" | "edit" }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { user, role, profile } = useAuth();
  const params = useParams({ strict: false }) as { id?: string };
  const id = params?.id;

  const canCreate = hasPerm(role, profile?.permissions as any, "create_complaints");
  const canEditPerm = hasPerm(role, profile?.permissions as any, "edit_complaints");

  const { data: branches } = useQuery({
    queryKey: ["branches"],
    queryFn: async () => (await supabase.from("branches").select("branch_no,city").order("branch_no")).data ?? [],
  });

  const { data: existing } = useQuery({
    queryKey: ["complaint", id],
    enabled: mode === "edit" && !!id,
    queryFn: async () => {
      const { data, error } = await supabase.from("complaints" as any).select("*").eq("id", id!).maybeSingle();
      if (error) throw error;
      return data as any;
    },
  });

  const isOwner = existing && user && existing.agent_id === user.id;
  const canEditThis = mode === "create" ? canCreate : (canEditPerm && (role === "admin" || isOwner));

  const [form, setForm] = useState({
    complaint_date: new Date().toISOString().slice(0, 10),
    customer_name: "",
    customer_phone: "",
    branch_no: "",
    description: "",
    status: "In Progress" as "In Progress" | "Resolved",
  });
  const [busy, setBusy] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);

  useEffect(() => {
    if (existing) {
      const s = existing.status === "Resolved" ? "Resolved" : "In Progress";
      setForm({
        complaint_date: existing.complaint_date,
        customer_name: existing.customer_name ?? "",
        customer_phone: existing.customer_phone ?? "",
        branch_no: existing.branch_no ?? "",
        description: existing.description ?? existing.resolution ?? "",
        status: s,
      });
    }
  }, [existing]);

  const cityFor = useMemo(() => (b: string | null) => branches?.find((x) => x.branch_no === b)?.city ?? "", [branches]);

  if (mode === "edit" && existing && !canEditThis) {
    return <div className="text-center py-16"><ShieldAlert className="mx-auto h-10 w-10 text-destructive" /><p className="mt-2 text-sm text-muted-foreground">You can only edit your own complaints.</p></div>;
  }
  if (mode === "create" && !canCreate) {
    return <div className="text-center py-16"><ShieldAlert className="mx-auto h-10 w-10 text-destructive" /><p className="mt-2 text-sm text-muted-foreground">You don't have permission.</p></div>;
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setBusy(true);
    try {
      const parsed = schema.parse({
        ...form,
        customer_name: form.customer_name || null,
        customer_phone: form.customer_phone || null,
        branch_no: form.branch_no || null,
        description: form.description || null,
        // Force In Progress when creating; preserve current status on edit
        status: mode === "create" ? "In Progress" : form.status,
      });
      if (mode === "create") {
        const { error } = await supabase.from("complaints" as any).insert({ ...parsed, agent_id: user.id } as any);
        if (error) throw error;
        toast.success("Complaint logged");
      } else {
        const { error } = await supabase.from("complaints" as any).update(parsed as any).eq("id", id!);
        if (error) throw error;
        toast.success("Complaint updated");
      }
      qc.invalidateQueries({ queryKey: ["complaints"] });
      navigate({ to: "/complaints" });
    } catch (e: any) { toast.error(e.message ?? "Failed to save"); } finally { setBusy(false); }
  };

  const del = async () => {
    if (!id) return;
    if (!confirm("Delete this complaint?")) return;
    const { error } = await supabase.from("complaints" as any).delete().eq("id", id);
    if (error) { toast.error(error.message); return; }
    toast.success("Deleted");
    qc.invalidateQueries({ queryKey: ["complaints"] });
    navigate({ to: "/complaints" });
  };

  return (
    <div className="max-w-3xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <Link to="/complaints" className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4 mr-1" /> Back</Link>
        {mode === "edit" && role === "admin" && <Button variant="outline" size="sm" onClick={del}><Trash2 className="h-4 w-4 mr-2" />Delete</Button>}
      </div>
      <Card>
        <CardHeader><CardTitle>{mode === "create" ? "New complaint" : `Edit complaint ${existing?.display_no ?? ""}`}</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={submit} className="grid md:grid-cols-2 gap-4">
            <div className="space-y-2"><Label>Date</Label><Input type="date" value={form.complaint_date} onChange={(e) => setForm({ ...form, complaint_date: e.target.value })} required /></div>
            {mode === "edit" && (
              <div className="space-y-2">
                <Label>Status</Label>
                <div className="flex items-center gap-3 h-10 px-3 border rounded-md bg-background">
                  <Checkbox
                    id="resolved"
                    checked={form.status === "Resolved"}
                    onCheckedChange={(v) => setForm({ ...form, status: v ? "Resolved" : "In Progress" })}
                  />
                  <Label htmlFor="resolved" className="cursor-pointer text-sm">
                    {form.status === "Resolved" ? "Resolved" : "In Progress"}
                  </Label>
                </div>
              </div>
            )}
            <div className="space-y-2"><Label>Customer name <span className="text-xs text-muted-foreground">(optional)</span></Label><Input value={form.customer_name} onChange={(e) => setForm({ ...form, customer_name: e.target.value })} placeholder="Optional" /></div>
            <div className="space-y-2"><Label>Customer phone <span className="text-xs text-muted-foreground">(optional)</span></Label><Input value={form.customer_phone} onChange={(e) => setForm({ ...form, customer_phone: e.target.value })} placeholder="Optional" /></div>
            <div className="space-y-2">
              <Label>Branch No.</Label>
              <Popover open={branchOpen} onOpenChange={setBranchOpen}>
                <PopoverTrigger asChild>
                  <Button variant="outline" role="combobox" className="w-full justify-between font-normal">
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
                        {(branches ?? []).map((b: any) => (
                          <CommandItem key={b.branch_no} value={`${b.branch_no} ${b.city}`} onSelect={() => { setForm({ ...form, branch_no: b.branch_no }); setBranchOpen(false); }}>
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
            <div className="space-y-2 md:col-span-2"><Label>Notes</Label><Textarea rows={4} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Describe the complaint" /></div>
            <div className="md:col-span-2 flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => navigate({ to: "/complaints" })}>Cancel</Button>
              <Button type="submit" disabled={busy}>{busy ? "Saving…" : mode === "create" ? "Save complaint" : "Update complaint"}</Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
