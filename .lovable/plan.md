## Yeastar Analytics — Rebuild on Call Reports API

Replace raw CDR ingestion with the PBX's official **Call Reports** endpoint (`/openapi/v1.0/call_report/list`), scoped to the two extension groups **Customer_Care_Emp.** and **Telesales_Emp.**, and drive it entirely from the Dashboard's existing Date / Team / Agent filters.

### 1. Server layer (new modules)

- `src/lib/yeastar/groups.server.ts`
  - `resolveExtensionGroupIds()` — one call to `/extensiongroup/search` (or `/list`), matches group names `Customer_Care_Emp.` / `Telesales_Emp.`, returns `{ customerCare: id, telesales: id, extensions: { [groupId]: [{ext_id, ext_num, name}] } }`. Cached in-memory for 10 minutes (small, safe, avoids repeated lookups).
- `src/lib/yeastar/reports.server.ts`
  - `fetchExtCallStatistics({ from, to, team, communicationType })` — calls `GET /openapi/v1.0/call_report/list` with:
    - `type=extcallstatistics`
    - `ext_id_list=<group-id(s)>` (one, the other, or both — no client-side filtering)
    - `start_time` / `end_time` formatted per PBX display format (ISO `YYYY-MM-DD HH:mm:ss` with 00:00:00 / 23:59:59)
    - `communication_type` = `Inbound` | `Outbound` | `InOutbound` (default)
  - Returns typed per-extension rows: `{ ext_num, ext_name, group, total, answered, missed, inbound, outbound, answer_rate }`.
  - Handles paging (page_size 100).
- `src/lib/yeastar/reports-daily.server.ts`
  - For the Daily Call Volume chart, calls `type=extcallactivity` per day in the range (or a single call if the range fits one aggregation window), so the dashboard can plot per-day totals without downloading CDRs.
- `src/lib/yeastar.functions.ts` — replace CDR probe with three server functions (admin still required for diagnostics, but analytics fetch is available to any authenticated user with `view_dashboard`):
  - `yeastarGroupsDiagnostic()` — verifies both groups resolve and lists their extension counts.
  - `yeastarCallAnalytics({ from, to, team, agentId?, communicationType })` — the main dashboard query. Team maps to group id(s); `agentId` maps to the platform agent's `agent_code` → PBX extension number and filters the returned rows.
  - `yeastarDailyVolume({ from, to, team, communicationType })` — series for the daily chart.
- Delete `src/lib/yeastar/cdr.server.ts` and its diagnostic wrapper; remove the CDR probe card.

### 2. Dashboard integration

- Add a **Call Center Performance** section to `src/routes/_app.dashboard.tsx` that reads the existing `from`, `to`, `teamFilter`, `agentFilter` state and adds a small `communicationType` toggle (All / Inbound / Outbound) local to that section only (per spec, no separate date/team/agent filters).
- Fetches via `useQuery` keyed on all filters, so it re-runs whenever the Dashboard filters change.
- Renders:
  - **KPI row** (7 cards using existing `DashKpiCard`): Total, Answered, Missed, Inbound, Outbound, Answer Rate %, Missed Rate %.
  - **Charts**: Calls by Team (bar), Calls by Agent (bar), Inbound vs Outbound (donut), Answered vs Missed (donut), Daily Call Volume (line).
  - **Agents table**: Agent Name · Team · Total · Answered · Missed · Inbound · Outbound · Answer Rate.
- Only Customer Care + Telesales agents appear; mapping uses `profiles.agent_code` ↔ `ext_num` (already the convention).

### 3. Admin page

- Rewrite `src/routes/_app.admin.yeastar.tsx` to keep Configuration + Authentication cards, replace the CDR probe with a **Call Reports probe** that runs `yeastarGroupsDiagnostic` and a preview of `yeastarCallAnalytics` for yesterday.

### 4. Performance guarantees

- Group ID lookup: 1 request, cached 10 min.
- Analytics fetch: 1 request per selected team (max 2), scoped by `ext_id_list` + date + `communication_type` — PBX does the aggregation, no local filtering of raw CDR.
- Daily volume: 1 request using `extcallactivity`.
- Total: ≤ 4 PBX requests per dashboard load, well under Worker limits.

### 5. Filter contract

| Dashboard filter    | Sent to PBX as                                                        |
|---------------------|-----------------------------------------------------------------------|
| Date range          | `start_time` / `end_time` (PBX format, 00:00:00 → 23:59:59)          |
| Team = All          | `ext_id_list = <ccId>,<tsId>`                                         |
| Team = Customer Care| `ext_id_list = <ccId>`                                                |
| Team = Telesales    | `ext_id_list = <tsId>`                                                |
| Agent               | Filter returned rows by extension number → `agent_code`               |
| Communication Type  | `communication_type` = `Inbound` \| `Outbound` \| `InOutbound`        |

### Technical notes

- Endpoint: `GET {base}/openapi/v1.0/call_report/list?access_token=…&type=extcallstatistics&ext_id_list=…&start_time=…&end_time=…&communication_type=…`.
- Response uses `ext_call_statistics_list` array with per-extension counters (`total`, `answered`, `no_answered`, `inbound_calls`, `outbound_calls`, etc.); the module maps this to a normalized shape.
- Extension groups resolved via `/openapi/v1.0/extensiongroup/search` (name match) once per isolate, cached 10 min.
- No new tables, no new secrets. Uses the existing `yeastarFetch` client — token cache and single-flight auth remain unchanged.
- Removes: `src/lib/yeastar/cdr.server.ts`, the CDR probe UI, `yeastarCdrDiagnostic`.

Confirm and I'll implement.
