import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Plus, Search, ShieldAlert, Pencil, Download } from "lucide-react";
import { COMPLAINT_STATUSES, STATUS_STYLES } from "@/lib/branches";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { hasPerm } from "@/lib/permissions";
import { toast } from "sonner";
import * as XLSX from "xlsx";

export const Route = createFileRoute("/_app/complaints/")({
  head: () => ({ meta: [{ title: "Complaints" }] }),
  component: ComplaintsList,
});

function ComplaintsList() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { role, profile, user } = useAuth();
  const canCreate = hasPerm(role, profile?.permissions as any, "create_complaints");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<string>("all");
  const [mineOnly, setMineOnly] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["complaints", status, mineOnly, user?.id],
    queryFn: async () => {
      let qb = supabase.from("complaints" as any).select("*").order("created_at", { ascending: false }).limit(2000);
      if (status !== "all") qb = qb.eq("status", status);
      if (mineOnly && user?.id) qb = qb.eq("agent_id", user.id);
      const [{ data: rows, error }, { data: profiles }, { data: branches }] = await Promise.all([
        qb,
        supabase.from("profiles").select("id,full_name"),
        supabase.from("branches").select("branch_no,city"),
      ]);
      if (error) throw error;
      const nm = new Map((profiles ?? []).map((p: any) => [p.id, p.full_name]));
      const bm = new Map((branches ?? []).map((b: any) => [b.branch_no, b.city]));
      return ((rows as any[]) ?? []).map((r: any) => ({ ...r, agent_name: nm.get(r.agent_id) ?? "—", city: bm.get(r.branch_no) ?? "" }));
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

  const toggleStatus = async (id: string, resolved: boolean) => {
    const { error } = await supabase.from("complaints" as any).update({ status: resolved ? "Resolved" : "In Progress" } as any).eq("id", id);
    if (error) { toast.error(error.message); return; }
    qc.invalidateQueries({ queryKey: ["complaints"] });
  };

  if (role === "telesales" && !hasPerm(role, profile?.permissions as any, "create_complaints")) {
    return <div className="text-center py-16"><ShieldAlert className="mx-auto h-10 w-10 text-destructive" /><p className="mt-2 text-sm text-muted-foreground">Not available for your role.</p></div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Complaints</h1>
          <p className="text-sm text-muted-foreground">{filtered.length} complaint{filtered.length !== 1 ? "s" : ""}</p>
        </div>
        <div className="flex gap-2 items-center">
          <Button variant={mineOnly ? "default" : "outline"} size="sm" onClick={() => setMineOnly((v) => !v)}>{mineOnly ? "Mine" : "All"}</Button>
          <Button variant="outline" size="sm" onClick={() => exportComplaints(filtered)}><Download className="h-4 w-4 mr-2" />Export</Button>
          {canCreate && <Button onClick={() => navigate({ to: "/complaints/new" })}><Plus className="h-4 w-4 mr-2" />New complaint</Button>}
        </div>
      </div>

      <Card>
        <CardContent className="p-3 sm:p-4 grid gap-3 sm:grid-cols-3">
          <div className="sm:col-span-2 relative">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input placeholder="Search customer/phone/branch/agent…" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9 h-10" />
          </div>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="h-10"><SelectValue placeholder="Status" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {COMPLAINT_STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">✓</TableHead>
                  <TableHead>#</TableHead>
                  <TableHead className="hidden sm:table-cell">Date</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead className="hidden md:table-cell">Phone</TableHead>
                  <TableHead>Branch · City</TableHead>
                  <TableHead className="hidden lg:table-cell">Agent</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-10"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading && <TableRow><TableCell colSpan={9} className="text-center text-muted-foreground py-8">Loading…</TableCell></TableRow>}
                {!isLoading && filtered.length === 0 && <TableRow><TableCell colSpan={9} className="text-center text-muted-foreground py-8">No complaints</TableCell></TableRow>}
                {filtered.map((c: any) => {
                  const owned = c.agent_id === user?.id;
                  const canEditRow = role === "admin" || owned;
                  const resolved = c.status === "Resolved";
                  return (
                    <TableRow key={c.id} className={resolved ? "bg-green-50/40 dark:bg-green-500/5" : ""}>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <Checkbox checked={resolved} disabled={!canEditRow} onCheckedChange={(v) => toggleStatus(c.id, !!v)} aria-label="Resolved" />
                      </TableCell>
                      <TableCell className="font-mono font-semibold">{c.display_no}</TableCell>
                      <TableCell className="hidden sm:table-cell whitespace-nowrap">{c.complaint_date}</TableCell>
                      <TableCell className="whitespace-nowrap">{c.customer_name || "—"}</TableCell>
                      <TableCell className="hidden md:table-cell font-mono text-xs">{c.customer_phone || "—"}</TableCell>
                      <TableCell className="whitespace-nowrap">{c.branch_no ? `${c.branch_no} — ${c.city || "—"}` : "—"}</TableCell>
                      <TableCell className="hidden lg:table-cell whitespace-nowrap">{c.agent_name}</TableCell>
                      <TableCell>
                        <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[c.status] ?? "bg-muted"}`}>{c.status}</span>
                      </TableCell>
                      <TableCell>
                        {canEditRow && (
                          <Button variant="ghost" size="icon" onClick={() => navigate({ to: "/complaints/$id", params: { id: c.id } })} aria-label="Edit">
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
        </CardContent>
      </Card>
    </div>
  );
}
