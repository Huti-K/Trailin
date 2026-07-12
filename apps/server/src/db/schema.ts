import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const conversations = sqliteTable("conversations", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  type: text("type", { enum: ["chat", "automation"] })
    .notNull()
    .default("chat"),
  /**
   * Conversation focus: the account (and, while one email is the topic, the
   * thread) this chat works in. Last writer wins — a manual pick from the
   * chip, an @-mention ref, or the agent's own tool activity all move it;
   * null = no focus yet ("all accounts").
   */
  focusAccountId: text("focus_account_id"),
  focusThreadId: text("focus_thread_id"),
  /** Display subject for the focused thread, so the chip needs no mirror lookup. */
  focusThreadSubject: text("focus_thread_subject"),
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
  /** JSON-encoded EmailRef[] — emails the user pinned to this message; null for none. */
  refs: text("refs"),
  createdAt: text("created_at").notNull(),
});

/**
 * Snapshot of every agent-written draft (db/draftStore.ts): what the agent
 * composed survives here even after the provider draft is edited, sent, or
 * deleted — the provider stays source of truth for the live drafts list; these
 * rows exist for the draft-vs-sent learning loop and for navigation
 * (conversation_id lets the Drafts list reopen the chat that wrote a draft).
 * Body text lives in agent_draft_versions; the row keeps identity, recipients
 * as at creation, the account signature at compose time (so diffs can strip
 * it), and the draft's fate.
 */
export const agentDrafts = sqliteTable("agent_drafts", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerDraftId: text("provider_draft_id").notNull(),
  providerMessageId: text("provider_message_id"),
  /** Provider thread id the draft replies to; null for standalone drafts. */
  threadId: text("thread_id"),
  /** Chat/automation conversation whose turn created the draft; null until linked. */
  conversationId: text("conversation_id"),
  subject: text("subject").notNull().default(""),
  /** JSON-encoded string[]. */
  toAddrs: text("to_addrs").notNull().default("[]"),
  /** JSON-encoded string[]. */
  ccAddrs: text("cc_addrs").notNull().default("[]"),
  /** JSON-encoded string[]. */
  bccAddrs: text("bcc_addrs").notNull().default("[]"),
  /** The account's configured signature at compose time; null when none. */
  signature: text("signature"),
  status: text("status", { enum: ["open", "sent", "discarded"] })
    .notNull()
    .default("open"),
  /** Provider id of the sent message, when known (in-app sends record it exactly). */
  sentMessageId: text("sent_message_id"),
  /** Set once the learning loop has consumed this row; prevents double-learning. */
  learnedAt: text("learned_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * Append-only body/subject history of an agent draft: version 1 is what the
 * create tool saved, later rows record in-app rewrites (author "agent") and
 * manual UI edits (author "user"). The learning loop diffs the sent text
 * against the last agent-authored version.
 */
export const agentDraftVersions = sqliteTable("agent_draft_versions", {
  draftId: text("draft_id").notNull(),
  version: integer("version").notNull(),
  author: text("author", { enum: ["agent", "user"] }).notNull(),
  subject: text("subject").notNull().default(""),
  body: text("body").notNull(),
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
  /**
   * Contact (contacts.address) the fact is about; the third scope axis. A
   * memory is global, account-scoped, OR contact-scoped — contact-scoped
   * facts reach the agent when it works with that correspondent.
   */
  contactId: text("contact_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * People and lists derived from the mail mirror (email/contacts/): one row
 * per correspondent address — never per person; a person with two addresses
 * is two rows, by design. `kind` separates real correspondents ("person",
 * the Contacts page's People lane) from bulk/newsletter senders ("bulk", the
 * Newsletters lane) — judged by the enrichment LLM with heuristics only as
 * priors. Aggregates are recomputed from the mirror (rows are re-derivable);
 * category/gist/kind refresh enrichment-style via input_hash staleness.
 * `category_source` = "user" pins a manual category override against the job.
 */
export const contacts = sqliteTable("contacts", {
  /** Normalized (lowercased) email address — the contact's identity. */
  address: text("address").primaryKey(),
  displayName: text("display_name").notNull().default(""),
  kind: text("kind", { enum: ["person", "bulk"] })
    .notNull()
    .default("person"),
  category: text("category", {
    enum: ["colleague", "client_business", "personal", "service_vendor", "other"],
  })
    .notNull()
    .default("other"),
  categorySource: text("category_source", { enum: ["auto", "user"] })
    .notNull()
    .default("auto"),
  /** One LLM-written relationship line ("your accountant; formal tone"). */
  gist: text("gist").notNull().default(""),
  /** JSON-encoded string[] of connected-account ids this address corresponds on. */
  accounts: text("accounts").notNull().default("[]"),
  messageCount: integer("message_count").notNull().default(0),
  /** Messages the user sent to this address. */
  sentCount: integer("sent_count").notNull().default(0),
  lastContactAt: text("last_contact_at").notNull().default(""),
  /** Staleness key over the address's recent message ids (see thread enrichment). */
  inputHash: text("input_hash").notNull().default(""),
  /**
   * When a one-click unsubscribe was successfully requested for this (bulk)
   * sender — persisted so the Newsletters lane keeps showing "requested"
   * across reloads instead of offering the button again. Senders may take
   * days to honor it; mail arriving after this stamp is expected.
   */
  unsubscribeRequestedAt: text("unsubscribe_requested_at"),
  model: text("model"),
  error: text("error"),
  enrichedAt: text("enriched_at"),
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
  /** Raw List-Unsubscribe header value; null = not captured or absent. */
  listUnsubscribe: text("list_unsubscribe"),
  /** RFC 8058 one-click support (List-Unsubscribe-Post present); null = unknown. */
  listUnsubscribePost: integer("list_unsubscribe_post", { mode: "boolean" }),
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
  urgency: text("urgency", { enum: ["high", "normal", "low"] })
    .notNull()
    .default("normal"),
  /** When it must be answered by, in the sender's own terms ("Friday 17:00"). */
  deadline: text("deadline"),
  /**
   * Enrichment's judgment that the thread's last message is from this account
   * AND still expects a counterpart response — what the Home "waiting on
   * others" lane is built from (the time window is only an outer bound).
   */
  awaitingReply: integer("awaiting_reply", { mode: "boolean" }).notNull().default(false),
  /**
   * The input_hash at the moment the user dismissed this thread from the
   * "waiting on you" lane. A new inbound message changes the thread's
   * input_hash, so a genuinely revived thread resurfaces while a dismissed
   * one stays gone — the filter compares this against the current hash.
   */
  dismissedHash: text("dismissed_hash"),
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
  status: text("status", { enum: ["idle", "syncing", "error"] })
    .notNull()
    .default("idle"),
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
