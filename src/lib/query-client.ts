import { QueryClient } from "@tanstack/react-query";

/**
 * Global React Query defaults.
 *
 * Previously `new QueryClient()` was constructed with no options at all, so every
 * query ran on library defaults: `staleTime: 0` (everything is stale the instant
 * it arrives), `refetchOnWindowFocus: true`, and `retry: 3`. On the Dashboard —
 * eleven independent aggregation queries — that meant eleven RPC round-trips on
 * every window focus and every remount, and a failed permission check took three
 * retries with backoff before the error surfaced.
 *
 * The evidence that the defaults were wrong is already in the codebase: the
 * call-center route hand-rolled `staleTime` + three `refetchOn*: false` flags to
 * opt out of them, in exactly one place. These defaults generalize that.
 *
 * Per-query overrides remain legitimate and are kept where the query genuinely
 * differs — see the notes on each option below.
 */
export const QUERY_DEFAULTS = {
  /**
   * How long fetched data is considered fresh.
   *
   * 0 (the old default) meant a refetch on every mount and every focus. 60s
   * matches how this data actually changes: orders and complaints are edited by
   * humans through this app, and every mutation path already calls
   * `invalidateQueries`, which marks data stale regardless of this value. So
   * writes still refresh immediately; only redundant background refetches stop.
   */
  staleTime: 60_000,

  /**
   * How long unused (unmounted) data stays in cache before garbage collection.
   *
   * Raised from the 5 min default to 10 min. This costs no extra requests — it
   * only decides how long an inactive entry is retained — and makes the common
   * navigate-away-and-back loop (orders list → order detail → back) instant.
   */
  gcTime: 10 * 60_000,

  /**
   * Retry once, not three times.
   *
   * Many failures here are terminal by construction: the server functions throw
   * `Forbidden: …` for permission checks, which will never succeed on retry. The
   * library default of 3 attempts with exponential backoff delayed those error
   * states by several seconds for no benefit. One retry still absorbs a transient
   * network blip.
   */
  retry: 1,

  /**
   * Do not refetch when the tab regains focus.
   *
   * This is the headline change. Alt-tabbing back to the Dashboard fired all
   * eleven aggregation queries; on Orders it re-ran the paginated query plus the
   * KPI RPC. None of this data changes without a user action in this app, and
   * every such action already invalidates.
   */
  refetchOnWindowFocus: false,

  /**
   * Do refetch after the network comes back — but only if the data is stale.
   *
   * Left enabled (the library default) because a reconnect is a genuine signal
   * that cached data may have drifted. Gated by `staleTime`, so a reconnect
   * within a minute of the last fetch is still a no-op.
   */
  refetchOnReconnect: true,

  /**
   * Do refetch on mount — but only if the data is stale.
   *
   * Left enabled (the library default). With `staleTime` at 60s this now means
   * "refetch when the user returns to a screen after a minute away", instead of
   * the old "refetch on every single navigation".
   */
  refetchOnMount: true,
} as const;

/**
 * Mutations are never retried automatically.
 *
 * This matches the library default and is stated explicitly because it is a
 * correctness property, not a tuning knob: every mutation in this app is a write
 * (order status, verification flag, profile, admin user management) and silently
 * replaying a write that may have partially succeeded is not acceptable.
 */
export const MUTATION_DEFAULTS = {
  retry: 0,
} as const;

/**
 * Builds the app's QueryClient. Called once per request on the server (so no
 * cache is shared across users) and once per page load in the browser.
 */
export function createAppQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { ...QUERY_DEFAULTS },
      mutations: { ...MUTATION_DEFAULTS },
    },
  });
}
