import { createFileRoute, Outlet, Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { LayoutDashboard, ListOrdered, Plus, Users, MapPin, LogOut, ClipboardList, ShieldAlert, MessageSquareWarning } from "lucide-react";
import { cn } from "@/lib/utils";
import { hasPerm } from "@/lib/permissions";

export const Route = createFileRoute("/_app")({
  component: AppLayout,
});

function AppLayout() {
  const { session, profile, role, loading, signOut } = useAuth();
  const navigate = useNavigate();
  const { location } = useRouterState();

  useEffect(() => {
    if (!loading && !session) navigate({ to: "/auth", replace: true });
  }, [loading, session, navigate]);

  if (loading || !session) {
    return <div className="flex min-h-screen items-center justify-center text-muted-foreground">Loading…</div>;
  }

  if (profile && !profile.active) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="max-w-md text-center space-y-4">
          <ShieldAlert className="mx-auto h-12 w-12 text-destructive" />
          <h1 className="text-xl font-semibold">Account deactivated</h1>
          <p className="text-sm text-muted-foreground">Your account is currently inactive. Please contact an administrator.</p>
          <Button variant="outline" onClick={() => signOut()}>Sign out</Button>
        </div>
      </div>
    );
  }

  const canSeeComplaints = role === "admin" || role === "customer_care" || hasPerm(role, profile?.permissions as any, "create_complaints");

  const nav = [
    { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
    { to: "/orders", label: "Orders", icon: ListOrdered },
    { to: "/orders/new", label: "New Order", icon: Plus },
    ...(canSeeComplaints ? [{ to: "/complaints", label: "Complaints", icon: MessageSquareWarning }] : []),
    ...(role === "admin"
      ? [
          { to: "/admin/users", label: "Users", icon: Users },
          { to: "/admin/branches", label: "Branches", icon: MapPin },
        ]
      : []),
  ] as const;

  return (
    <div className="min-h-screen flex bg-muted/30">
      <aside className="w-60 shrink-0 bg-card border-r border-border flex flex-col">
        <div className="px-5 py-5 border-b border-border">
          <div className="flex items-center gap-2">
            <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center">
              <ClipboardList className="h-5 w-5 text-primary" />
            </div>
            <div>
              <div className="text-sm font-semibold leading-tight">Orders Portal</div>
              <div className="text-[11px] text-muted-foreground">Sales operations</div>
            </div>
          </div>
        </div>
        <nav className="flex-1 px-2 py-3 space-y-0.5">
          {nav.map((n) => {
            const active = location.pathname === n.to || (n.to !== "/dashboard" && location.pathname.startsWith(n.to));
            const Icon = n.icon;
            return (
              <Link
                key={n.to}
                to={n.to}
                className={cn(
                  "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
                  active ? "bg-primary text-primary-foreground" : "text-foreground hover:bg-accent",
                )}
              >
                <Icon className="h-4 w-4" />
                {n.label}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-border p-3 space-y-2">
          <div className="px-2">
            <div className="text-sm font-medium truncate">{profile?.full_name ?? session.user.email}</div>
            <div className="text-[11px] text-muted-foreground capitalize">{role?.replace("_", " ") ?? "—"}</div>
          </div>
          <Button variant="outline" size="sm" className="w-full" onClick={() => signOut().then(() => navigate({ to: "/auth", replace: true }))}>
            <LogOut className="h-4 w-4 mr-2" /> Sign out
          </Button>
        </div>
      </aside>
      <main className="flex-1 min-w-0">
        <div className="p-6 md:p-8 max-w-7xl mx-auto">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
