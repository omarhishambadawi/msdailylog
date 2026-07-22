import { createFileRoute, Outlet, Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useAuth, isAdministrator } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import {
  LayoutDashboard, ListOrdered, Plus, Users, MapPin, LogOut,
  ShieldAlert, MessageSquareWarning, X, PhoneCall, Headphones,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { hasPerm } from "@/lib/permissions";
import { UserAvatar } from "@/components/user-avatar";
import { BrandLogo } from "@/components/brand-logo";
import { AppHeader } from "@/components/app-header";

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

  const activeItem = nav.find((n) => n.to === activePath);

  const sidebarWidth = expanded ? "w-56" : "w-20";

  const SidebarContent = (
    <>
      {/* Logo — inline, no plate/container */}
      <div className={cn(
        "h-16 shrink-0 border-b border-border flex items-center gap-3 transition-[padding] duration-200 ease-in-out",
        expanded ? "px-4" : "justify-center px-2",
      )}>
        <BrandLogo />
        {expanded && (
          <div className="min-w-0">
            <div className="text-sm font-bold leading-tight tracking-tight truncate text-foreground">MilaServ</div>
            <div className="text-[10px] text-muted-foreground font-medium tracking-[0.18em] uppercase">Portal</div>
          </div>
        )}
      </div>

      <nav className={cn(
        "flex-1 py-3 space-y-1 overflow-y-auto overflow-x-hidden",
        "[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent",
        "[&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border/70 hover:[&::-webkit-scrollbar-thumb]:bg-border",
        expanded ? "px-3" : "px-2.5",
      )}>
        {nav.map((n) => {
          const active = activePath === n.to;
          const Icon = n.icon;
          return (
            <Link
              key={n.to}
              to={n.to}
              title={!expanded ? n.label : undefined}
              aria-current={active ? "page" : undefined}
              className={cn(
                "group relative flex rounded-lg font-medium tracking-tight outline-none",
                "transition-[background-color,color,box-shadow,transform] duration-200 ease-out",
                "focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-1 focus-visible:ring-offset-card",
                expanded
                  ? "items-center gap-3 px-3 py-2 text-sm"
                  : "flex-col items-center justify-center gap-1 px-1 py-2.5 text-[10px] leading-none",
                active
                  ? "bg-primary text-primary-foreground shadow-sm shadow-primary/25"
                  : cn(
                      "text-foreground/70 hover:bg-accent hover:text-foreground",
                      expanded && "hover:translate-x-0.5",
                    ),
              )}
            >
              {/* Active accent rail (expanded only) — clean modern indicator */}
              {active && expanded && (
                <span aria-hidden className="absolute inset-y-1.5 left-0 w-[3px] rounded-r-full bg-primary-foreground/70" />
              )}
              <Icon
                className={cn(
                  "shrink-0 transition-transform duration-200 ease-out group-hover:scale-110",
                  expanded ? "h-[18px] w-[18px]" : "h-5 w-5",
                )}
              />
              <span className="truncate">{n.label}</span>
            </Link>
          );
        })}
      </nav>

      {/* Profile */}
      <div className="border-t border-border p-2.5 space-y-1.5">
        <Link
          to="/profile"
          title={!expanded ? "Profile" : undefined}
          className={cn(
            "flex rounded-lg transition-colors duration-200 ease-out hover:bg-accent",
            expanded ? "items-center gap-2.5 px-2 py-2" : "flex-col items-center gap-1 px-1 py-2",
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
          className={cn("w-full transition-colors duration-200 ease-out", !expanded && "px-0")}
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
        "hidden md:flex shrink-0 sticky top-0 h-screen bg-card border-r border-border flex-col overflow-hidden transition-[width] duration-200 ease-in-out will-change-[width] z-20",
        sidebarWidth,
      )}>
        {SidebarContent}
      </aside>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="absolute inset-0 bg-black/50 animate-in fade-in duration-150" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-[min(16rem,82vw)] bg-card border-r border-border flex flex-col shadow-2xl animate-in slide-in-from-left duration-200 ease-out">
            <div className="flex justify-end p-2">
              <Button variant="ghost" size="icon" onClick={() => setMobileOpen(false)}><X className="h-4 w-4" /></Button>
            </div>
            {/* Force expanded look in mobile drawer */}
            <MobileSidebar nav={nav} activePath={activePath} profile={profile} role={role} email={session.user.email} onSignOut={() => signOut().then(() => navigate({ to: "/auth", replace: true }))} />
          </aside>
        </div>
      )}

      <main className="flex-1 min-w-0 flex flex-col">
        <AppHeader
          title={activeItem?.label ?? "MilaServ Portal"}
          icon={activeItem?.icon}
          expanded={expanded}
          onToggleSidebar={() => setExpanded((v) => !v)}
          onOpenMobile={() => setMobileOpen(true)}
          name={profile?.full_name ?? session.user.email ?? "Account"}
          role={role}
          avatarUrl={profile?.avatar_url}
          onSignOut={() => signOut().then(() => navigate({ to: "/auth", replace: true }))}
        />
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

function MobileSidebar({ nav, activePath, profile, role, email, onSignOut }: {
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
        <BrandLogo />


        <div className="min-w-0">
          <div className="text-sm font-bold leading-tight tracking-tight truncate text-foreground">MilaServ</div>
          <div className="text-[10px] text-muted-foreground font-medium tracking-wider uppercase">Portal</div>
        </div>
      </div>
      <nav className="flex-1 px-3 py-3 space-y-1 overflow-y-auto [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border/70">
        {nav.map((n) => {
          const active = activePath === n.to;
          const Icon = n.icon;
          return (
            <Link
              key={n.to}
              to={n.to}
              aria-current={active ? "page" : undefined}
              className={cn(
                "group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium tracking-tight transition-[background-color,color,transform] duration-200 ease-out",
                active
                  ? "bg-primary text-primary-foreground shadow-sm shadow-primary/25"
                  : "text-foreground/70 hover:bg-accent hover:text-foreground hover:translate-x-0.5",
              )}
            >
              {active && (
                <span aria-hidden className="absolute inset-y-1.5 left-0 w-[3px] rounded-r-full bg-primary-foreground/70" />
              )}
              <Icon className="h-[18px] w-[18px] shrink-0 transition-transform duration-200 ease-out group-hover:scale-110" />
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
