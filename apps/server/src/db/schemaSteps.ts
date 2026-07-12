/**
 * Numbered schema steps, applied in order against `PRAGMA user_version` by
 * db/index.ts: a database at version N gets steps N+1..length, each in its
 * own transaction. Append a new step to change the schema — never edit a
 * shipped one, since databases past it will not re-run it.
 *
 * Step 1 uses IF NOT EXISTS throughout so it can adopt a database whose
 * tables already exist but whose user_version is still 0; later steps are
 * plain DDL. There is deliberately no downgrade or data-upgrade path (dev
 * policy): when a step can't express a change, delete data/trailin.db* and
 * let boot recreate it.
 */
export const SCHEMA_STEPS: readonly string[] = [
  // 1: full base schema — chat, automations, settings, memories, library,
  // draft links, and the mailbox mirror (mail_* + FTS).
  `
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
  `,
  // 2: messages.refs — emails the user pinned to a chat message (composer @-mentions).
  `
    ALTER TABLE messages ADD COLUMN refs TEXT;
  `,
  // 3: mail_threads lookup/ordering indexes — provider_thread_id backs
  // getThreadDetail's by-provider-id lookup (mailQuery.ts); last_message_at
  // lets enrichStore's staleness query scan threads in newest-first order
  // instead of building a temporary sort on every cycle.
  `
    CREATE INDEX IF NOT EXISTS idx_mail_threads_provider_thread_id ON mail_threads(provider_thread_id);
    CREATE INDEX IF NOT EXISTS idx_mail_threads_last_message_at ON mail_threads(last_message_at);
  `,
  // 4: agent-draft snapshots (agent_drafts + agent_draft_versions, replacing
  // draft_links — conversation_id lives on the snapshot row now) and
  // List-Unsubscribe capture on mirrored messages.
  `
    DROP TABLE IF EXISTS draft_links;
    CREATE TABLE agent_drafts (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      provider_draft_id TEXT NOT NULL,
      provider_message_id TEXT,
      thread_id TEXT,
      conversation_id TEXT,
      subject TEXT NOT NULL DEFAULT '',
      to_addrs TEXT NOT NULL DEFAULT '[]',
      cc_addrs TEXT NOT NULL DEFAULT '[]',
      bcc_addrs TEXT NOT NULL DEFAULT '[]',
      signature TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      sent_message_id TEXT,
      learned_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX idx_agent_drafts_provider ON agent_drafts(account_id, provider_draft_id);
    CREATE INDEX idx_agent_drafts_status ON agent_drafts(status);
    CREATE TABLE agent_draft_versions (
      draft_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      author TEXT NOT NULL,
      subject TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (draft_id, version)
    );
    ALTER TABLE mail_messages ADD COLUMN list_unsubscribe TEXT;
    ALTER TABLE mail_messages ADD COLUMN list_unsubscribe_post INTEGER;
  `,
  // 5: conversation focus (account + current thread, last writer wins) and
  // the two Home-lane judgments: enrichment's awaiting_reply verdict and the
  // hash-tied dismissal for the "waiting on you" lane.
  `
    ALTER TABLE conversations ADD COLUMN focus_account_id TEXT;
    ALTER TABLE conversations ADD COLUMN focus_thread_id TEXT;
    ALTER TABLE conversations ADD COLUMN focus_thread_subject TEXT;
    ALTER TABLE mail_thread_state ADD COLUMN awaiting_reply INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE mail_thread_state ADD COLUMN dismissed_hash TEXT;
  `,
  // 6: contacts (one row per correspondent address, kind person|bulk) and the
  // contact scope on memories.
  `
    CREATE TABLE contacts (
      address TEXT PRIMARY KEY,
      display_name TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'person',
      category TEXT NOT NULL DEFAULT 'other',
      category_source TEXT NOT NULL DEFAULT 'auto',
      gist TEXT NOT NULL DEFAULT '',
      accounts TEXT NOT NULL DEFAULT '[]',
      message_count INTEGER NOT NULL DEFAULT 0,
      sent_count INTEGER NOT NULL DEFAULT 0,
      last_contact_at TEXT NOT NULL DEFAULT '',
      input_hash TEXT NOT NULL DEFAULT '',
      model TEXT,
      error TEXT,
      enriched_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX idx_contacts_kind ON contacts(kind, last_contact_at);
    ALTER TABLE memories ADD COLUMN contact_id TEXT;
  `,
  // 7: persistent record of a successful one-click unsubscribe request per
  // bulk sender — the Newsletters lane renders "requested" from this instead
  // of re-offering the button after a reload.
  `
    ALTER TABLE contacts ADD COLUMN unsubscribe_requested_at TEXT;
  `,
];
