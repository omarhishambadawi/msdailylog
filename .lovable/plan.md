# Call Center Analytics Module

Move all Yeastar/PBX analytics out of the main Dashboard into a new standalone route `/call-center` with its own nav entry. Dashboard keeps Orders/Sales/Complaints/Business KPIs only.

## 1. Navigation & Route
- New route `src/routes/_app.call-center.tsx` (permission-gated: `view_team_analytics` or admin).
- Add "Call Center" item to the app sidebar/nav.
- Remove the Yeastar `CallCenterSection` from `src/routes/_app.dashboard.tsx`.

## 2. Data Pipeline (performance)
Rework `src/lib/yeastar/cdr.server.ts` + new server functions:
- **Progressive fetch**: split into 3 server fns
  1. `getCallKpis({from,to,team?,agent?,direction?,status?})` — fetches CDRs, returns KPI totals only (fast).
  2. `getCallSeries(...)` — returns daily/weekly/monthly + hourly aggregates.
  3. `getCallTables(...)` — per-agent, per-team, unmatched, raw sample.
- Cache raw CDR pages in `yeastar_cdr_cache` table keyed by `(from,to)` for 5 min TTL so repeat views are instant.
- **Progress reporting**: new server route `GET /api/cdr-progress?jobId=…` returning `{page, totalPages, records, percent, status}`. `fetchCdrRange` writes progress into an in-memory + `yeastar_cdr_jobs` row. UI polls every 500ms and shows `██████░░ 62% — page 14/22`.
- Client uses TanStack Query with staggered `enabled` flags: KPIs → charts → tables.

## 3. Queue-Aware Missed Call Logic
CDR `call_type=Inbound` for a queue produces multiple records or a single record with `agent_list`/`dst_list`. Correct rules:
- **Global missed** = group CDRs by `call_id`/`uid` (or linkedid). If ANY row in the group has `disposition=ANSWERED`, group is answered — not missed.
- **Global abandoned** = caller hung up before any agent picked up (all rows NO ANSWER + short ring, or disposition=`ABANDONED` if PBX provides it).
- **Per-agent missed** = row where THAT agent's extension was rung and disposition=NO ANSWER, even if another agent answered a sibling row.
Implement in `stats.server.ts`:
- Add `groupByCall(records)` helper.
- Recompute totals from groups, per-agent from raw rows.

## 4. KPI Cards (all from real CDR)
Total, Answered, Missed (global), Abandoned, Failed, Busy, Inbound, Outbound, Internal, AnswerRate, MissedRate, AbandonRate, AvgTalk, AHT (talk+hold+wrap fallback=talk+ring), AvgRing, AvgDuration, TotalTalk, Longest, Shortest, ActiveAgents, CallsPerAgent.

## 5. Charts (Recharts)
Daily/Weekly/Monthly toggle for: Calls/Day, Answer Rate, Missed Rate, Abandon Rate, AHT, Talk, Ring, Inbound-vs-Outbound. Hourly: bar + heatmap (day×hour), Peak Hours, Answer Rate by hour. Comparisons: Team (CC vs Telesales), Top/Bottom agents, Conversion trend.

## 6. Agent & Team Tables
Sortable/searchable/filterable tables with all requested columns. Top/Bottom performer highlight cards above.

## 7. Missed / Abandoned / Failed / Busy separate sections with own trend lines.

## 8. Conversion (Telesales only)
Join `orders` with telesales agents by `agent_id`:
- Overall / Cash / Wasfaty / Per-Agent / Per-Day / Monthly Conversion = orders ÷ answered × 100.
- Revenue per answered call, per order, avg orders/call, completed/cancelled/pending counts.
- No conversion rendered for customer_care.

## 9. Filters (single toolbar, applied to all queries)
Date presets (Today, Yesterday, 7d, 30d, MTD, Prev Month, Custom) + Team + Agent + Direction + Status. State kept in route search params so links are shareable.

## 10. Export
Client-side: CSV + XLSX via `xlsx`, PDF via `jspdf` + `jspdf-autotable`. Export current filtered dataset (KPIs, per-agent, per-day, per-hour).

## 11. UX
Skeletons per section, progress bar for CDR fetch, empty states, non-blocking error toasts, responsive grid.

## Technical notes
- Files added: `src/routes/_app.call-center.tsx`, `src/components/call-center/*` (KpiGrid, DailyCharts, HourlyHeatmap, AgentTable, TeamCompare, ConversionPanel, MissedBreakdown, FiltersBar, ProgressBar, ExportMenu), `src/lib/yeastar/groups.server.ts`, `src/lib/yeastar/progress.server.ts`, `src/lib/call-center.functions.ts`.
- Files edited: `src/lib/yeastar/cdr.server.ts` (progress hook + cache), `src/lib/yeastar/stats.server.ts` (queue grouping, conversion), `src/routes/_app.dashboard.tsx` (remove PBX section), sidebar/nav.
- New tables (migration): `yeastar_cdr_cache(range_key text pk, payload jsonb, fetched_at)`, `yeastar_cdr_jobs(job_id uuid pk, from_date, to_date, page, total_pages, records, status, updated_at)` with GRANTs + RLS (authenticated read own, service_role all).
- New deps: `xlsx`, `jspdf`, `jspdf-autotable`.

## Confirm before I start
1. **Queue detection field** — does your PBX populate `linkedid`, `call_id`, or `uid` consistently on grouped queue rings? I'll default to `linkedid ?? call_id ?? uid` and fall back to `(call_from_number, floor(timestamp/60))` if all are absent.
2. **Order↔agent join** — use `orders.agent_id = profiles.id` where `profiles.yeastar_ext` matches the CDR extension. OK?
3. **Abandoned source** — Yeastar P-Series exposes abandoned via the Queue Panel API, not `/cdr/list`. I'll approximate abandoned as `Inbound group with disposition=NO ANSWER AND ring_duration < 5s AND no agent answered`. Acceptable, or should I also pull `/queuepanel` data?
