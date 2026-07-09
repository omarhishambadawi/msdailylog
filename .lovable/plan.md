# UI/UX Refinement Plan

Six focused workstreams. No schema-breaking changes; one additive migration for avatars + `view_branches` permission.

## 1. Sidebar — compact-by-default

Rewrite `src/routes/_app.tsx`:
- Default state: **collapsed** (icons + label under icon), width `w-20` (~80px).
- Expanded state: icons + labels beside, width `w-56` (down from `w-64`).
- Preference persisted to `localStorage` (`milaserv.sidebar.collapsed`), hydrated after mount to avoid SSR mismatch.
- Toggle button in top bar (Menu icon) — clear affordance, `aria-expanded`.
- Transition: `transition-[width] duration-200 ease-out` (was 300ms).
- Active state: kept (primary bg + accent stripe), but tightened.
- Logo area: **always-white rounded container** (`bg-white ring-1 ring-border`), padded, dark-mode safe. Sits in header regardless of collapsed/expanded.

## 2. Global animation speed pass

- Reduce durations: `duration-300` → `duration-150`/`200` on page transitions, sidebar, drawers.
- Buttons/cards hover: `transition-colors duration-150`.
- Route content wrapper: `duration-150` fade-in only (drop slide-in — it feels laggy).
- Dropdowns/dialogs (shadcn) already use fast Radix defaults — no change needed unless a component overrides them.

## 3. Editable Profile + avatars

Migration:
- Add `avatar_url text` to `public.profiles`.
- Create private storage bucket `avatars` (per-user folder `${uid}/…`), RLS: user can CRUD own folder; anyone authenticated can read (needed to display avatars everywhere). Or public bucket — simpler for cross-user display. **Going public** so avatars render in orders/comments without signed URLs.
- Add `view_branches` to permissions catalog (see §5).

`src/routes/_app.profile.tsx`:
- Remove gradient banner.
- Minimalist header: large avatar (Linear/Slack style), name, role badge, edit affordance.
- Avatar upload dialog: file input → preview → Save/Remove. Uploads to `avatars/${uid}/avatar-<ts>.<ext>`, updates `profiles.avatar_url`.
- Editable fields (with permission gate): `full_name`. `agent_code`, `yeastar_ext`, role, active flag remain admin-only (read-only for self).
- Save via server fn using `requireSupabaseAuth` (writes own row).

Reusable `<UserAvatar userId? url? name? size />` component in `src/components/user-avatar.tsx` used by orders lists, comments, activity, sidebar profile card. Falls back to initials gradient (existing style) when no `avatar_url`.

Wire into: sidebar profile card, mobile bottom-nav profile icon, orders list agent column, order detail activity/comments, complaint activity — wherever a name currently renders with initials.

## 4. Branches read-only for agents

Migration:
- Add `view_branches` permission string (catalog only — no DB enum for permissions, they're text[] on profiles).
- Update `has_permission` mapping in `src/lib/permissions.ts`: `customer_care`, `telesales`, `call_center` get `view_branches`; only `admin_access` gets edit/delete.

Route `_app.admin.branches.tsx`:
- Gate render on `view_branches` (not `admin_access`).
- Hide Add/Edit/Delete/Import/Export buttons when `!admin_access`.
- Add search + filter (existing table probably has search; verify and add if missing).
- Sidebar link visibility: show for `view_branches` (currently gated on `admin_access`).

## 5. Users page redesign

Rewrite `src/routes/_app.admin.users.tsx` presentation only — keep existing server fns and mutations:
- Header row with title + primary "Invite user" button.
- Toolbar: search (name/email), role filter, status filter, results count.
- Table redesigned with proper avatar column (uses `<UserAvatar />`), role badge with tone (owner=primary, admin=secondary, auditor=muted, others=outline), status pill (Active/Inactive with dot), overflow menu (…) for actions instead of raw buttons.
- Permission management: switch from a wall of checkboxes to a **grouped popover/sheet** — grouped by section (Dashboard, Orders, Complaints, Call Center, Admin) with toggle switches. Better UX, same underlying `permissions text[]`.
- Client-side pagination retained (or add simple `page-size` selector).
- Mobile: table collapses to card list.

## 6. Non-goals / preserved

- Auth flow, RLS on orders/complaints, Call Center analytics logic — untouched.
- Yeastar integration untouched.
- Existing route paths unchanged.

## Technical notes

- Storage bucket via `supabase--storage_create_bucket` tool, then RLS policies via migration.
- `profiles.avatar_url` returned by existing `get_my_profile()` RPC — update RPC signature to include the new column.
- `Profile` interface extended with `avatar_url`.
- No changes to `_authenticated`/auth middleware wiring.

## Order of execution

1. Migration (avatar_url column, `get_my_profile` update) + storage bucket.
2. `permissions.ts` update + `Profile` type.
3. `<UserAvatar />` component.
4. Sidebar rewrite + white logo container + animation speeds.
5. Profile page editable + minimalist header.
6. Branches gating.
7. Users page redesign.
8. Wire `<UserAvatar />` into orders/complaints/activity lists.

Ready to build on approval.