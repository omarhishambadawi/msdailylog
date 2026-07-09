import { createFileRoute, Outlet, Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useAuth, isAdministrator } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import {
  LayoutDashboard, ListOrdered, Plus, Users, MapPin, LogOut,
  ShieldAlert, MessageSquareWarning, Menu, X, PhoneCall, Headphones,
  UserCircle2, ChevronsLeft, ChevronsRight,
} from "lucide-react";
import logo from "@/assets/milaserv-logo.png.asset.json";
import { cn } from "@/lib/utils";
import { NotificationBell } from "@/components/notification-bell";
import { hasPerm } from "@/lib/permissions";

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

  const canDashboard = hasPerm(role, profile?.permissions as any, "view_dashboard");
  const canOrders = hasPerm(role, profile?.permissions as any, "view_orders");
  const canCreate = hasPerm(role, profile?.permissions as any, "create_orders");
  const canComplaints = hasPerm(role, profile?.permissions as any, "view_complaints");
  const canUsers = hasPerm(role, profile?.permissions as any, "manage_users");
  const canAdminBranches = hasPerm(role, profile?.permissions as any, "admin_access");
  const canCallCenter = hasPerm(role, profile?.permissions as any, "view_call_center") || hasPerm(role, profile?.permissions as any, "view_team_analytics");

  const nav = useMemo(() => ([
    ...(canDashboard ? [{ to: "/dashboard", label: "Dashboard", icon: LayoutDashboard }] : []),
    ...(canOrders ? [{ to: "/orders", label: "Orders", icon: ListOrdered }] : []),
    ...(canCreate ? [{ to: "/orders/new", label: "New Order", icon: Plus }] : []),
    ...(canComplaints ? [{ to: "/complaints", label: "Complaints", icon: MessageSquareWarning }] : []),
    ...(canCallCenter ? [{ to: "/call-center", label: "Call Center", icon: Headphones }] : []),
    ...(canUsers ? [{ to: "/admin/users", label: "Users", icon: Users }] : []),
    ...(canAdminBranches ? [{ to: "/admin/branches", label: "Branches", icon: MapPin }] : []),
    ...(isAdministrator(role) ? [{ to: "/admin/yeastar", label: "Yeastar", icon: PhoneCall }] : []),
  ]), [canDashboard, canOrders, canCreate, canComplaints, canCallCenter, canUsers, canAdminBranches, role]);

  // Mobile bottom-nav quick items — the 4 most-used entries the user can access
  const mobileNav = useMemo(() => nav.slice(0, 4), [nav]);

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

  const activePath = (() => {
    const path = location.pathname;
    const cands = nav.filter((m) => path === m.to || path.startsWith(m.to + "/"));
    return cands.sort((a, b) => b.to.length - a.to.length)[0]?.to ?? "";
  })();

  const sidebarWidth = collapsed ? "w-[68px]" : "w-64";

  const initials = (profile?.full_name ?? session.user.email ?? "?")
    .split(/\s+/).map((s) => s[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();

  const SidebarContent = (
    <>
      {/* Brand header — subtle gradient tied to brand tokens */}
      <div className={cn(
        "relative overflow-hidden px-4 py-4 border-b border-border flex items-center gap-3",
        "bg-gradient-to-br from-primary/8 via-transparent to-secondary/10",
        collapsed && "justify-center px-2",
      )}>
        <img src={logo.url} alt="MilaServ" className={cn("shrink-0 object-contain drop-shadow-sm", collapsed ? "h-10 w-10" : "h-11 w-11")} />
        {!collapsed && (
          <div className="min-w-0">
            <div className="text-base font-bold leading-tight tracking-tight truncate text-foreground">MilaServ</div>
            <div className="text-[11px] text-muted-foreground font-medium tracking-wide uppercase">Portal</div>
          </div>
        )}
      </div>

      <nav className="flex-1 px-2 py-3 space-y-1 overflow-y-auto">
        {nav.map((n) => {
          const active = activePath === n.to;
          const Icon = n.icon;
          return (
            <Link
              key={n.to}
              to={n.to}
              title={collapsed ? n.label : undefined}
              className={cn(
                "group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-200",
                collapsed && "justify-center px-2",
                active
                  ? "bg-primary text-primary-foreground shadow-sm shadow-primary/20"
                  : "text-foreground/80 hover:bg-accent hover:text-foreground hover:translate-x-0.5",
              )}
            >
              {/* Active accent stripe */}
              <span
                className={cn(
                  "absolute left-0 top-1/2 -translate-y-1/2 h-6 w-0.5 rounded-r-full bg-primary transition-opacity",
                  active ? "opacity-0" : "opacity-0 group-hover:opacity-40",
                )}
              />
              <Icon className={cn("h-4 w-4 shrink-0 transition-transform", active ? "" : "group-hover:scale-110")} />
              {!collapsed && <span className="truncate">{n.label}</span>}
            </Link>
          );
        })}
      </nav>

      {/* Profile card */}
      <div className="border-t border-border p-2.5 space-y-2">
        <Link
          to="/profile"
          title={collapsed ? "Profile" : undefined}
          className={cn(
            "flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-accent",
            collapsed && "justify-center px-1",
          )}
        >
          <div className={cn(
            "shrink-0 grid place-items-center rounded-full bg-gradient-to-br from-primary to-secondary text-primary-foreground font-semibold shadow-sm",
            collapsed ? "h-9 w-9 text-xs" : "h-9 w-9 text-sm",
          )}>
            {initials || <UserCircle2 className="h-5 w-5" />}
          </div>
          {!collapsed && (
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium truncate">{profile?.full_name ?? session.user.email}</div>
              <div className="text-[11px] text-muted-foreground capitalize truncate">{role?.replace("_", " ") ?? "—"}</div>
            </div>
          )}
        </Link>
        <Button
          variant="outline"
          size="sm"
          className={cn("w-full justify-center", collapsed && "px-0")}
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
      <aside className={cn(
        "hidden md:flex shrink-0 sticky top-0 h-screen bg-card border-r border-border flex-col transition-[width] duration-300 ease-out z-20",
        sidebarWidth,
      )}>
        {SidebarContent}
      </aside>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="absolute inset-0 bg-black/50 animate-in fade-in duration-200" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 bg-card border-r border-border flex flex-col shadow-2xl animate-in slide-in-from-left duration-200">
            <div className="flex justify-end p-2">
              <Button variant="ghost" size="icon" onClick={() => setMobileOpen(false)}><X className="h-4 w-4" /></Button>
            </div>
            {SidebarContent}
          </aside>
        </div>
      )}

      <main className="flex-1 min-w-0 flex flex-col">
        {/* Top bar */}
        <div className="sticky top-0 z-30 bg-card/80 backdrop-blur-md border-b border-border h-12 flex items-center px-3 gap-2">
          <Button variant="ghost" size="icon" className="md:hidden h-9 w-9" onClick={() => setMobileOpen(true)} aria-label="Open menu">
            <Menu className="h-5 w-5" />
          </Button>
          <Button variant="ghost" size="icon" className="hidden md:inline-flex h-9 w-9" onClick={() => setCollapsed((v) => !v)} aria-label="Toggle sidebar">
            {collapsed ? <ChevronsRight className="h-5 w-5" /> : <ChevronsLeft className="h-5 w-5" />}
          </Button>
          <div className="text-sm font-medium truncate flex-1 text-foreground/80">MilaServ Portal</div>
          <NotificationBell />
        </div>
        {/* Route content — fade-in per navigation */}
        <div
          key={location.pathname}
          className="p-3 sm:p-4 lg:p-6 xl:px-8 w-full pb-24 md:pb-6 animate-in fade-in slide-in-from-bottom-1 duration-300"
        >
          <Outlet />
        </div>
      </main>

      {/* Mobile bottom nav */}
      <nav
        className="md:hidden fixed bottom-0 inset-x-0 z-30 bg-card/95 backdrop-blur border-t border-border shadow-[0_-4px_16px_-8px_rgba(0,0,0,0.15)]"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <ul className="grid grid-cols-5">
          {mobileNav.map((n) => {
            const active = activePath === n.to;
            const Icon = n.icon;
            return (
              <li key={n.to}>
                <Link
                  to={n.to}
                  className={cn(
                    "flex flex-col items-center justify-center gap-0.5 py-2 text-[10px] font-medium transition-colors",
                    active ? "text-primary" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Icon className={cn("h-5 w-5 transition-transform", active && "scale-110")} />
                  <span className="truncate max-w-[64px]">{n.label}</span>
                </Link>
              </li>
            );
          })}
          <li>
            <Link
              to="/profile"
              className={cn(
                "flex flex-col items-center justify-center gap-0.5 py-2 text-[10px] font-medium transition-colors",
                activePath === "/profile" || location.pathname.startsWith("/profile") ? "text-primary" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <UserCircle2 className="h-5 w-5" />
              <span>Profile</span>
            </Link>
          </li>
        </ul>
      </nav>
    </div>
  );
}
