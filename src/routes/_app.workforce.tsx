import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { hasPerm } from "@/lib/permissions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { ShieldAlert } from "lucide-react";
import wf from "@/lib/workforce-data.json";

export const Route = createFileRoute("/_app/workforce")({
  head: () => ({ meta: [{ title: "Workforce — MilaServ Daily Log" }] }),
  component: Workforce,
});

type Schedule = { days: string[]; agents: { name: string; shifts: Record<string, string[]> }[] };

function ScheduleTable({ schedule }: { schedule: Schedule }) {
  return (
    <div className="w-full overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="bg-muted/40 border-b">
            <th className="px-3 py-2 text-left text-xs uppercase tracking-wider font-semibold">Agent</th>
            {schedule.days.map((d) => (
              <th key={d} className="px-3 py-2 text-left text-xs uppercase tracking-wider font-semibold whitespace-nowrap">{d}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {schedule.agents.map((a, i) => (
            <tr key={a.name} className={i % 2 === 1 ? "bg-muted/20" : ""}>
              <td className="px-3 py-2 font-medium whitespace-nowrap">{a.name}</td>
              {schedule.days.map((d) => {
                const parts = a.shifts[d] ?? [];
                return (
                  <td key={d} className="px-3 py-2 align-top text-xs">
                    {parts.length === 0 ? <span className="text-muted-foreground">—</span> : parts.map((p, idx) => (
                      <div key={idx} className="whitespace-nowrap">{p}</div>
                    ))}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Workforce() {
  const { role, profile } = useAuth();
  const canView = hasPerm(role, profile?.permissions as any, "view_workforce");
  const canManage = hasPerm(role, profile?.permissions as any, "manage_workforce");
  const [tab, setTab] = useState("cc");

  if (!canView) {
    return <div className="text-center py-16"><ShieldAlert className="mx-auto h-10 w-10 text-destructive" /><p className="mt-2 text-sm text-muted-foreground">You don't have access to Workforce Management.</p></div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">Workforce Management</h1>
          <p className="text-sm text-muted-foreground">Team schedules, attendance, leave and permissions</p>
        </div>
        <Badge variant="outline" className="capitalize">{canManage ? "Admin access" : "View only"}</Badge>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex flex-wrap h-auto">
          <TabsTrigger value="cc">Customer Care</TabsTrigger>
          <TabsTrigger value="ts">Telesales</TabsTrigger>
          <TabsTrigger value="absence">Absence</TabsTrigger>
          <TabsTrigger value="permissions">Permissions</TabsTrigger>
          <TabsTrigger value="ramadan">Ramadan</TabsTrigger>
          <TabsTrigger value="eid">Eid</TabsTrigger>
        </TabsList>

        <TabsContent value="cc" className="mt-3">
          <Card><CardHeader><CardTitle className="text-base">Customer Care — Weekly Shift Schedule</CardTitle></CardHeader>
            <CardContent className="p-0"><ScheduleTable schedule={wf.customer_care as Schedule} /></CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="ts" className="mt-3">
          <Card><CardHeader><CardTitle className="text-base">Telesales — Weekly Shift Schedule</CardTitle></CardHeader>
            <CardContent className="p-0"><ScheduleTable schedule={wf.telesales as Schedule} /></CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="absence" className="mt-3">
          <Card><CardHeader><CardTitle className="text-base">Absence Log</CardTitle></CardHeader>
            <CardContent className="p-0">
              <div className="w-full overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-muted/40 border-b">
                      <th className="px-3 py-2 text-left text-xs uppercase tracking-wider font-semibold">Date</th>
                      <th className="px-3 py-2 text-left text-xs uppercase tracking-wider font-semibold">Customer Care</th>
                      <th className="px-3 py-2 text-left text-xs uppercase tracking-wider font-semibold">Telesales</th>
                      <th className="px-3 py-2 text-left text-xs uppercase tracking-wider font-semibold">Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(wf.absence as any[]).map((r, i) => (
                      <tr key={i} className={i % 2 === 1 ? "bg-muted/20" : ""}>
                        <td className="px-3 py-2 whitespace-nowrap font-mono text-xs">{r.date ?? "—"}</td>
                        <td className="px-3 py-2">{r.customer_care ?? "—"}</td>
                        <td className="px-3 py-2">{r.telesales ?? "—"}</td>
                        <td className="px-3 py-2 text-muted-foreground">{r.notes ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="permissions" className="mt-3">
          <Card><CardHeader><CardTitle className="text-base">Agent Permissions (leave balance)</CardTitle></CardHeader>
            <CardContent className="p-0">
              <div className="w-full overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-muted/40 border-b">
                      <th className="px-3 py-2 text-left text-xs uppercase tracking-wider font-semibold">Agent</th>
                      <th className="px-3 py-2 text-center text-xs uppercase tracking-wider font-semibold">1st (30m)</th>
                      <th className="px-3 py-2 text-center text-xs uppercase tracking-wider font-semibold">2nd (30m)</th>
                      <th className="px-3 py-2 text-center text-xs uppercase tracking-wider font-semibold">3rd (30m)</th>
                      <th className="px-3 py-2 text-center text-xs uppercase tracking-wider font-semibold">4th (2h)</th>
                      <th className="px-3 py-2 text-left text-xs uppercase tracking-wider font-semibold">Used on</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(wf.permissions as any[]).map((p, i) => (
                      <tr key={i} className={i % 2 === 1 ? "bg-muted/20" : ""}>
                        <td className="px-3 py-2 font-medium whitespace-nowrap">{p.agent}</td>
                        {[p.p1_30, p.p2_30, p.p3_30, p.p4_2h].map((v: boolean, idx: number) => (
                          <td key={idx} className="px-3 py-2 text-center">
                            <span className={v ? "text-green-600 font-semibold" : "text-muted-foreground"}>{v ? "✓" : "—"}</span>
                          </td>
                        ))}
                        <td className="px-3 py-2 text-xs text-muted-foreground">{(p.dates ?? []).join(", ") || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="ramadan" className="mt-3">
          <Card><CardHeader><CardTitle className="text-base">Ramadan Schedule</CardTitle></CardHeader>
            <CardContent className="p-0"><ScheduleTable schedule={wf.ramadan as Schedule} /></CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="eid" className="mt-3">
          <Card><CardHeader><CardTitle className="text-base">Eid Shift Schedule</CardTitle></CardHeader>
            <CardContent className="p-0"><ScheduleTable schedule={wf.eid as Schedule} /></CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {!canManage && (
        <p className="text-xs text-muted-foreground">Read-only view. Editing schedules requires admin access.</p>
      )}
    </div>
  );
}
