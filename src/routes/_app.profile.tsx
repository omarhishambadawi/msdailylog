import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useAuth } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { LogOut, Mail, IdCard, Phone, ShieldCheck, Calendar } from "lucide-react";
import { format } from "date-fns";

export const Route = createFileRoute("/_app/profile")({
  component: ProfilePage,
  head: () => ({ meta: [{ title: "My Profile — MilaServ Portal" }] }),
});

function ProfilePage() {
  const { session, profile, role, signOut } = useAuth();
  const navigate = useNavigate();

  const initials = (profile?.full_name ?? session?.user?.email ?? "?")
    .split(/\s+/).map((s) => s[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();

  const created = profile?.created_at ? new Date(profile.created_at) : null;

  const perms = profile?.permissions ?? [];

  return (
    <div className="mx-auto max-w-3xl space-y-6 animate-in fade-in duration-300">
      <div>
        <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">My Profile</h1>
        <p className="text-sm text-muted-foreground">Your account details and access.</p>
      </div>

      {/* Identity card */}
      <Card className="overflow-hidden">
        <div className="h-24 bg-gradient-to-r from-primary/80 via-primary to-secondary" />
        <CardContent className="pt-0 -mt-12 space-y-4">
          <div className="flex items-end gap-4">
            <div className="h-24 w-24 rounded-full ring-4 ring-card bg-gradient-to-br from-primary to-secondary text-primary-foreground grid place-items-center text-2xl font-bold shadow-lg shrink-0">
              {initials}
            </div>
            <div className="pb-2 min-w-0">
              <div className="text-xl font-semibold truncate">{profile?.full_name ?? "—"}</div>
              <div className="flex flex-wrap items-center gap-2 mt-1">
                {role && <Badge variant="secondary" className="capitalize">{role.replace("_", " ")}</Badge>}
                {profile?.active ? (
                  <Badge className="bg-success text-success-foreground hover:bg-success">Active</Badge>
                ) : (
                  <Badge variant="destructive">Inactive</Badge>
                )}
              </div>
            </div>
          </div>

          <dl className="grid gap-3 sm:grid-cols-2 pt-4 border-t border-border">
            <InfoRow icon={Mail} label="Email" value={session?.user?.email ?? "—"} />
            <InfoRow icon={IdCard} label="Agent code" value={profile?.agent_code ?? "—"} mono />
            <InfoRow icon={Phone} label="Yeastar extension" value={profile?.yeastar_ext ?? "—"} mono />
            <InfoRow icon={Calendar} label="Member since" value={created ? format(created, "PP") : "—"} />
          </dl>
        </CardContent>
      </Card>

      {/* Permissions */}
      <Card>
        <CardHeader className="flex flex-row items-center gap-2 pb-3">
          <ShieldCheck className="h-4 w-4 text-primary" />
          <CardTitle className="text-base">Permissions</CardTitle>
        </CardHeader>
        <CardContent>
          {perms.length === 0 ? (
            <p className="text-sm text-muted-foreground">Using role defaults.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {perms.map((p) => (
                <Badge key={p} variant="outline" className="font-normal">{p.replace(/_/g, " ")}</Badge>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button
          variant="outline"
          onClick={() => signOut().then(() => navigate({ to: "/auth", replace: true }))}
        >
          <LogOut className="h-4 w-4 mr-2" />
          Sign out
        </Button>
      </div>
    </div>
  );
}

function InfoRow({ icon: Icon, label, value, mono }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 h-8 w-8 rounded-md bg-muted grid place-items-center shrink-0">
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="min-w-0">
        <dt className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">{label}</dt>
        <dd className={"text-sm text-foreground truncate " + (mono ? "font-mono" : "")}>{value}</dd>
      </div>
    </div>
  );
}
