import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Plus, Search, ShieldAlert } from "lucide-react";
import { COMPLAINT_STATUSES } from "@/lib/branches";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { hasPerm } from "@/lib/permissions";

export const Route = createFileRoute("/_app/complaints/")({
  head: () => ({ meta: [{ title: "Complaints" }] }),
  component: ComplaintsList,
});

function ComplaintsList() {
  const navigate = useNavigate();
  const { role, profile } = useAuth();
  const canCreate = hasPerm(role, profile?.permissions as any, "create_complaints");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<string>("all");

  const { data, isLoading } = useQuery({
    queryKey: ["complaints", status],
    queryFn: async () => {
      let qb = supabase.from("complaints" as any).select("*").order("created_at", { ascending: false }).limit(2000);
      if (status !== "all") qb = qb.eq("status", status);
      const [{ data: rows, error }, { data: profiles }] = await Promise.all([
        qb,
        supabase.from("profiles").select("id,full_name"),
      ]);
      if (error) throw error;
      const nm = new Map((profiles ?? []).map((p: any) => [p.id, p.full_name]));
      return ((rows as any[]) ?? []).map((r: any) => ({ ...r, agent_name: nm.get(r.agent_id) ?? "—" }));
    },
  });

  const filtered = useMemo(() => {
    if (!data) return [];
    const term = q.trim().toLowerCase();
    if (!term) return data;
    return data.filter((c: any) =>
      [c.display_no, c.customer_name, c.customer_phone, c.branch_no, c.agent_name, c.category, c.description]
        .filter(Boolean).some((v: string) => String(v).toLowerCase().includes(term)),
    );
  }, [data, q]);

  if (role === "telesales" && !hasPerm(role, profile?.permissions as any, "view_orders")) {
    return <div className="text-center py-16"><ShieldAlert className="mx-auto h-10 w-10 text-destructive" /><p className="mt-2 text-sm text-muted-foreground">Not available for your role.</p></div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Complaints</h1>
          <p className="text-sm text-muted-foreground">Customer complaints management</p>
        </div>
        {canCreate && <Button onClick={() => navigate({ to: "/complaints/new" })}><Plus className="h-4 w-4 mr-2" />New complaint</Button>}
      </div>

      <Card>
        <CardContent className="p-4 grid gap-3 md:grid-cols-4">
          <div className="md:col-span-2 relative">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input placeholder="Search customer/phone/branch/agent…" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Status</label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                {COMPLAINT_STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
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
                  <TableHead>#</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Branch</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Agent</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading && <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground py-8">Loading…</TableCell></TableRow>}
                {!isLoading && filtered.length === 0 && <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground py-8">No complaints</TableCell></TableRow>}
                {filtered.map((c: any) => (
                  <TableRow key={c.id} className="cursor-pointer" onClick={() => navigate({ to: "/complaints/$id", params: { id: c.id } })}>
                    <TableCell className="font-mono font-semibold">{c.display_no}</TableCell>
                    <TableCell>{c.complaint_date}</TableCell>
                    <TableCell>{c.customer_name}</TableCell>
                    <TableCell className="font-mono text-xs">{c.customer_phone}</TableCell>
                    <TableCell>{c.branch_no ?? "—"}</TableCell>
                    <TableCell>{c.category ?? "—"}</TableCell>
                    <TableCell>{c.agent_name}</TableCell>
                    <TableCell><span className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium bg-muted">{c.status}</span></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
