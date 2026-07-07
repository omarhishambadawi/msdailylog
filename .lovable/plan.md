# MilaServ Portal — Rebrand + Call Center Analytics v2

Large multi-part change touching branding, analytics math, roles, and UI. Sections below map 1:1 to your numbered requirements.

## 1. Rebrand → "MilaServ Portal"

Rename every user-visible reference from "MilaServ Daily Log" to "MilaServ Portal".

Files:
- `src/routes/__root.tsx` — title, description, og:title, og:description, twitter:title/description
- `src/routes/_app.tsx` — sidebar subtitle chip + top bar text
- `src/routes/auth.tsx` — login card branding
- `src/routes/index.tsx` — landing meta/title if present
- All route `head()` meta titles that end in "— MilaServ" get updated wording

## 2–4. Filters & default range

- **Default date range**: current month (1st of month → today). Applies to Call Center page only (dashboard unchanged).
- **Direction**: Inbound / Outbound only. Remove "All directions" and "Internal" from the picker. Internal is dropped entirely from analytics.
- **Status filter**: removed from UI (still supported server-side but no chip).
- Every KPI, chart and table reads from the same query; changing filters triggers exactly one refetch.

## 5–6. Analytics math corrections (`stats.server.ts`)

Rewrite `aggregateAnalytics` with these rules:

**Grouping**: unchanged — group by `linkedid ?? call_id ?? uid`.

**Direction totals** (queue-aware — one group = one call):
- Inbound = groups whose direction is `Inbound`
- Outbound = groups whose direction is `Outbound`
- Internal calls **excluded from every counter, chart and percentage**
- Total = Inbound + Outbound

**Answered** = groups with ANY row `disposition = ANSWERED`.

**Missed (platform)** = Inbound groups where **no row answered AND ring ≥ 5s**. This will exclude the queue-forwarded flows (that end with ANSWERED elsewhere in the group) → yields the correct low number (e.g. 1 for July current month).

**Abandoned** = Inbound groups where **no row answered AND ring < 5s**.

**Outbound "No Answer"** = new per-agent KPI `noAnswerOutbound` for outbound rows where the customer didn't pick up. Reported only in the agent table, **never** rolled into platform Missed.

**Agent-level `missed`** stays row-based (per-agent perf metric, e.g. 4006 Fadwa = 1) — surfaced in the agent table only, never summed into the platform KPI.

**Time metrics** (from Yeastar row fields, seconds):
- Avg Talk = sum(talk_duration of answered primary rows) / answered groups
- Avg Wait (rename "Avg Ring") = sum(ring_duration of answered groups) / answered groups
- Total Talk = sum(talk_duration across all answered rows)

Formatted `HH:MM:SS`.

## 7. Satisfaction Survey analytics

**Question for you**: Yeastar's IVR survey CDR field isn't wired yet. Two options:
- **(A)** I add a `satisfaction_surveys` table (rating 1–5, agent_id, call_id, submitted_at) with an insert endpoint, plus KPIs (response rate, avg score, distribution, trend) rendering empty state until data flows.
- **(B)** You point me at a specific Yeastar CDR field / IVR export you already have.

Default plan: **(A)** — ship the section with empty-state now, hook to real data when the source is confirmed.

## 8–12. Section removals

Remove KPIs: Avg Ring Time (kept internally as "Avg Wait"), Avg Duration, Shortest Call, Active Agents, Calls/agent.
Remove charts: Answered vs Missed vs Abandoned trend, Peak Traffic Heatmap, Missed vs Abandoned chart.

Replace the removed trend with: **Inbound vs Outbound trend** + **Answer-rate trend** (business-meaningful).

## 10. Hourly = 12-hour AM/PM

Hourly bar chart X-axis ticks: `12 AM, 1 AM … 11 AM, 12 PM, 1 PM … 11 PM`.

## 13. Conversion rate (telesales)

Formula: `Completed telesales orders / Answered telesales calls × 100`.
- Only agents with role `telesales` count in numerator + denominator
- Only `orders.status = 'Completed'` in numerator
- Customer Care fully excluded

## 14. UI/UX redesign

Single unified page, executive layout:
```
┌─ Header (title + date range + team + direction + export) ─┐
│                                                            │
│  Row 1 — Hero KPIs (4 cards):                              │
│    Total · Answered · Answer Rate · Conversion Rate        │
│                                                            │
│  Row 2 — Queue Stats (3 cards):                            │
│    Missed · Abandoned · No-Answer Outbound                 │
│                                                            │
│  Row 3 — Direction (2 cards):  Inbound · Outbound          │
│                                                            │
│  Row 4 — Time Metrics (3 cards):                           │
│    Avg Talking · Avg Waiting · Total Talk Duration         │
│                                                            │
│  Section A — Call Trends (Inbound vs Outbound / Answer %)  │
│  Section B — Hourly Distribution (12-hr AM/PM)             │
│  Section C — Agent Performance (searchable table)          │
│  Section D — Telesales Conversion                          │
│  Section E — Satisfaction Survey                           │
└────────────────────────────────────────────────────────────┘
```
- Tabs removed (one continuous page, sectioned)
- Consistent card padding, typography scale, semantic tokens only
- Skeleton loaders per section (never spinners), charts render once via a `hasData` gate

## 15. Performance

- Single server call fetches everything for the range
- 5-min server cache key = `from|to` (already in place, extend TTL)
- Client `useQuery` with `staleTime: 5 min`, `placeholderData: keepPreviousData` — no chart remount on filter changes
- Memoize chart data derivations
- Progress bar polling stays at 500ms only while fetching

## 16. New `call_center` role + permission audit

**Migration**: add `'call_center'` to `public.app_role` enum, extend `has_permission` PL/pgSQL with its allow-list.

Default perms: `view_orders`, `view_complaints`, `create_complaints`, `resolve_complaints`, `view_dashboard`, `view_team_analytics`, `view_call_center` (new perm key).

Add permission `view_call_center` in `src/lib/permissions.ts`; sidebar nav uses it instead of the current fallback.

Audit table (enforced):
| Role | Dashboard | Orders | Complaints | Call Center | Users | Yeastar |
|---|---|---|---|---|---|---|
| owner/admin | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| call_center | ✓ | view | full | ✓ | ✗ | ✗ |
| customer_care | ✓ | view+create+edit own | full | ✗ | ✗ | ✗ |
| telesales | ✓ | view+create+edit own | ✗ | ✗ | ✗ | ✗ |
| auditor | read-only | read | read | read | ✗ | ✗ |

Users admin dropdown gains "Call Center" option.

## Files changed / added

**Modified**
- `src/routes/__root.tsx`, `src/routes/_app.tsx`, `src/routes/auth.tsx`
- `src/lib/yeastar/stats.server.ts` — rewrite aggregator
- `src/lib/yeastar.functions.ts` — direction validator (Inbound/Outbound only)
- `src/routes/_app.call-center.tsx` — full redesign, sectioned single-page
- `src/lib/permissions.ts` — new `view_call_center` perm, `call_center` role allow-list
- `src/lib/auth.tsx` — `AppRole` union += `'call_center'`
- `src/routes/_app.admin.users.tsx` — new role option
- `src/integrations/supabase/types.ts` — regenerated after migration (auto)

**New**
- `supabase/migrations/*_call_center_role_and_survey.sql`
  - `ALTER TYPE app_role ADD VALUE 'call_center'`
  - Extend `has_permission` function
  - Create `public.satisfaction_surveys` table + RLS + GRANTs
- `src/lib/surveys.functions.ts` — server fn to insert + aggregate survey data
- `src/components/call-center/*` — SectionCard, KpiHero, TimeMetric, HourlyChart, TrendChart, AgentTable, ConversionPanel, SurveyPanel

## One open question

**Satisfaction Survey data source** — go with option (A) new table + insert endpoint (empty state until data lands), or do you have a Yeastar/IVR feed I should hook up?

If A is fine, I'll proceed on approval.