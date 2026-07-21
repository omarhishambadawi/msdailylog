/**
 * Free-text search helpers for MCP tools.
 *
 * PostgREST builds `or=(...)` filters from a raw string, so any `,` `.` `(`
 * `)` `%` or `*` in a user-supplied term is parsed as filter syntax rather
 * than data. An unsanitised term lets a caller rewrite the filter tree.
 * RLS still bounds which rows are visible, but the filter itself must not be
 * attacker-controlled. Mirrors normalizeSearchTerm() in the orders route.
 */
export function normalizeSearchTerm(value: string): string {
  return value
    .replace(/[,%.*()]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

/** Build an `.or()` filter string matching `term` across `columns`. */
export function buildSearchOr(term: string, columns: string[]): string {
  const t = `%${term}%`;
  return columns.map((c) => `${c}.ilike.${t}`).join(",");
}
