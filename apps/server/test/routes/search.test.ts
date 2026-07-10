import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// db/index.ts (pulled in transitively by routes/search.ts) runs its DDL as an
// import-time side effect and resolves its path through env.ts's
// DATABASE_PATH read, also at import time — so, same as
// test/agent/turnRecorder.test.ts, point DATABASE_PATH at a fresh temp file
// before anything imports search.ts, rather than let it touch the real DB.
const tempDir = mkdtempSync(join(tmpdir(), "trailin-search-"));
const originalDatabasePath = process.env.DATABASE_PATH;
process.env.DATABASE_PATH = join(tempDir, "test.db");

const { buildMessagesMatch } = await import("../../src/routes/search.js");
const { sqlite } = await import("../../src/db/index.js");

afterAll(() => {
  sqlite.close();
  rmSync(tempDir, { recursive: true, force: true });
  if (originalDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = originalDatabasePath;
});

describe("buildMessagesMatch", () => {
  it("double-quotes every term so FTS5 query syntax in the input can't break the MATCH expression", () => {
    expect(buildMessagesMatch('flight "tomorrow" -refund*')).toBe('"flight" "tomorrow" "refund"');
  });

  it("returns null for a query with no word/number characters to search on", () => {
    expect(buildMessagesMatch("   ")).toBeNull();
    expect(buildMessagesMatch("***")).toBeNull();
  });

  it("is usable as a real FTS5 MATCH expression against the live messages_fts table", () => {
    const match = buildMessagesMatch("hello world");
    expect(match).toBe('"hello" "world"');
    // messages_fts is external-content over `messages` — MATCH must not throw
    // even against an empty table, and an empty table must yield no rows.
    const rows = sqlite.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?").all(match);
    expect(rows).toHaveLength(0);
  });

  it("caps at 12 terms", () => {
    const query = Array.from({ length: 20 }, (_, i) => `term${i}`).join(" ");
    expect(buildMessagesMatch(query)?.split(" ")).toHaveLength(12);
  });
});
