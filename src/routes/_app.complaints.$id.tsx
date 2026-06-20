import { createFileRoute, Link, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { ArrowLeft, ShieldAlert, Trash2 } from "lucide-react";
import { COMPLAINT_STATUSES } from "@/lib/branches";
import { hasPerm } from "@/lib/permissions";
import { z } from "zod";

export const Route = createFileRoute("/_app/complaints/$id")({
  head: () => ({ meta: [{ title: "Edit Complaint" }] }),
  component: () => <ComplaintForm mode="edit" />,
});

const schema = z.object({
  complaint_date: z.string().min(1),
  customer_name: z.string().trim().min(1).max(120),
  customer_phone: z.string().trim().min(5).max(40),
  branch_no: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  description: z.string().min(1).max(2000),
  resolution: z.string().max(2000).nullable().optional(),
  status: z.string().min(1),
});

export function ComplaintForm({ mode }: { mode: "create" | "edit" }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { user, role, profile } = useAuth();
  const params = useParams({ strict: false }) as { id?: string };
  const id = params?.id;

  const canCreate = hasPerm(role, profile?.permissions as any, "create_complaints");
  const canEdit = hasPerm(role, profile?.permissions as any, "edit_complaints");
  if ((mode === "create" && !canCreate) || (mode === "edit" && !canEdit)) {
    return <div className="text-center py-16"><ShieldAlert className="mx-auto h-10 w-10 text-destructive" /><p className="mt-2 text-sm text-muted-foreground">You don't have permission.</p></div>;
  }

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

  const [form, setForm] = useState({
    complaint_date: new Date().toISOString().slice(0, 10),
    customer_name: "",
    customer_phone: "",
    branch_no: "",
    category: "",
    description: "",
    resolution: "",
    status: "Open",
  });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (existing) {
      setForm({
        complaint_date: existing.complaint_date,
        customer_name: existing.customer_name ?? "",
        customer_phone: existing.customer_phone ?? "",
        branch_no: existing.branch_no ?? "",
        category: existing.category ?? "",
        description: existing.description ?? "",
        resolution: existing.resolution ?? "",
        status: existing.status,
      });
    }
  }, [existing]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setBusy(true);
    try {
      const parsed = schema.parse({
        ...form,
        branch_no: form.branch_no || null,
        category: form.category || null,
        resolution: form.resolution || null,
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
            <div className="space-y-2">
              <Label>Status</Label>
              <Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{COMPLAINT_STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-2"><Label>Customer name *</Label><Input required value={form.customer_name} onChange={(e) => setForm({ ...form, customer_name: e.target.value })} /></div>
            <div className="space-y-2"><Label>Customer phone *</Label><Input required value={form.customer_phone} onChange={(e) => setForm({ ...form, customer_phone: e.target.value })} /></div>
            <div className="space-y-2">
              <Label>Branch No.</Label>
              <Select value={form.branch_no || "none"} onValueChange={(v) => setForm({ ...form, branch_no: v === "none" ? "" : v })}>
                <SelectTrigger><SelectValue placeholder="Select branch" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">—</SelectItem>
                  {(branches ?? []).map((b: any) => <SelectItem key={b.branch_no} value={b.branch_no}>{b.branch_no} · {b.city}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2"><Label>Category</Label><Input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="Delivery, Quality, Service…" /></div>
            <div className="space-y-2 md:col-span-2"><Label>Description *</Label><Textarea rows={3} required value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
            <div className="space-y-2 md:col-span-2"><Label>Resolution</Label><Textarea rows={2} value={form.resolution} onChange={(e) => setForm({ ...form, resolution: e.target.value })} /></div>
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
