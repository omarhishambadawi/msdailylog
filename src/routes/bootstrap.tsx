import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useServerFn } from "@tanstack/react-start";
import { adminBootstrapFirstAdmin } from "@/lib/admin.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";

export const Route = createFileRoute("/bootstrap")({
  head: () => ({ meta: [{ title: "First-time setup" }] }),
  component: BootstrapPage,
});

function BootstrapPage() {
  const navigate = useNavigate();
  const bootstrap = useServerFn(adminBootstrapFirstAdmin);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const { data: existing } = await supabase.auth.signInWithPassword({ email, password });
      if (!existing.session) {
        const { error: suErr } = await supabase.auth.signUp({
          email,
          password,
          options: { data: { full_name: name, role: "admin" } },
        });
        if (suErr) throw suErr;
        const { error: siErr } = await supabase.auth.signInWithPassword({ email, password });
        if (siErr) throw siErr;
      }
      await bootstrap();
      toast.success("Admin account ready");
      navigate({ to: "/dashboard", replace: true });
    } catch (e: any) {
      toast.error(e.message ?? "Failed to bootstrap");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>First-time setup</CardTitle>
          <CardDescription>Create the first administrator account. Only works once.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-2"><Label htmlFor="n">Full name</Label><Input id="n" required value={name} onChange={(e) => setName(e.target.value)} /></div>
            <div className="space-y-2"><Label htmlFor="e">Email</Label><Input id="e" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></div>
            <div className="space-y-2"><Label htmlFor="p">Password</Label><Input id="p" type="password" minLength={8} required value={password} onChange={(e) => setPassword(e.target.value)} /></div>
            <Button type="submit" className="w-full" disabled={busy}>{busy ? "Setting up…" : "Create admin & sign in"}</Button>
            <p className="text-center text-xs text-muted-foreground">Already set up? <Link to="/auth" className="text-primary hover:underline">Sign in</Link></p>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
