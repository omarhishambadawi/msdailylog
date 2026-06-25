import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useAuth } from "@/lib/auth";
import { adminCreateUser, adminListUsers, adminSetActive, adminSetRole, adminSetPassword, adminUpdateProfile, adminDeleteUser } from "@/lib/admin.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { ShieldAlert, KeyRound, Pencil, Plus, Trash2 } from "lucide-react";
import { ALL_PERMISSIONS, defaultPermsForRole, PERMISSION_GROUPS } from "@/lib/permissions";

export const Route = createFileRoute("/_app/admin/users")({
  head: () => ({ meta: [{ title: "Users — Admin" }] }),
  component: AdminUsers,
});

function AdminUsers() {
  const { role } = useAuth();
  const qc = useQueryClient();
  const listFn = useServerFn(adminListUsers);
  const createFn = useServerFn(adminCreateUser);
  const setActiveFn = useServerFn(adminSetActive);
  const setRoleFn = useServerFn(adminSetRole);
  const setPwFn = useServerFn(adminSetPassword);
  const updFn = useServerFn(adminUpdateProfile);
  const delFn = useServerFn(adminDeleteUser);

  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-users"],
    queryFn: () => listFn(),
    enabled: role === "admin",
  });

  const [openNew, setOpenNew] = useState(false);
  const [nf, setNf] = useState({ email: "", password: "", fullName: "", agentCode: "", role: "customer_care" as "admin" | "customer_care" | "telesales" });
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<any | null>(null);
  const [pwUser, setPwUser] = useState<any | null>(null);
  const [newPw, setNewPw] = useState("");

  if (role !== "admin") {
    return <div className="text-center py-16"><ShieldAlert className="mx-auto h-10 w-10 text-destructive" /><p className="mt-2 text-sm text-muted-foreground">Admins only.</p></div>;
  }

  const reload = () => qc.invalidateQueries({ queryKey: ["admin-users"] });

  const onCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await createFn({ data: nf });
      toast.success("User created");
      setOpenNew(false);
      setNf({ email: "", password: "", fullName: "", agentCode: "", role: "customer_care" });
      reload();
    } catch (e: any) { toast.error(e.message); } finally { setBusy(false); }
  };

  const saveEdit = async () => {
    if (!editing) return;
    try {
      await updFn({ data: { userId: editing.id, fullName: editing.full_name, agentCode: editing.agent_code ?? "", permissions: editing.permissions ?? [] } });
      if (editing._roleChange) await setRoleFn({ data: { userId: editing.id, role: editing.role } });
      toast.success("Saved");
      setEditing(null);
      reload();
    } catch (e: any) { toast.error(e.message); }
  };

  const togglePerm = (key: string, on: boolean) => {
    if (!editing) return;
    const cur: string[] = editing.permissions ?? [];
    setEditing({ ...editing, permissions: on ? Array.from(new Set([...cur, key])) : cur.filter((p: string) => p !== key) });
  };

  const savePw = async () => {
    if (!pwUser) return;
    try {
      await setPwFn({ data: { userId: pwUser.id, password: newPw } });
      toast.success("Password reset");
      setPwUser(null); setNewPw("");
    } catch (e: any) { toast.error(e.message); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Users</h1>
          <p className="text-sm text-muted-foreground">Manage agents and administrators</p>
        </div>
        <Dialog open={openNew} onOpenChange={setOpenNew}>
          <DialogTrigger asChild><Button><Plus className="h-4 w-4 mr-2" />New user</Button></DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>Create user</DialogTitle></DialogHeader>
            <form onSubmit={onCreate} className="space-y-3">
              <div className="space-y-2"><Label>Full name</Label><Input required value={nf.fullName} onChange={(e) => setNf({ ...nf, fullName: e.target.value })} /></div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2"><Label>Email</Label><Input type="email" required value={nf.email} onChange={(e) => setNf({ ...nf, email: e.target.value })} /></div>
                <div className="space-y-2"><Label>Agent code</Label><Input value={nf.agentCode} onChange={(e) => setNf({ ...nf, agentCode: e.target.value })} placeholder="4002" /></div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2"><Label>Password</Label><Input type="password" minLength={8} required value={nf.password} onChange={(e) => setNf({ ...nf, password: e.target.value })} /></div>
                <div className="space-y-2">
                  <Label>Role</Label>
                  <Select value={nf.role} onValueChange={(v) => setNf({ ...nf, role: v as any })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="customer_care">Customer Care</SelectItem>
                      <SelectItem value="telesales">Telesales</SelectItem>
                      <SelectItem value="admin">Admin</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <DialogFooter><Button type="submit" disabled={busy}>{busy ? "Creating…" : "Create"}</Button></DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow><TableHead>Name</TableHead><TableHead>Email</TableHead><TableHead>Code</TableHead><TableHead>Role</TableHead><TableHead>Active</TableHead><TableHead className="text-right">Actions</TableHead></TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">Loading…</TableCell></TableRow>}
              {error && <TableRow><TableCell colSpan={6} className="text-center text-destructive py-8">{(error as Error).message}</TableCell></TableRow>}
              {(data ?? []).map((u: any) => (
                <TableRow key={u.id}>
                  <TableCell className="font-medium">{u.full_name}</TableCell>
                  <TableCell>{u.email}</TableCell>
                  <TableCell className="font-mono text-xs">{u.agent_code ?? "—"}</TableCell>
                  <TableCell><Badge variant="outline" className="capitalize">{(u.role ?? "—").replace("_", " ")}</Badge></TableCell>
                  <TableCell>
                    <Switch checked={u.active} onCheckedChange={async (v) => { try { await setActiveFn({ data: { userId: u.id, active: v } }); reload(); } catch (e: any) { toast.error(e.message); } }} />
                  </TableCell>
                  <TableCell className="text-right space-x-1">
                    <Button variant="ghost" size="sm" onClick={() => setEditing({ ...u })}><Pencil className="h-4 w-4" /></Button>
                    <Button variant="ghost" size="sm" onClick={() => setPwUser(u)}><KeyRound className="h-4 w-4" /></Button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive"><Trash2 className="h-4 w-4" /></Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete {u.full_name}?</AlertDialogTitle>
                          <AlertDialogDescription>This permanently removes the account and signs them out. Their existing orders are kept for records. This cannot be undone.</AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction onClick={async () => { try { await delFn({ data: { userId: u.id } }); toast.success("User deleted"); reload(); } catch (e: any) { toast.error(e.message); } }}>Delete</AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Edit user &amp; permissions</DialogTitle></DialogHeader>
          {editing && (
            <div className="space-y-4">
              <div className="grid sm:grid-cols-3 gap-3">
                <div className="space-y-2 sm:col-span-2"><Label>Full name</Label><Input value={editing.full_name} onChange={(e) => setEditing({ ...editing, full_name: e.target.value })} /></div>
                <div className="space-y-2"><Label>Agent code</Label><Input value={editing.agent_code ?? ""} onChange={(e) => setEditing({ ...editing, agent_code: e.target.value })} /></div>
                <div className="space-y-2 sm:col-span-3">
                  <Label>Role</Label>
                  <Select value={editing.role ?? "customer_care"} onValueChange={(v) => setEditing({ ...editing, role: v, _roleChange: true })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="customer_care">Customer Care</SelectItem>
                      <SelectItem value="telesales">Telesales</SelectItem>
                      <SelectItem value="admin">Admin</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Permissions</Label>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setEditing({ ...editing, permissions: defaultPermsForRole((editing.role ?? "customer_care")) })}>Reset to role defaults</Button>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  {PERMISSION_GROUPS.map((group) => {
                    const perms = ALL_PERMISSIONS.filter((p) => p.group === group);
                    return (
                      <div key={group} className="rounded-lg border bg-card p-3 space-y-2">
                        <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground border-b pb-1.5">{group}</div>
                        <div className="space-y-1.5">
                          {perms.map((p) => {
                            const checked = (editing.permissions ?? []).includes(p.key);
                            return (
                              <label key={p.key} className="flex items-center gap-2 text-sm cursor-pointer rounded px-1 py-0.5 hover:bg-accent/40">
                                <Checkbox checked={checked} onCheckedChange={(v) => togglePerm(p.key, !!v)} />
                                <span className="flex-1">{p.label}</span>
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <p className="text-[11px] text-muted-foreground">Empty list = uses role defaults. Admins always have all permissions.</p>
              </div>
              <DialogFooter><Button onClick={saveEdit}>Save changes</Button></DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!pwUser} onOpenChange={(o) => { if (!o) { setPwUser(null); setNewPw(""); } }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Reset password</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">Set a new password for {pwUser?.full_name}.</p>
            <Input type="password" minLength={8} placeholder="New password (min 8)" value={newPw} onChange={(e) => setNewPw(e.target.value)} />
            <DialogFooter><Button onClick={savePw} disabled={newPw.length < 8}>Update password</Button></DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
