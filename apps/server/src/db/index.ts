import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { env } from "../env.js";
import * as schema from "./schema.js";

const dbPath = resolve(process.cwd(), env.databasePath);
mkdirSync(dirname(dbPath), { recursive: true });

const sqlite = new Database(dbPath);
sqlite.pragma("journal_mode = WAL");

// Keep bootstrap simple for now: idempotent DDL instead of a migration toolchain.
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'chat',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS automations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    instruction TEXT NOT NULL,
    schedule TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    show_in_activity INTEGER NOT NULL DEFAULT 1,
    pinned INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS automation_runs (
    id TEXT PRIMARY KEY,
    automation_id TEXT NOT NULL,
    status TEXT NOT NULL,
    result TEXT NOT NULL DEFAULT '',
    cards TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    source TEXT NOT NULL,
    account_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS library_documents (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    ext TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime_ms INTEGER NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    chunk_count INTEGER NOT NULL DEFAULT 0,
    text_length INTEGER NOT NULL DEFAULT 0,
    indexed_at TEXT NOT NULL
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS library_chunks USING fts5(
    content,
    doc_id UNINDEXED,
    seq UNINDEXED,
    tokenize = 'unicode61 remove_diacritics 2'
  );
  CREATE TABLE IF NOT EXISTS draft_links (
    draft_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
  CREATE INDEX IF NOT EXISTS idx_runs_automation ON automation_runs(automation_id);
`);

export const db = drizzle(sqlite, { schema });

/** True for SQLite's "column already exists" error — the only failure these ALTERs should swallow. */
function isDuplicateColumnError(error: unknown): boolean {
  return error instanceof Error && /duplicate column name/i.test(error.message);
}

try {
  sqlite.exec("ALTER TABLE conversations ADD COLUMN type TEXT NOT NULL DEFAULT 'chat'");
} catch (e) {
  // Ignore, column already exists; anything else means the schema is broken — fail boot loudly.
  if (!isDuplicateColumnError(e)) throw e;
}

try {
  sqlite.exec("ALTER TABLE automations ADD COLUMN show_in_activity INTEGER NOT NULL DEFAULT 1");
} catch (e) {
  if (!isDuplicateColumnError(e)) throw e;
}

try {
  sqlite.exec("ALTER TABLE automations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
} catch (e) {
  if (!isDuplicateColumnError(e)) throw e;
}

try {
  sqlite.exec("ALTER TABLE messages ADD COLUMN cards TEXT");
} catch (e) {
  if (!isDuplicateColumnError(e)) throw e;
}

try {
  sqlite.exec("ALTER TABLE messages ADD COLUMN tool_calls TEXT");
} catch (e) {
  if (!isDuplicateColumnError(e)) throw e;
}

try {
  sqlite.exec("ALTER TABLE messages ADD COLUMN error TEXT");
} catch (e) {
  if (!isDuplicateColumnError(e)) throw e;
}

try {
  sqlite.exec("ALTER TABLE memories ADD COLUMN account_id TEXT");
} catch (e) {
  if (!isDuplicateColumnError(e)) throw e;
}

try {
  sqlite.exec("ALTER TABLE automation_runs ADD COLUMN cards TEXT");
} catch (e) {
  if (!isDuplicateColumnError(e)) throw e;
}

// Raw handle for the FTS5 table — drizzle can't address virtual tables.
export { sqlite, schema };
