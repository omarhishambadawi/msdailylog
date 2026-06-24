import { createFileRoute, Outlet, Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import {
  LayoutDashboard, ListOrdered, Plus, Users, MapPin, LogOut,
  ShieldAlert, MessageSquareWarning, Menu, X,
} from "lucide-react";
import logo from "@/assets/milaserv-logo.png.asset.json";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app")({
  component: AppLayout,
});

function AppLayout() {
  const { session, profile, role, loading, signOut } = useAuth();
  const navigate = useNavigate();
  const { location } = useRouterState();

  const [collapsed, setCollapsed] = useState(false); // desktop collapse
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    if (!loading && !session) navigate({ to: "/auth", replace: true });
  }, [loading, session, navigate]);

  // Close mobile drawer on route change
  useEffect(() => { setMobileOpen(false); }, [location.pathname]);

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

  const nav = [
    { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
    { to: "/orders", label: "Orders", icon: ListOrdered },
    { to: "/orders/new", label: "New Order", icon: Plus },
    { to: "/complaints", label: "Complaints", icon: MessageSquareWarning },
    ...(role === "admin"
      ? [
          { to: "/admin/users", label: "Users", icon: Users },
          { to: "/admin/branches", label: "Branches", icon: MapPin },
        ]
      : []),
  ] as const;

  const sidebarWidth = collapsed ? "w-16" : "w-60";

  const SidebarContent = (
    <>
      <div className={cn("px-4 py-4 border-b border-border flex items-center gap-2", collapsed && "justify-center px-2")}>
        <img src={logo.url} alt="MilaServ" className="h-9 w-9 shrink-0 object-contain" />
        {!collapsed && (
          <div className="min-w-0">
            <div className="text-sm font-semibold leading-tight truncate">MilaServ</div>
            <div className="text-[11px] text-muted-foreground">Daily Log</div>
          </div>
        )}
      </div>
      <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
        {nav.map((n) => {
          const path = location.pathname;
          const candidates = nav.filter((m) => path === m.to || path.startsWith(m.to + "/"));
          const best = candidates.sort((a, b) => b.to.length - a.to.length)[0];
          const active = best?.to === n.to;
          const Icon = n.icon;
          return (
            <Link
              key={n.to}
              to={n.to}
              title={collapsed ? n.label : undefined}
              className={cn(
                "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
                collapsed && "justify-center px-2",
                active ? "bg-primary text-primary-foreground shadow-sm" : "text-foreground hover:bg-accent",
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {!collapsed && <span className="truncate">{n.label}</span>}
            </Link>
          );
        })}
      </nav>
      <div className="border-t border-border p-3 space-y-2">
        {!collapsed && (
          <div className="px-2">
            <div className="text-sm font-medium truncate">{profile?.full_name ?? session.user.email}</div>
            <div className="text-[11px] text-muted-foreground capitalize">{role?.replace("_", " ") ?? "—"}</div>
          </div>
        )}
        <Button
          variant="outline"
          size="sm"
          className={cn("w-full", collapsed && "px-0")}
          onClick={() => signOut().then(() => navigate({ to: "/auth", replace: true }))}
          title={collapsed ? "Sign out" : undefined}
        >
          <LogOut className="h-4 w-4" />
          {!collapsed && <span className="ml-2">Sign out</span>}
        </Button>
      </div>
    </>
  );

  return (
    <div className="min-h-screen flex bg-muted/30">
      {/* Desktop sidebar */}
      <aside className={cn("hidden md:flex shrink-0 bg-card border-r border-border flex-col transition-[width] duration-200", sidebarWidth)}>
        {SidebarContent}
      </aside>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-64 bg-card border-r border-border flex flex-col shadow-xl">
            <div className="flex justify-end p-2">
              <Button variant="ghost" size="icon" onClick={() => setMobileOpen(false)}><X className="h-4 w-4" /></Button>
            </div>
            {SidebarContent}
          </aside>
        </div>
      )}

      <main className="flex-1 min-w-0">
        {/* Top bar with toggles */}
        <div className="sticky top-0 z-30 bg-card/80 backdrop-blur border-b border-border h-12 flex items-center px-3 gap-2">
          <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setMobileOpen(true)} aria-label="Open menu">
            <Menu className="h-5 w-5" />
          </Button>
          <Button variant="ghost" size="icon" className="hidden md:inline-flex" onClick={() => setCollapsed((v) => !v)} aria-label="Toggle sidebar">
            <Menu className="h-5 w-5" />
          </Button>
          <div className="text-sm font-medium text-muted-foreground truncate">MilaServ · Daily Log</div>
        </div>
        <div className="p-4 md:p-6 lg:p-8 max-w-7xl mx-auto">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
