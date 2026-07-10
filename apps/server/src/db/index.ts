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
// Wait up to 5s for a competing writer instead of throwing SQLITE_BUSY: under
// WAL the server, the sync engine, and a `pnpm start` alongside `pnpm dev` can
// all hold the DB at once, and a locked moment shouldn't fail a request.
sqlite.pragma("busy_timeout = 5000");

// messages_fts is created below (if missing) by the DDL block. Checked here,
// before that DDL runs, so the one-time backfill further down only fires the
// first time the table appears — not on every boot.
const messagesFtsIsNew = !sqlite
  .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages_fts'")
  .get();

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
    cards TEXT,
    tool_calls TEXT,
    error TEXT,
    created_at TEXT NOT NULL
  );
  -- External-content FTS5 index over messages.content: the index itself stores
  -- no text, only a token->rowid mapping, and reads the row back from
  -- 'messages' by rowid on demand. Kept in sync by triggers rather than app
  -- code (contrast mail_fts/library_chunks, which are maintained by hand in
  -- mailStore.ts/store.ts) because messages are written from more than one
  -- place (routes/chat.ts and automations/scheduler.ts, both via
  -- agent/turnRecorder.ts) — a trigger fires no matter which of them writes.
  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content,
    content = 'messages',
    content_rowid = 'rowid',
    tokenize = 'unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
  END;
  CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  END;
  CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
    INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
  END;
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
  CREATE TABLE IF NOT EXISTS mail_threads (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    provider_thread_id TEXT NOT NULL,
    subject TEXT NOT NULL DEFAULT '',
    participants TEXT NOT NULL DEFAULT '[]',
    message_count INTEGER NOT NULL DEFAULT 0,
    last_message_at TEXT NOT NULL,
    has_unread INTEGER NOT NULL DEFAULT 0,
    last_from_me INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS mail_messages (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    provider_message_id TEXT NOT NULL,
    provider_thread_id TEXT NOT NULL,
    subject TEXT NOT NULL DEFAULT '',
    from_addr TEXT NOT NULL DEFAULT '',
    to_addrs TEXT NOT NULL DEFAULT '[]',
    cc_addrs TEXT NOT NULL DEFAULT '[]',
    date TEXT NOT NULL,
    snippet TEXT NOT NULL DEFAULT '',
    body_text TEXT NOT NULL DEFAULT '',
    is_from_me INTEGER NOT NULL DEFAULT 0,
    is_unread INTEGER NOT NULL DEFAULT 0,
    labels TEXT,
    synced_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS mail_sync_state (
    account_id TEXT PRIMARY KEY,
    cursor TEXT,
    status TEXT NOT NULL DEFAULT 'idle',
    error TEXT,
    last_synced_at TEXT
  );
  CREATE TABLE IF NOT EXISTS mail_thread_state (
    thread_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    gist TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    action_items TEXT NOT NULL DEFAULT '[]',
    triage TEXT NOT NULL DEFAULT 'fyi',
    urgency TEXT NOT NULL DEFAULT 'normal',
    deadline TEXT,
    model TEXT,
    error TEXT,
    enriched_at TEXT NOT NULL
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS mail_fts USING fts5(
    subject,
    body_text,
    from_addr,
    message_id UNINDEXED,
    tokenize = 'unicode61 remove_diacritics 2'
  );
  CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
  CREATE INDEX IF NOT EXISTS idx_runs_automation ON automation_runs(automation_id);
  CREATE INDEX IF NOT EXISTS idx_mail_threads_account ON mail_threads(account_id, last_message_at);
  CREATE INDEX IF NOT EXISTS idx_mail_messages_thread ON mail_messages(thread_id, date);
  CREATE INDEX IF NOT EXISTS idx_mail_messages_account ON mail_messages(account_id, date);
`);

if (messagesFtsIsNew) {
  // One-time backfill for a DB that already had messages before messages_fts
  // existed. Later writes stay in sync purely through the triggers above.
  sqlite.exec("INSERT INTO messages_fts(rowid, content) SELECT rowid, content FROM messages");
}

export const db = drizzle(sqlite, { schema });

/** True for SQLite's "column already exists" error — the only failure these ALTERs should swallow. */
function isDuplicateColumnError(error: unknown): boolean {
  return error instanceof Error && /duplicate column name/i.test(error.message);
}

/**
 * Add a column if the table predates it. Every column added here already
 * lives in the base CREATE TABLE above for a fresh DB — these are the
 * upgrade path for a database created before that column existed, so they
 * must stay even though they're now no-ops on a fresh install.
 */
function addColumn(table: string, columnDef: string): void {
  try {
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
  } catch (e) {
    // Ignore, column already exists; anything else means the schema is broken — fail boot loudly.
    if (!isDuplicateColumnError(e)) throw e;
  }
}

addColumn("conversations", "type TEXT NOT NULL DEFAULT 'chat'");
addColumn("automations", "show_in_activity INTEGER NOT NULL DEFAULT 1");
addColumn("automations", "pinned INTEGER NOT NULL DEFAULT 0");
addColumn("messages", "cards TEXT");
addColumn("messages", "tool_calls TEXT");
addColumn("messages", "error TEXT");
addColumn("memories", "account_id TEXT");
addColumn("automation_runs", "cards TEXT");

// Raw handle for the FTS5 table — drizzle can't address virtual tables.
export { sqlite, schema };
