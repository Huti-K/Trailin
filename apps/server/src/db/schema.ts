import { integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const conversations = sqliteTable("conversations", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  type: text("type", { enum: ["chat", "automation"] })
    .notNull()
    .default("chat"),
  /** Account/thread this chat works in; last writer wins. Null = no focus ("all accounts"). */
  focusAccountId: text("focus_account_id"),
  focusThreadId: text("focus_thread_id"),
  focusThreadSubject: text("focus_thread_subject"),
  createdAt: text("created_at").notNull(),
});

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull(),
  role: text("role", { enum: ["user", "assistant", "compaction"] }).notNull(),
  content: text("content").notNull(),
  cards: text("cards"),
  toolCalls: text("tool_calls"),
  /** ms timestamp where the kept-verbatim tail begins; compaction rows only. */
  compactionCutoff: integer("compaction_cutoff"),
  error: text("error"),
  refs: text("refs"),
  createdAt: text("created_at").notNull(),
});

/**
 * Snapshots of agent-written drafts; the provider stays source of truth for
 * the live drafts list. These rows exist for the draft-vs-sent learning loop
 * and navigation, surviving after the provider draft is edited/sent/deleted.
 * Body text lives in agent_draft_versions.
 */
export const agentDrafts = sqliteTable(
  "agent_drafts",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerDraftId: text("provider_draft_id").notNull(),
    providerMessageId: text("provider_message_id"),
    threadId: text("thread_id"),
    conversationId: text("conversation_id"),
    subject: text("subject").notNull().default(""),
    toAddrs: text("to_addrs").notNull().default("[]"),
    ccAddrs: text("cc_addrs").notNull().default("[]"),
    bccAddrs: text("bcc_addrs").notNull().default("[]"),
    status: text("status", { enum: ["open", "sent", "discarded"] })
      .notNull()
      .default("open"),
    sentMessageId: text("sent_message_id"),
    /** Set once the learning loop consumed this row; prevents double-learning. */
    learnedAt: text("learned_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [uniqueIndex("idx_agent_drafts_provider").on(table.accountId, table.providerDraftId)],
);

/**
 * Append-only body/subject history of an agent draft: version 1 is the created
 * draft, later rows are in-app rewrites (author "agent") or UI edits (author
 * "user"). The learning loop diffs sent text against the last agent version.
 */
export const agentDraftVersions = sqliteTable(
  "agent_draft_versions",
  {
    draftId: text("draft_id").notNull(),
    version: integer("version").notNull(),
    author: text("author", { enum: ["agent", "user"] }).notNull(),
    subject: text("subject").notNull().default(""),
    body: text("body").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.draftId, table.version] })],
);

export const automations = sqliteTable("automations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  instruction: text("instruction").notNull(),
  /** Five-field cron, or "" for manual-only (on-demand). */
  schedule: text("schedule").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  showInActivity: integer("show_in_activity", { mode: "boolean" }).notNull().default(true),
  pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
  /** leads.id this belongs to, deleted with the lead; null for standalone. */
  leadId: text("lead_id"),
  runOnNewMail: integer("run_on_new_mail", { mode: "boolean" }).notNull().default(false),
  notifyOnCompletion: integer("notify_on_completion", { mode: "boolean" }).notNull().default(false),
  /** Manual sort key, ascending; new automations get -now so they land on top. */
  position: real("position").notNull().default(0),
  createdAt: text("created_at").notNull(),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

// Long-term memories are NOT here: they live as markdown files in the agent
// home (memories/store.ts). The shipped base schema still creates a
// `memories` table on a fresh db; home/migrate.ts drops it at boot.

/** Searchable text lives in the library_chunks FTS5 table, not here (drizzle can't model virtual tables). */
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
 * Proposed automations from the nightly suggestion sweep. Decided rows stay
 * (pruned to a recent window) as dedup context so a later sweep doesn't
 * re-suggest what the user already answered.
 */
export const automationSuggestions = sqliteTable("automation_suggestions", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  instruction: text("instruction").notNull(),
  schedule: text("schedule").notNull(),
  rationale: text("rationale").notNull(),
  status: text("status", { enum: ["pending", "accepted", "dismissed"] })
    .notNull()
    .default("pending"),
  createdAt: text("created_at").notNull(),
  decidedAt: text("decided_at"),
});

export const automationRuns = sqliteTable("automation_runs", {
  id: text("id").primaryKey(),
  automationId: text("automation_id").notNull(),
  status: text("status", { enum: ["running", "success", "error"] }).notNull(),
  result: text("result").notNull().default(""),
  cards: text("cards"),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
});

/** One row per account (latest attempt, overwritten on retry); an "error" row persists until a rerun succeeds. */
export const voiceLearnRuns = sqliteTable("voice_learn_runs", {
  accountId: text("account_id").primaryKey(),
  status: text("status", { enum: ["running", "ok", "error"] }).notNull(),
  error: text("error"),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
});

/** One row per prospect, keyed by normalized email address. */
export const leads = sqliteTable("leads", {
  id: text("id").primaryKey(),
  name: text("name").notNull().default(""),
  email: text("email").notNull().unique(),
  phone: text("phone").notNull().default(""),
  accountId: text("account_id").notNull().default(""),
  source: text("source", { enum: ["email", "manual", "onoffice"] })
    .notNull()
    .default("email"),
  onofficeAddressId: text("onoffice_address_id"),
  status: text("status", { enum: ["new", "contacted", "engaged", "qualified", "won", "lost"] })
    .notNull()
    .default("new"),
  interest: text("interest").notNull().default(""),
  persona: text("persona").notNull().default(""),
  priority: text("priority", { enum: ["A", "B", "C", ""] })
    .notNull()
    .default(""),
  language: text("language").notNull().default(""),
  notes: text("notes").notNull().default(""),
  lastInboundAt: text("last_inbound_at"),
  lastOutboundAt: text("last_outbound_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** Pending outbound messages for comm channels without a native provider draft (WhatsApp). */
export const outboundDrafts = sqliteTable("outbound_drafts", {
  id: text("id").primaryKey(),
  channel: text("channel").notNull(),
  /** Channel-native recipient (a WhatsApp jid). */
  target: text("target").notNull(),
  targetLabel: text("target_label").notNull().default(""),
  body: text("body").notNull(),
  status: text("status", { enum: ["open", "sent", "discarded"] })
    .notNull()
    .default("open"),
  sentRef: text("sent_ref"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * A human-attention item the agent surfaces and maintains — you must do or
 * decide this. dedupe_key ("" for ad-hoc) makes a repeating run's create
 * idempotent so it upserts one todo, not many.
 */
export const todos = sqliteTable("todos", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  status: text("status", { enum: ["open", "done", "dismissed"] })
    .notNull()
    .default("open"),
  /** When the user should act; null = undated. The home agenda's sort/group key. */
  dueAt: text("due_at"),
  /** Manual sort key within an agenda group (drag-and-drop); seeded from creation time. */
  position: real("position").notNull().default(0),
  conversationId: text("conversation_id"),
  /** Automation run when this todo completes (open→done); null = none. */
  linkedAutomationId: text("linked_automation_id"),
  dedupeKey: text("dedupe_key").notNull().default(""),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const learnRuns = sqliteTable("learn_runs", {
  id: text("id").primaryKey(),
  reason: text("reason", { enum: ["boot", "scheduled"] }).notNull(),
  status: text("status", { enum: ["ok", "error"] }).notNull(),
  matched: integer("matched").notNull().default(0),
  pending: integer("pending").notNull().default(0),
  identical: integer("identical").notNull().default(0),
  learned: integer("learned").notNull().default(0),
  lessons: integer("lessons").notNull().default(0),
  error: text("error"),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at").notNull(),
});

/**
 * The WhatsApp mirror of the paired account's contacts/chats/messages. The
 * protocol pushes state instead of answering queries, so anything not stored
 * here is unreachable later. Text only (media as a bracketed marker); wiped on unlink.
 */
export const waContacts = sqliteTable("wa_contacts", {
  jid: text("jid").primaryKey(),
  name: text("name").notNull().default(""),
  /** The contact's own push name. */
  notify: text("notify").notNull().default(""),
  /** Digits only; "" for a LID-only contact (jid carries no phone number). */
  phoneNumber: text("phone_number").notNull().default(""),
  updatedAt: text("updated_at").notNull(),
});

export const waChats = sqliteTable("wa_chats", {
  jid: text("jid").primaryKey(),
  /** Subject for groups; "" for direct chats (named by the contact row). */
  name: text("name").notNull().default(""),
  lastMessageAt: text("last_message_at"),
  updatedAt: text("updated_at").notNull(),
});

export const waMessages = sqliteTable(
  "wa_messages",
  {
    chatJid: text("chat_jid").notNull(),
    /** Unique per chat, not globally (hence the composite primary key). */
    id: text("id").notNull(),
    /** Author's jid in group chats; "" in direct chats and for own messages. */
    senderJid: text("sender_jid").notNull().default(""),
    senderName: text("sender_name").notNull().default(""),
    fromMe: integer("from_me").notNull().default(0),
    text: text("text").notNull(),
    timestamp: text("timestamp").notNull(),
  },
  (table) => [primaryKey({ columns: [table.chatJid, table.id] })],
);
