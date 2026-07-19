import { integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
  /** Display subject for the focused thread, so the chip needs no provider lookup. */
  focusThreadSubject: text("focus_thread_subject"),
  createdAt: text("created_at").notNull(),
});

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull(),
  role: text("role", { enum: ["user", "assistant", "compaction"] }).notNull(),
  content: text("content").notNull(),
  /** JSON-encoded MessageCard[] — the cards an assistant turn produced; null for none. */
  cards: text("cards"),
  /** JSON-encoded ChatToolCall[] — an assistant turn's tool activity, for the UI and the model-history rebuild. */
  toolCalls: text("tool_calls"),
  /** ms timestamp where a compaction row's kept-verbatim tail begins; compaction rows only. */
  compactionCutoff: integer("compaction_cutoff"),
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
 * as at creation, and the draft's fate.
 */
export const agentDrafts = sqliteTable(
  "agent_drafts",
  {
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
    status: text("status", { enum: ["open", "sent", "discarded"] })
      .notNull()
      .default("open"),
    /** Provider id of the sent message, when known (in-app sends record it exactly). */
    sentMessageId: text("sent_message_id"),
    /** Set once the learning loop has consumed this row; prevents double-learning. */
    learnedAt: text("learned_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [uniqueIndex("idx_agent_drafts_provider").on(table.accountId, table.providerDraftId)],
);

/**
 * Append-only body/subject history of an agent draft: version 1 is what the
 * create tool saved, later rows record in-app rewrites (author "agent") and
 * manual UI edits (author "user"). The learning loop diffs the sent text
 * against the last agent-authored version.
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
  /** Five-field cron, or "" for a manual-only automation (runs only on demand). */
  schedule: text("schedule").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  showInActivity: integer("show_in_activity", { mode: "boolean" }).notNull().default(true),
  pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
  /** Lead this automation belongs to (leads.id, deleted with it); null for standalone ones. */
  leadId: text("lead_id"),
  /** Also run immediately when the mail probe sees new inbound mail. */
  runOnNewMail: integer("run_on_new_mail", { mode: "boolean" }).notNull().default(false),
  /** Show a desktop notification when a run finishes. */
  notifyOnCompletion: integer("notify_on_completion", { mode: "boolean" }).notNull().default(false),
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
   * Normalized email address the fact is about; the third scope axis. A
   * memory is global, account-scoped, OR contact-scoped — contact-scoped
   * facts reach the agent when it works with that correspondent.
   */
  contactId: text("contact_id"),
  /** Times the agent reported relying on this entry (memory_used) — feeds the prune-candidate hints. */
  usedCount: integer("used_count").notNull().default(0),
  /** ISO timestamp of the most recent reported use; null until first used. */
  lastUsedAt: text("last_used_at"),
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
 * Proposed automations from the nightly suggestion sweep
 * (automations/suggestService.ts). Pending rows show on the Automations page
 * with accept/dismiss; decided rows stay (pruned to a recent window) as dedup
 * context so a later sweep doesn't re-suggest what the user already answered.
 */
export const automationSuggestions = sqliteTable("automation_suggestions", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  instruction: text("instruction").notNull(),
  schedule: text("schedule").notNull(),
  /** The recurring pattern the sweep saw — shown to the user as the "why". */
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
  /** JSON-encoded MessageCard[] — the cards the run's assistant turn produced; null for none. */
  cards: text("cards"),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
});

/**
 * An account's latest voice-learn attempt (db/voiceRuns.ts): the automatic
 * style analysis of its sent mail. One row per account, overwritten on
 * retry — "error" persists until a rerun succeeds, backing the retry
 * affordance on the Settings account rows.
 */
export const voiceLearnRuns = sqliteTable("voice_learn_runs", {
  accountId: text("account_id").primaryKey(),
  status: text("status", { enum: ["running", "ok", "error"] }).notNull(),
  error: text("error"),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
});

/**
 * The leads directory (db/leads.ts): one row per prospect, keyed by
 * normalized email address. Status tracks the lifecycle from first interest
 * to won/lost; the two last_*_at columns record the latest message in each
 * direction so follow-up automations can reason about who owes whom a reply.
 */
export const leads = sqliteTable("leads", {
  id: text("id").primaryKey(),
  name: text("name").notNull().default(""),
  email: text("email").notNull().unique(),
  phone: text("phone").notNull().default(""),
  /** Connected account the correspondence runs through; "" when unknown. */
  accountId: text("account_id").notNull().default(""),
  source: text("source", { enum: ["email", "manual", "onoffice"] })
    .notNull()
    .default("email"),
  /** Linked onOffice address record id, once the lead exists in the CRM. */
  onofficeAddressId: text("onoffice_address_id"),
  status: text("status", { enum: ["new", "contacted", "engaged", "qualified", "won", "lost"] })
    .notNull()
    .default("new"),
  interest: text("interest").notNull().default(""),
  /** Buyer type in a few words (e.g. "Kapitalanleger"); "" while unknown. */
  persona: text("persona").notNull().default(""),
  /** Estimated purchase likelihood; "" while unassessed. */
  score: text("score", { enum: ["high", "medium", "low", ""] })
    .notNull()
    .default(""),
  notes: text("notes").notNull().default(""),
  lastInboundAt: text("last_inbound_at"),
  lastOutboundAt: text("last_outbound_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * One completed draft-vs-sent learning sweep (db/learnRuns.ts): what
 * triggered it and what it found, pruned to the newest handful of rows —
 * the Knowledge page's learning-activity history.
 */
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
 * The WhatsApp mirror (whatsapp/store.ts): the paired personal account's
 * contacts, chats and messages, accumulated from the pairing history sync
 * and live socket events — the protocol pushes state instead of answering
 * queries, so anything not stored here is unreachable later. Text only;
 * media is kept as a bracketed marker. Wiped on unlink.
 */
export const waContacts = sqliteTable("wa_contacts", {
  jid: text("jid").primaryKey(),
  /** Address-book name on the user's phone; "" when unknown. */
  name: text("name").notNull().default(""),
  /** The contact's own push name; "" when unknown. */
  notify: text("notify").notNull().default(""),
  /** Digits only; "" when the jid carries no phone number (LID-only contact). */
  phoneNumber: text("phone_number").notNull().default(""),
  updatedAt: text("updated_at").notNull(),
});

export const waChats = sqliteTable("wa_chats", {
  jid: text("jid").primaryKey(),
  /** Subject for groups; usually "" for direct chats (the contact row names those). */
  name: text("name").notNull().default(""),
  lastMessageAt: text("last_message_at"),
  updatedAt: text("updated_at").notNull(),
});

export const waMessages = sqliteTable(
  "wa_messages",
  {
    chatJid: text("chat_jid").notNull(),
    /** Provider message id — unique per chat, not globally. */
    id: text("id").notNull(),
    /** The author's jid in group chats; "" in direct chats and for own messages. */
    senderJid: text("sender_jid").notNull().default(""),
    /** The author's push name as seen when the message arrived; "" when unknown. */
    senderName: text("sender_name").notNull().default(""),
    fromMe: integer("from_me").notNull().default(0),
    text: text("text").notNull(),
    timestamp: text("timestamp").notNull(),
  },
  (table) => [primaryKey({ columns: [table.chatJid, table.id] })],
);
