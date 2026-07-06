// Paginated fetch helper for Supabase/PostgREST queries.
//
// PostgREST caps a single request at 1000 rows by default. This helper
// repeatedly calls `.range(offset, offset+PAGE-1)` on a freshly built query
// until a short page is returned, then concatenates the results.
//
// Usage:
//   const rows = await fetchAllPaginated(() =>
//     supabase.from("orders").select("*").gte("order_date", from).lte("order_date", to)
//   );
//
// The `build` factory must return a NEW query builder each call — Supabase
// builders are single-shot (awaiting one consumes it).

export const SUPABASE_PAGE_SIZE = 1000;

export async function fetchAllPaginated<T>(
  build: () => any,
  pageSize: number = SUPABASE_PAGE_SIZE,
): Promise<T[]> {
  const all: T[] = [];
  let offset = 0;
  // Safety cap to avoid runaway loops (200k rows).
  const MAX_ROWS = 200_000;
  while (offset < MAX_ROWS) {
    const { data, error } = await build().range(offset, offset + pageSize - 1);
    if (error) throw error;
    const rows = (data ?? []) as T[];
    all.push(...rows);
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}
