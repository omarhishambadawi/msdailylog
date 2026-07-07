import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import logo from "@/assets/milaserv-logo.png.asset.json";
import { hasPerm } from "@/lib/permissions";

export const Route = createFileRoute("/auth")({
  head: () => ({ meta: [{ title: "Sign in — MilaServ Portal" }] }),
  validateSearch: (s: Record<string, unknown>) => ({
    next: typeof s.next === "string" && s.next.startsWith("/") && !s.next.startsWith("//") ? s.next : undefined,
  }),
  component: AuthPage,
});

function AuthPage() {
  const { session, loading, role, profile } = useAuth();
  const navigate = useNavigate();
  const { next } = Route.useSearch();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  if (!loading && session) {
    if (next) { window.location.assign(next); }
    else if (hasPerm(role, profile?.permissions, "view_dashboard")) navigate({ to: "/dashboard", replace: true });
    else if (hasPerm(role, profile?.permissions, "view_orders")) navigate({ to: "/orders", replace: true });
    else navigate({ to: "/", replace: true });
  }

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) { toast.error(error.message); return; }
    toast.success("Signed in");
    if (next) window.location.assign(next);
    else navigate({ to: "/", replace: true });
  };

  const onForgot = async () => {
    if (!email) { toast.error("Enter your email first"); return; }
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    if (error) toast.error(error.message);
    else toast.success("Password reset email sent");
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-accent to-background px-4">
      <Card className="w-full max-w-md shadow-xl border-border/60">
        <CardHeader className="text-center space-y-1 pb-4">
          <img src={logo.url} alt="MilaServ" className="mx-auto h-16 w-16 object-contain -mb-1" />
          <CardTitle className="text-2xl leading-tight">MilaServ Portal</CardTitle>
          <CardDescription className="pt-1">Sign in to access orders, complaints & call center analytics</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="agent@milaserv.com" />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="password">Password</Label>
                <button type="button" onClick={onForgot} className="text-xs text-primary hover:underline">Forgot?</button>
              </div>
              <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            <Button type="submit" className="w-full" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</Button>
          </form>
          <p className="mt-6 text-center text-xs text-muted-foreground">
            Need an account? Ask an administrator to create one.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
