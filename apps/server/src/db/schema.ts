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
