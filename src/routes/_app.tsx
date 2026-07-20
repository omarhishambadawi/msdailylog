import { createFileRoute, Outlet, Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useAuth, isAdministrator } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import {
  LayoutDashboard, ListOrdered, Plus, Users, MapPin, LogOut,
  ShieldAlert, MessageSquareWarning, Menu, X, PhoneCall, Headphones,
  UserCircle2,
} from "lucide-react";
import { useLogo } from "@/lib/use-logo";
import { cn } from "@/lib/utils";
import { NotificationBell } from "@/components/notification-bell";
import { hasPerm } from "@/lib/permissions";
import { UserAvatar } from "@/components/user-avatar";
import { ThemeToggle } from "@/components/theme-toggle";

export const Route = createFileRoute("/_app")({
  component: AppLayout,
});

const SIDEBAR_PREF_KEY = "milaserv.sidebar.expanded";

function AppLayout() {
  const { session, profile, role, loading, signOut } = useAuth();
  const navigate = useNavigate();
  const { location } = useRouterState();

  // Compact-by-default: sidebar starts collapsed (icons + label under icon).
  // Preference persisted to localStorage and hydrated after mount to avoid SSR mismatch.
  const logoUrl = useLogo();
  // Compact-by-default: sidebar starts collapsed (icons + label under icon).
  const [expanded, setExpanded] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    try {
      const v = localStorage.getItem(SIDEBAR_PREF_KEY);
      if (v === "1") setExpanded(true);
    } catch {}
  }, []);

  useEffect(() => {
    try { localStorage.setItem(SIDEBAR_PREF_KEY, expanded ? "1" : "0"); } catch {}
  }, [expanded]);

  useEffect(() => {
    if (!loading && !session) navigate({ to: "/auth", replace: true });
  }, [loading, session, navigate]);

  useEffect(() => { setMobileOpen(false); }, [location.pathname]);

  const canDashboard = hasPerm(role, profile?.permissions as any, "view_dashboard");
  const canOrders = hasPerm(role, profile?.permissions as any, "view_orders");
  const canCreate = hasPerm(role, profile?.permissions as any, "create_orders");
  const canComplaints = hasPerm(role, profile?.permissions as any, "view_complaints");
  const canUsers = hasPerm(role, profile?.permissions as any, "manage_users");
  const canBranches = hasPerm(role, profile?.permissions as any, "view_branches") || hasPerm(role, profile?.permissions as any, "admin_access");
  const canCallCenter = hasPerm(role, profile?.permissions as any, "view_call_center") || hasPerm(role, profile?.permissions as any, "view_team_analytics");

  const nav = useMemo(() => ([
    ...(canDashboard ? [{ to: "/dashboard", label: "Dashboard", icon: LayoutDashboard }] : []),
    ...(canOrders ? [{ to: "/orders", label: "Orders", icon: ListOrdered }] : []),
    ...(canCreate ? [{ to: "/orders/new", label: "New", icon: Plus }] : []),
    ...(canComplaints ? [{ to: "/complaints", label: "Complaints", icon: MessageSquareWarning }] : []),
    ...(canCallCenter ? [{ to: "/call-center", label: "Calls", icon: Headphones }] : []),
    ...(canUsers ? [{ to: "/admin/users", label: "Users", icon: Users }] : []),
    ...(canBranches ? [{ to: "/admin/branches", label: "Branches", icon: MapPin }] : []),
    ...(isAdministrator(role) ? [{ to: "/admin/yeastar", label: "Yeastar", icon: PhoneCall }] : []),
  ]), [canDashboard, canOrders, canCreate, canComplaints, canCallCenter, canUsers, canBranches, role]);

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

  const sidebarWidth = expanded ? "w-56" : "w-20";

  const SidebarContent = (
    <>
      {/* Logo — inline, no plate/container */}
      <div className={cn(
        "px-3 py-4 border-b border-border flex items-center gap-3",
        !expanded && "justify-center px-2",
      )}>
        <div className="h-10 w-10 flex items-center justify-center shrink-0">
          <img src={logoUrl} alt="MilaServ" className="max-h-full max-w-full object-contain" />
        </div>


        {expanded && (
          <div className="min-w-0">
            <div className="text-sm font-bold leading-tight tracking-tight truncate text-foreground">MilaServ</div>
            <div className="text-[10px] text-muted-foreground font-medium tracking-wider uppercase">Portal</div>
          </div>
        )}
      </div>

      <nav className="flex-1 px-2 py-2 space-y-0.5 overflow-y-auto">
        {nav.map((n) => {
          const active = activePath === n.to;
          const Icon = n.icon;
          return (
            <Link
              key={n.to}
              to={n.to}
              title={!expanded ? n.label : undefined}
              className={cn(
                "group relative flex rounded-lg font-medium transition-all duration-150",
                expanded
                  ? "items-center gap-3 px-3 py-2 text-sm"
                  : "flex-col items-center justify-center gap-0.5 px-1 py-2 text-[10px]",
                active
                  ? "bg-primary text-primary-foreground shadow-sm shadow-primary/20"
                  : "text-foreground/80 hover:bg-accent hover:text-foreground",
              )}
            >
              <Icon className={cn(expanded ? "h-4 w-4 shrink-0" : "h-5 w-5")} />
              <span className={cn("truncate", !expanded && "leading-none")}>{n.label}</span>
            </Link>
          );
        })}
      </nav>

      {/* Profile */}
      <div className="border-t border-border p-2 space-y-1.5">
        <Link
          to="/profile"
          title={!expanded ? "Profile" : undefined}
          className={cn(
            "flex rounded-lg transition-colors duration-150 hover:bg-accent",
            expanded ? "items-center gap-2.5 px-2 py-1.5" : "flex-col items-center gap-1 px-1 py-1.5",
          )}
        >
          <UserAvatar name={profile?.full_name ?? session.user.email} url={profile?.avatar_url} size="sm" />
          {expanded && (
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium truncate">{profile?.full_name ?? session.user.email}</div>
              <div className="text-[10px] text-muted-foreground capitalize truncate">{role?.replace("_", " ") ?? "—"}</div>
            </div>
          )}
        </Link>
        <Button
          variant="ghost"
          size="sm"
          className={cn("w-full", !expanded && "px-0")}
          onClick={() => signOut().then(() => navigate({ to: "/auth", replace: true }))}
          title={!expanded ? "Sign out" : undefined}
        >
          <LogOut className="h-4 w-4" />
          {expanded && <span className="ml-2 text-xs">Sign out</span>}
        </Button>
      </div>
    </>
  );

  return (
    <div className="min-h-screen flex bg-muted/30">
      {/* Desktop sidebar */}
      <aside className={cn(
        "hidden md:flex shrink-0 sticky top-0 h-screen bg-card border-r border-border flex-col transition-[width] duration-150 ease-out z-20",
        sidebarWidth,
      )}>
        {SidebarContent}
      </aside>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="absolute inset-0 bg-black/50 animate-in fade-in duration-150" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-56 bg-card border-r border-border flex flex-col shadow-2xl animate-in slide-in-from-left duration-150">
            <div className="flex justify-end p-2">
              <Button variant="ghost" size="icon" onClick={() => setMobileOpen(false)}><X className="h-4 w-4" /></Button>
            </div>
            {/* Force expanded look in mobile drawer */}
            <MobileSidebar logoUrl={logoUrl} nav={nav} activePath={activePath} profile={profile} role={role} email={session.user.email} onSignOut={() => signOut().then(() => navigate({ to: "/auth", replace: true }))} />
          </aside>
        </div>
      )}

      <main className="flex-1 min-w-0 flex flex-col">
        {/* Top bar */}
        <div className="sticky top-0 z-30 bg-card/80 backdrop-blur-md border-b border-border h-12 flex items-center px-3 gap-2">
          <Button variant="ghost" size="icon" className="md:hidden h-9 w-9" onClick={() => setMobileOpen(true)} aria-label="Open menu">
            <Menu className="h-5 w-5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="hidden md:inline-flex h-9 w-9"
            onClick={() => setExpanded((v) => !v)}
            aria-label="Toggle sidebar"
            aria-expanded={expanded}
          >
            <Menu className="h-5 w-5" />
          </Button>
          <div className="text-sm font-medium truncate flex-1 text-foreground/80">MilaServ Portal</div>
          <ThemeToggle />
          <NotificationBell />

        </div>
        {/* Route content — quick fade-in */}
        <div
          key={location.pathname}
          className="p-3 sm:p-4 lg:p-6 xl:px-8 w-full animate-in fade-in duration-150"
        >
          <Outlet />
        </div>
      </main>
    </div>
  );
}

function MobileSidebar({ logoUrl, nav, activePath, profile, role, email, onSignOut }: {
  logoUrl: string;
  nav: Array<{ to: string; label: string; icon: any }>;
  activePath: string;
  profile: any;
  role: string | null;
  email?: string;
  onSignOut: () => void;
}) {
  return (
    <>
      <div className="px-3 py-3 border-b border-border flex items-center gap-3">
        <div className="h-10 w-10 flex items-center justify-center shrink-0">
          <img src={logoUrl} alt="MilaServ" className="max-h-full max-w-full object-contain" />
        </div>


        <div className="min-w-0">
          <div className="text-sm font-bold leading-tight tracking-tight truncate text-foreground">MilaServ</div>
          <div className="text-[10px] text-muted-foreground font-medium tracking-wider uppercase">Portal</div>
        </div>
      </div>
      <nav className="flex-1 px-2 py-2 space-y-0.5 overflow-y-auto">
        {nav.map((n) => {
          const active = activePath === n.to;
          const Icon = n.icon;
          return (
            <Link
              key={n.to}
              to={n.to}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors duration-150",
                active
                  ? "bg-primary text-primary-foreground"
                  : "text-foreground/80 hover:bg-accent hover:text-foreground",
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="truncate">{n.label}</span>
            </Link>
          );
        })}
      </nav>
      <div className="border-t border-border p-2 space-y-1.5">
        <Link to="/profile" className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-accent transition-colors duration-150">
          <UserAvatar name={profile?.full_name ?? email} url={profile?.avatar_url} size="sm" />
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium truncate">{profile?.full_name ?? email}</div>
            <div className="text-[10px] text-muted-foreground capitalize truncate">{role?.replace("_", " ") ?? "—"}</div>
          </div>
        </Link>
        <Button variant="ghost" size="sm" className="w-full" onClick={onSignOut}>
          <LogOut className="h-4 w-4 mr-2" /><span className="text-xs">Sign out</span>
        </Button>
      </div>
    </>
  );
}
