import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { yeastarPhase1Probe, yeastarAuthDiagnostic, yeastarForceExpire } from "@/lib/yeastar-diagnostic.functions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const Route = createFileRoute("/_app/diagnostic/yeastar")({
  head: () => ({
    meta: [
      { title: "Yeastar Diagnostic — Phase 1 / 1.5" },
      { name: "description", content: "Isolated Yeastar auth + CDR diagnostic." },
    ],
  }),
  component: YeastarDiagnosticPage,
});

interface AuthRow {
  n: number;
  at: string;
  workerId: string;
  authSource: string;
  leaseAcquired: boolean;
  getTokenCalled: boolean;
  refreshTokenCalled: boolean;
  tokenRemainingSec: number;
  persistentAgeSec: number | null;
  credFingerprint: string;
  authBlockedUntil: string | null;
  elapsedMs: number;
  raw: any;
}

function YeastarDiagnosticPage() {
  const runProbe = useServerFn(yeastarPhase1Probe);
  const runAuth = useServerFn(yeastarAuthDiagnostic);
  const forceExpire = useServerFn(yeastarForceExpire);
  const [probeResult, setProbeResult] = useState<any>(null);
  const [probeBusy, setProbeBusy] = useState(false);
  const [expireMsg, setExpireMsg] = useState<string | null>(null);
  const [rows, setRows] = useState<AuthRow[]>([]);
  const [busy, setBusy] = useState<null | "one" | "ten">(null);

  const doOne = async (n: number) => {
    const r: any = await runAuth();
    const row: AuthRow = {
      n,
      at: r.at,
      workerId: r.workerId,
      authSource: r.authSource,
      leaseAcquired: !!r.leaseAcquired,
      getTokenCalled: !!r.getTokenCalled,
      refreshTokenCalled: !!r.refreshTokenCalled,
      tokenRemainingSec: r.tokenRemainingSec ?? 0,
      persistentAgeSec: r.persistent?.ageSec ?? null,
      credFingerprint: r.credFingerprint,
      authBlockedUntil: r.authBlockedUntil,
      elapsedMs: r.elapsedMs,
      raw: r,
    };
    setRows((rs) => [...rs, row]);
  };

  const runOnce = async () => {
    setBusy("one");
    try { await doOne(rows.length + 1); } finally { setBusy(null); }
  };

  const runTen = async () => {
    setBusy("ten");
    try {
      for (let i = 0; i < 10; i++) await doOne(rows.length + 1 + i);
    } finally { setBusy(null); }
  };

  const runTenParallel = async () => {
    setBusy("ten");
    try {
      const base = rows.length + 1;
      const results = await Promise.all(Array.from({ length: 10 }, () => runAuth()));
      const newRows = results.map((r: any, i) => ({
        n: base + i,
        at: r.at,
        workerId: r.workerId,
        authSource: r.authSource,
        leaseAcquired: !!r.leaseAcquired,
        getTokenCalled: !!r.getTokenCalled,
        refreshTokenCalled: !!r.refreshTokenCalled,
        tokenRemainingSec: r.tokenRemainingSec ?? 0,
        persistentAgeSec: r.persistent?.ageSec ?? null,
        credFingerprint: r.credFingerprint,
        authBlockedUntil: r.authBlockedUntil,
        elapsedMs: r.elapsedMs,
        raw: r,
      }));
      setRows((rs) => [...rs, ...newRows]);
    } finally { setBusy(null); }
  };

  const runPhase1 = async () => {
    setProbeBusy(true);
    try { setProbeResult(await runProbe()); } finally { setProbeBusy(false); }
  };

  const getTokenCount = rows.filter((r) => r.getTokenCalled).length;
  const refreshCount = rows.filter((r) => r.refreshTokenCalled).length;
  const uniqueWorkers = new Set(rows.map((r) => r.workerId)).size;

  return (
    <div className="mx-auto max-w-6xl p-6 space-y-4">
      <Card>
        <CardHeader><CardTitle>Yeastar Phase 1.5 — Auth Cache Diagnostic</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Test A: click "Run 10 sequential" — expect 1 get_token max, rest Memory/Persistent Cache.<br />
            Test B: open this page in a second browser/incognito, both click "Run once" — only one gets leaseAcquired=true and get_token=true.<br />
            Test C: after deploy or ~cold start, click "Run once" — expect authSource="Persistent Cache", get_token=false.
          </p>
          <div className="flex gap-2 flex-wrap">
            <Button onClick={runOnce} disabled={busy !== null}>Run once</Button>
            <Button onClick={runTen} disabled={busy !== null}>Run 10 sequential</Button>
            <Button onClick={runTenParallel} disabled={busy !== null} variant="secondary">Run 10 parallel</Button>
            <Button onClick={() => setRows([])} disabled={busy !== null} variant="ghost">Clear</Button>
            <Button
              onClick={async () => {
                const r: any = await forceExpire();
                setExpireMsg(r?.note ?? JSON.stringify(r));
              }}
              disabled={busy !== null}
              variant="destructive"
            >
              Test D: Force token expiry (60s)
            </Button>
          </div>
          {expireMsg && <div className="text-xs text-muted-foreground">{expireMsg}</div>}
          {rows.length > 0 && (
            <>
              <div className="text-sm">
                <strong>Summary:</strong> {rows.length} requests · get_token calls: <span className={getTokenCount > 1 ? "text-destructive font-bold" : "text-green-600"}>{getTokenCount}</span> · refresh_token calls: {refreshCount} · unique workers: {uniqueWorkers}
              </div>
              <div className="overflow-auto">
                <table className="text-xs w-full border-collapse">
                  <thead className="bg-muted">
                    <tr>
                      <th className="border p-1 text-left">#</th>
                      <th className="border p-1 text-left">Worker ID</th>
                      <th className="border p-1 text-left">Auth Source</th>
                      <th className="border p-1">Lease</th>
                      <th className="border p-1">get_token</th>
                      <th className="border p-1">refresh_token</th>
                      <th className="border p-1">Token Remaining</th>
                      <th className="border p-1">Persist Age</th>
                      <th className="border p-1">Fingerprint</th>
                      <th className="border p-1">Blocked Until</th>
                      <th className="border p-1">Elapsed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.n} className={r.getTokenCalled ? "bg-yellow-50" : ""}>
                        <td className="border p-1">{r.n}</td>
                        <td className="border p-1 font-mono">{r.workerId.slice(0, 8)}</td>
                        <td className="border p-1">{r.authSource}</td>
                        <td className="border p-1 text-center">{r.leaseAcquired ? "✓" : "—"}</td>
                        <td className="border p-1 text-center">{r.getTokenCalled ? "🔴 YES" : "no"}</td>
                        <td className="border p-1 text-center">{r.refreshTokenCalled ? "yes" : "no"}</td>
                        <td className="border p-1 text-right">{r.tokenRemainingSec}s</td>
                        <td className="border p-1 text-right">{r.persistentAgeSec ?? "—"}s</td>
                        <td className="border p-1 font-mono">{r.credFingerprint}</td>
                        <td className="border p-1">{r.authBlockedUntil ?? "—"}</td>
                        <td className="border p-1 text-right">{r.elapsedMs}ms</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <details className="text-xs">
                <summary className="cursor-pointer">Raw JSON</summary>
                <pre className="bg-muted p-2 rounded overflow-auto max-h-64">
                  {JSON.stringify(rows.map((r) => r.raw), null, 2)}
                </pre>
              </details>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Yeastar Phase 1 — CDR Probe</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <Button onClick={runPhase1} disabled={probeBusy}>
            {probeBusy ? "Running…" : "Run Phase 1 Probe (CDR)"}
          </Button>
          {probeResult && (
            <pre className="text-xs bg-muted p-3 rounded overflow-auto max-h-[50vh]">
              {JSON.stringify(probeResult, null, 2)}
            </pre>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
