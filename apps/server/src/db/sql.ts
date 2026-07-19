/**
 * Column names are snake_case as in the schema; bind parameters are the
 * camelCase form, so call sites pass plain camelCase objects.
 */

function camelize(column: string): string {
  return column.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());
}

export interface UpsertSpec {
  table: string;
  /** Conflict target; also inserted, never updated. */
  conflict: readonly string[];
  /** Inserted on first write, left alone on conflict (identity columns). */
  insertOnly?: readonly string[];
  /** Inserted and overwritten from `excluded` on conflict. */
  update: readonly string[];
}

/** One INSERT … ON CONFLICT … DO UPDATE statement built from the spec. */
export function upsertSql(spec: UpsertSpec): string {
  const columns = [...spec.conflict, ...(spec.insertOnly ?? []), ...spec.update];
  const assignments = spec.update.map((c) => `${c} = excluded.${c}`).join(",\n    ");
  return `
  INSERT INTO ${spec.table} (${columns.join(", ")})
  VALUES (${columns.map((c) => `@${camelize(c)}`).join(", ")})
  ON CONFLICT(${spec.conflict.join(", ")}) DO UPDATE SET
    ${assignments}
`;
}

/**
 * Free text to an FTS5 MATCH expression: every term quoted, joined with AND or
 * OR; null when there are no searchable terms. Callers try AND first, then OR
 * for recall.
 */
export function buildFtsMatch(query: string, operator: "AND" | "OR"): string | null {
  const terms = query.match(/[\p{L}\p{N}]+/gu)?.slice(0, 12);
  if (!terms || terms.length === 0) return null;
  return terms.map((t) => `"${t}"`).join(operator === "AND" ? " " : " OR ");
}
