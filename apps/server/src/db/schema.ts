import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const conversations = sqliteTable("conversations", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  type: text("type", { enum: ["chat", "automation"] }).notNull().default("chat"),
  createdAt: text("created_at").notNull(),
});

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull(),
  role: text("role", { enum: ["user", "assistant"] }).notNull(),
  content: text("content").notNull(),
  /** JSON-encoded MessageCard[] — the cards an assistant turn produced; null for none. */
  cards: text("cards"),
  /** JSON-encoded ChatToolCall[] for restoring tool activity in history. */
  toolCalls: text("tool_calls"),
  /** Turn-level agent/provider error, if the response ended unsuccessfully. */
  error: text("error"),
  createdAt: text("created_at").notNull(),
});

/**
 * Which conversation's turn created a draft (chat or automation run — run ids
 * are conversation ids too). Lets the Drafts list jump back into the chat
 * where a draft came from. Rows are never cleaned up: a stale link is filtered
 * out at read time by joining conversations, and drafts themselves live in
 * the mail account, not here.
 */
export const draftLinks = sqliteTable("draft_links", {
  draftId: text("draft_id").primaryKey(),
  accountId: text("account_id").notNull(),
  conversationId: text("conversation_id").notNull(),
  createdAt: text("created_at").notNull(),
});

export const automations = sqliteTable("automations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  instruction: text("instruction").notNull(),
  schedule: text("schedule").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  showInActivity: integer("show_in_activity", { mode: "boolean" }).notNull().default(true),
  pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const memories = sqliteTable("memories", {
  id: text("id").primaryKey(),
  content: text("content").notNull(),
  source: text("source", { enum: ["user", "agent"] }).notNull(),
  /** Connected-account id the fact is scoped to; null = applies everywhere. */
  accountId: text("account_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * One file of the document library. The searchable text lives in the
 * library_chunks FTS5 table (raw SQL — drizzle can't model virtual tables).
 */
export const libraryDocuments = sqliteTable("library_documents", {
  id: text("id").primaryKey(),
  path: text("path").notNull().unique(),
  title: text("title").notNull(),
  ext: text("ext").notNull(),
  size: integer("size").notNull(),
  mtimeMs: integer("mtime_ms").notNull(),
  status: text("status", { enum: ["indexed", "error"] }).notNull(),
  error: text("error"),
  chunkCount: integer("chunk_count").notNull().default(0),
  textLength: integer("text_length").notNull().default(0),
  indexedAt: text("indexed_at").notNull(),
});

/**
 * The mailbox mirror (email/sync/): Trailin's local copy of every synced
 * account's mail, fed by SyncProviders through the sync engine. Row ids are
 * deterministic — `${accountId}:${providerThreadId|providerMessageId}` — so
 * re-syncs upsert instead of duplicating. Thread rows are pure rollups
 * recomputed from mail_messages on every write; searchable text additionally
 * lives in the mail_fts FTS5 table (raw SQL, like library_chunks).
 */
export const mailThreads = sqliteTable("mail_threads", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerThreadId: text("provider_thread_id").notNull(),
  subject: text("subject").notNull().default(""),
  /** JSON-encoded string[] of distinct participants ("Name <addr>" form). */
  participants: text("participants").notNull().default("[]"),
  messageCount: integer("message_count").notNull().default(0),
  lastMessageAt: text("last_message_at").notNull(),
  hasUnread: integer("has_unread", { mode: "boolean" }).notNull().default(false),
  /** Whether the newest message in the thread was sent by this account. */
  lastFromMe: integer("last_from_me", { mode: "boolean" }).notNull().default(false),
  updatedAt: text("updated_at").notNull(),
});

export const mailMessages = sqliteTable("mail_messages", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  /** mail_threads.id (deterministic, so writable before the thread row exists). */
  threadId: text("thread_id").notNull(),
  providerMessageId: text("provider_message_id").notNull(),
  providerThreadId: text("provider_thread_id").notNull(),
  subject: text("subject").notNull().default(""),
  fromAddr: text("from_addr").notNull().default(""),
  /** JSON-encoded string[]. */
  toAddrs: text("to_addrs").notNull().default("[]"),
  /** JSON-encoded string[]. */
  ccAddrs: text("cc_addrs").notNull().default("[]"),
  date: text("date").notNull(),
  snippet: text("snippet").notNull().default(""),
  bodyText: text("body_text").notNull().default(""),
  isFromMe: integer("is_from_me", { mode: "boolean" }).notNull().default(false),
  isUnread: integer("is_unread", { mode: "boolean" }).notNull().default(false),
  /** JSON-encoded raw provider labels/folders; null when the provider has none. */
  labels: text("labels"),
  syncedAt: text("synced_at").notNull(),
});

/**
 * AI-derived state per mirrored thread (email/enrich/): gist, summary, triage.
 * `input_hash` covers the message ids the row was computed from — enrichment
 * recomputes only when the hash no longer matches the thread's messages, so a
 * pure unread flip never burns an LLM call. `enriched_at` is the SNAPSHOT
 * time (when the inputs were read, not when the call finished) so a message
 * arriving mid-call still flags the thread stale. Errors land in `error` with
 * the same timestamp, giving failed threads a natural retry backoff.
 */
export const mailThreadState = sqliteTable("mail_thread_state", {
  threadId: text("thread_id").primaryKey(),
  accountId: text("account_id").notNull(),
  inputHash: text("input_hash").notNull(),
  /** One sentence: what the thread says and what it wants. */
  gist: text("gist").notNull().default(""),
  /** 2-4 sentence summary. */
  summary: text("summary").notNull().default(""),
  /** JSON-encoded string[] of open action items. */
  actionItems: text("action_items").notNull().default("[]"),
  triage: text("triage", {
    enum: ["needs_reply", "needs_action", "waiting_on", "fyi", "done"],
  })
    .notNull()
    .default("fyi"),
  urgency: text("urgency", { enum: ["high", "normal", "low"] }).notNull().default("normal"),
  /** When it must be answered by, in the sender's own terms ("Friday 17:00"). */
  deadline: text("deadline"),
  /** Model id that produced this row; null for error rows. */
  model: text("model"),
  error: text("error"),
  enrichedAt: text("enriched_at").notNull(),
});

/** One row per synced account: the provider's opaque resume cursor + health. */
export const mailSyncState = sqliteTable("mail_sync_state", {
  accountId: text("account_id").primaryKey(),
  /** Opaque SyncProvider cursor; null = initial backfill not started/reset. */
  cursor: text("cursor"),
  status: text("status", { enum: ["idle", "syncing", "error"] }).notNull().default("idle"),
  error: text("error"),
  lastSyncedAt: text("last_synced_at"),
});

export const automationRuns = sqliteTable("automation_runs", {
  id: text("id").primaryKey(),
  automationId: text("automation_id").notNull(),
  status: text("status", { enum: ["running", "success", "error"] }).notNull(),
  result: text("result").notNull().default(""),
  /** JSON-encoded MessageCard[] — the cards the run's assistant turn produced; null for none. */
  cards: text("cards"),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
});
