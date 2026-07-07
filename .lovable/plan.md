## Part 1 — Call Center Analytics Accuracy

The reported symptoms — Inbound 607 vs expected 247 (~2.4x), Answered 1129 vs 768, Abandoned 0 — point to two independent bugs:

1. **Grouping falls through to per-row IDs.** Today `groupKey` is `linkedid ?? call_id ?? uid ?? new_id ?? id`. `uid`, `new_id`, and `id` are unique per CDR row, so when `linkedid`/`call_id` are absent (P-Series Cloud), every leg becomes its own group and multi-leg queue calls get counted 2–3x. That inflates Inbound and Answered.
2. **Abandoned always 0.** Abandoned is defined as Inbound unanswered + ring < 5s. If those groups also collapse into a later ANSWERED leg (because `call_id` shares across the queue attempt and final answer), the abandoned bucket is never hit. Combined with bug #1, or if `ring_duration` is empty and the field is actually `agent_ring_time`/`wait_time`, this metric collapses to zero.

### Fix
- Rewrite `groupKey`: use `call_id` when present, else `linkedid`, else a **fingerprint** `${call_from_number}|${call_to_number}|floor(timestamp/120)` so adjacent legs of the same queue call collapse. Never fall through to `uid`/`id` (per-row unique).
- **Row-level dedup** before grouping: drop exact duplicates on `(timestamp, call_from_number, call_to_number, disposition, talk_duration)`.
- **Internal exclusion hardening**: also drop rows where both `call_from_number` and `call_to_number` are ≤4 digits (internal ext ranges) regardless of `call_type`.
- **Ring / wait fallback**: compute ring seconds as `max(ring_duration, agent_ring_time, wait_time)` across the group so Abandoned can trigger.
- Recompute per-agent stats from raw rows unchanged (already correct).
- Expand `yeastarCdrProbe` sample to include `call_id`, `linkedid`, `uid`, `new_id`, `pin_code`, `id`, `agent_ring_time`, `wait_time`, `ring_duration` so we can verify the field shape from the Yeastar Diagnostics page and tune the heuristic if the numbers still don't line up.

If after this fix numbers still drift, the probe output will tell us exactly which ID field ties queue legs together and I can lock the grouping to that single field.

## Part 2 — Progressive Web App

Follow the built-in PWA skill's controlled path (offline support was explicitly requested):

- Add `vite-plugin-pwa` with `generateSW`, `registerType: "autoUpdate"`, `injectRegister: null`, `devOptions.enabled: false`.
- Runtime caching: `NetworkFirst` for HTML navigations, `CacheFirst` for hashed same-origin assets, exclude `/~oauth`, `/_serverFn`, `/api`.
- Create `src/lib/pwa/register.ts` — guarded wrapper that refuses to register in dev, iframe, Lovable preview hosts, or when `?sw=off`; unregisters any stale `/sw.js` in those contexts. Called once from `RootComponent`.
- Manifest: name "MilaServ Portal", short_name "MilaServ", `display: standalone`, `theme_color` + `background_color` matching the app palette, start_url `/dashboard`, scope `/`.
- Icons: generate a 512×512 brand mark (maskable + any purpose), reference 192 and 512 in the manifest.
- `__root.tsx` head: add `<link rel="manifest">`, `<meta name="theme-color">`, `<link rel="apple-touch-icon">`.

## Files touched
- `src/lib/yeastar/stats.server.ts` — grouping, dedup, internal filter, ring fallback
- `src/lib/yeastar.functions.ts` — expanded probe sample fields
- `vite.config.ts` — add VitePWA plugin
- `src/lib/pwa/register.ts` — new guarded registration
- `src/routes/__root.tsx` — manifest link, theme-color, apple-touch-icon, register call
- `public/manifest.webmanifest`, `public/pwa-192.png`, `public/pwa-512.png` — new
- `package.json` — add `vite-plugin-pwa`

## Out of scope for this turn
- Verifying the analytics numbers exactly match Yeastar totals — that requires you to open Admin → Yeastar Diagnostics after this ships and share the expanded probe sample so I can confirm which ID field groups the legs. If the numbers are still off, I'll pin the grouping to that field.
