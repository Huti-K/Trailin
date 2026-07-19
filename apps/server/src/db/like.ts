import { type SQLWrapper, sql } from "drizzle-orm";

/** Escape SQL LIKE wildcards in user input so a literal `%` or `_` can't widen the match. */
function escapeLikeInput(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** `column LIKE '%…%' ESCAPE '\'`; the pattern is pre-escaped by escapeLikeInput. */
export function likePattern(column: SQLWrapper, pattern: string) {
  return sql`${column} LIKE ${pattern} ESCAPE '\\'`;
}

/** `%<value>%` with LIKE wildcards escaped — the pattern likePattern's second argument expects. */
export function likeContains(value: string): string {
  return `%${escapeLikeInput(value)}%`;
}
