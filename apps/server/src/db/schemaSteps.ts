/**
 * Numbered schema steps applied in order against PRAGMA user_version by
 * db/index.ts: a database at version N gets steps N+1..length, each in its own
 * transaction. Append to change the schema; never edit a shipped step, since
 * databases past it will not re-run it. A step brings existing data
 * forward, never destroying it (no DROP or lossy rewrite without copying into the
 * new shape). Step 1 uses IF NOT EXISTS so it can adopt pre-existing tables at
 * user_version 0. No downgrade path: db/index.ts refuses a newer database.
 */
export const SCHEMA_STEPS: readonly string[] = [
  // 1: base schema (chat, automations, settings, memories, library, draft links, mailbox mirror).
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
    -- External-content FTS5 over messages.content: stores only a token->rowid map,
    -- reading the row back from 'messages' on demand. Maintained by triggers, not
    -- app code, because messages are written from more than one place, so a trigger
    -- fires no matter which writer runs.
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
  // 2: messages.refs (emails pinned to a chat message via composer @-mentions).
  `
    ALTER TABLE messages ADD COLUMN refs TEXT;
  `,
  // 3: mail_threads indexes. provider_thread_id backs getThreadDetail's lookup;
  // last_message_at lets enrichStore scan newest-first without a temp sort.
  `
    CREATE INDEX IF NOT EXISTS idx_mail_threads_provider_thread_id ON mail_threads(provider_thread_id);
    CREATE INDEX IF NOT EXISTS idx_mail_threads_last_message_at ON mail_threads(last_message_at);
  `,
  // 4: agent-draft snapshots (agent_drafts + agent_draft_versions) replace
  // draft_links; conversation_id now lives on the snapshot row. Plus
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
  // 5: conversation focus (account + thread, last writer wins) plus the
  // awaiting_reply verdict and dismissed_hash for the Home "waiting on you" lane.
  `
    ALTER TABLE conversations ADD COLUMN focus_account_id TEXT;
    ALTER TABLE conversations ADD COLUMN focus_thread_id TEXT;
    ALTER TABLE conversations ADD COLUMN focus_thread_subject TEXT;
    ALTER TABLE mail_thread_state ADD COLUMN awaiting_reply INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE mail_thread_state ADD COLUMN dismissed_hash TEXT;
  `,
  // 6: contacts (one row per correspondent address) and memories.contact_id scope.
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
  // 7: unsubscribe_requested_at persists a one-click unsubscribe per bulk
  // sender so the Newsletters lane renders "requested" across reloads.
  `
    ALTER TABLE contacts ADD COLUMN unsubscribe_requested_at TEXT;
  `,
  // 8: per-memory usage tracking (used_count, last_used_at).
  `
    ALTER TABLE memories ADD COLUMN used_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE memories ADD COLUMN last_used_at TEXT;
  `,
  // 9: manual contact overrides. display_name_override wins over the derived
  // display_name and survives re-derivation (which writes only the derived
  // column). hidden_at is a soft delete: the row is kept but filtered out, and
  // re-derivation never resurrects it.
  `
    ALTER TABLE contacts ADD COLUMN display_name_override TEXT;
    ALTER TABLE contacts ADD COLUMN hidden_at TEXT;
  `,
  // 10: drop the mailbox mirror and contacts directory. Mail is now read live
  // from providers, so nothing populates or reads these tables. Dropping the
  // FTS5 table removes its shadow tables. memories.contact_id stays: contact-
  // scoped memories key on the normalized address itself.
  `
    DROP TABLE IF EXISTS mail_fts;
    DROP TABLE IF EXISTS mail_messages;
    DROP TABLE IF EXISTS mail_threads;
    DROP TABLE IF EXISTS mail_thread_state;
    DROP TABLE IF EXISTS mail_sync_state;
    DROP TABLE IF EXISTS contacts;
    DELETE FROM settings WHERE key IN ('sync.backfillDays', 'contacts.recentThreadsLimit');
  `,
  // 11: learn_runs, one row per draft-vs-sent sweep (pruned to a recent window).
  `
    CREATE TABLE learn_runs (
      id TEXT PRIMARY KEY,
      reason TEXT NOT NULL,
      status TEXT NOT NULL,
      matched INTEGER NOT NULL DEFAULT 0,
      pending INTEGER NOT NULL DEFAULT 0,
      identical INTEGER NOT NULL DEFAULT 0,
      learned INTEGER NOT NULL DEFAULT 0,
      lessons INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL
    );
  `,
  // 12: voice_learn_runs, latest style-analysis attempt per account, so a
  // failed or skipped learn stays visible and retryable.
  `
    CREATE TABLE voice_learn_runs (
      account_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      error TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );
  `,
  // 13: automation_suggestions. Pending rows await accept/dismiss; decided
  // rows remain as dedup context for later sweeps.
  `
    CREATE TABLE automation_suggestions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      instruction TEXT NOT NULL,
      schedule TEXT NOT NULL,
      rationale TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      decided_at TEXT
    );
  `,
  // 14: leads directory (one row per prospect, keyed by normalized email) plus
  // automations.lead_id (a lead's follow-ups are deleted with it). The old
  // defaultsSeeded settings row goes, superseded by per-default seed flags.
  `
    CREATE TABLE leads (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      account_id TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'email',
      onoffice_address_id TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      interest TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      last_inbound_at TEXT,
      last_outbound_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX idx_leads_email ON leads(email);
    CREATE INDEX idx_leads_status ON leads(status, updated_at);
    ALTER TABLE automations ADD COLUMN lead_id TEXT;
    DELETE FROM settings WHERE key = 'automations.defaultsSeeded';
  `,
  // 15: lead qualification: persona and score (high/medium/low, '' unassessed).
  `
    ALTER TABLE leads ADD COLUMN persona TEXT NOT NULL DEFAULT '';
    ALTER TABLE leads ADD COLUMN score TEXT NOT NULL DEFAULT '';
  `,
  // 16: per-automation triggers beyond cron (run_on_new_mail, notify_on_completion).
  // The UPDATE arms both on the Lead-Eingang default for existing installs; the
  // flags are visible in the UI, so a false name match is user-correctable.
  `
    ALTER TABLE automations ADD COLUMN run_on_new_mail INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE automations ADD COLUMN notify_on_completion INTEGER NOT NULL DEFAULT 0;
    UPDATE automations SET run_on_new_mail = 1, notify_on_completion = 1 WHERE name = 'Lead-Eingang';
  `,
  // 17: drop retired card kinds (email_hits, email_thread) from stored card
  // blobs. Rewrites only rows that contain one, carrying every other entry
  // forward unchanged and leaving malformed blobs untouched; a row whose every
  // entry is retired becomes NULL, the app's "no cards" encoding.
  `
    UPDATE messages
       SET cards = (
         SELECT CASE WHEN COUNT(*) = 0 THEN NULL ELSE json_group_array(json(value)) END
           FROM json_each(messages.cards)
          WHERE json_extract(value, '$.card.kind') NOT IN ('email_hits', 'email_thread')
       )
     WHERE cards IS NOT NULL AND json_valid(cards)
       AND EXISTS (
         SELECT 1 FROM json_each(messages.cards)
          WHERE json_extract(value, '$.card.kind') IN ('email_hits', 'email_thread')
       );
    UPDATE automation_runs
       SET cards = (
         SELECT CASE WHEN COUNT(*) = 0 THEN NULL ELSE json_group_array(json(value)) END
           FROM json_each(automation_runs.cards)
          WHERE json_extract(value, '$.card.kind') NOT IN ('email_hits', 'email_thread')
       )
     WHERE cards IS NOT NULL AND json_valid(cards)
       AND EXISTS (
         SELECT 1 FROM json_each(automation_runs.cards)
          WHERE json_extract(value, '$.card.kind') IN ('email_hits', 'email_thread')
       );
  `,
  // 18: per-account permission grants replace the binary write-access list. Each
  // armed id in 'account.writeAccess' becomes an 'account.permissions' record
  // with write/send/delete all true (write access covered all three). A
  // malformed leftover is dropped, not carried; its default is read-only, the
  // safe state.
  `
    UPDATE settings
       SET key = 'account.permissions',
           value = (
             SELECT CASE WHEN COUNT(*) = 0 THEN '[]' ELSE json_group_array(
               json_object('accountId', je.value, 'write', json('true'),
                           'send', json('true'), 'delete', json('true'))
             ) END
               FROM json_each(settings.value) AS je
           )
     WHERE key = 'account.writeAccess' AND json_valid(value);
    DELETE FROM settings WHERE key = 'account.writeAccess';
  `,
  // 19: the email-signature feature is gone: drop the per-draft signature column
  // and strip signature fields from the stored account voices (which keep only
  // their voice-learn bookkeeping).
  `
    ALTER TABLE agent_drafts DROP COLUMN signature;
    UPDATE settings
       SET value = (
             SELECT CASE WHEN COUNT(*) = 0 THEN '[]' ELSE json_group_array(
               json(json_remove(je.value, '$.signature', '$.signatureHtml'))
             ) END
               FROM json_each(settings.value) AS je
           )
     WHERE key = 'account.voices' AND json_valid(value);
  `,
  // 20: the WhatsApp mirror (wa_contacts, wa_chats, wa_messages): text only,
  // capped per chat, wiped on unlink.
  `
    CREATE TABLE wa_contacts (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      notify TEXT NOT NULL DEFAULT '',
      phone_number TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );
    CREATE TABLE wa_chats (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      last_message_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE wa_messages (
      chat_jid TEXT NOT NULL,
      id TEXT NOT NULL,
      sender_jid TEXT NOT NULL DEFAULT '',
      sender_name TEXT NOT NULL DEFAULT '',
      from_me INTEGER NOT NULL DEFAULT 0,
      text TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      PRIMARY KEY (chat_jid, id)
    );
    CREATE INDEX idx_wa_messages_chat_time ON wa_messages(chat_jid, timestamp);
  `,
  // 21: compaction summaries persist as role='compaction' rows; compaction_cutoff
  // is the ms timestamp where the kept-verbatim tail begins, so a rebuilt
  // session replays the same compacted shape the live one ran with.
  `
    ALTER TABLE messages ADD COLUMN compaction_cutoff INTEGER;
  `,
  // 22: lead intake analysis — score becomes an A/B/C priority tier (A hot,
  // B warm, C cold) and each lead carries the detected inquiry language, both
  // surfaced to the caller before first contact.
  `
    ALTER TABLE leads RENAME COLUMN score TO priority;
    UPDATE leads SET priority = CASE priority
      WHEN 'high' THEN 'A' WHEN 'medium' THEN 'B' WHEN 'low' THEN 'C' ELSE '' END;
    ALTER TABLE leads ADD COLUMN language TEXT NOT NULL DEFAULT '';
  `,
  // 23: todos — a persistent human-attention queue the agent maintains, each
  // with a checklist in todo_steps. dedupe_key lets a repeating run upsert one
  // todo instead of piling up duplicates; the partial index skips ad-hoc ('').
  `
    CREATE TABLE todos (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      conversation_id TEXT,
      dedupe_key TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE todo_steps (
      id TEXT PRIMARY KEY,
      todo_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      label TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_todo_steps_todo ON todo_steps(todo_id, ordinal);
    CREATE INDEX idx_todos_dedupe ON todos(dedupe_key) WHERE dedupe_key <> '';
  `,
  // 24: todos gain an optional due date/time — the anchor for the home agenda
  // (overdue at top, then by day, automations interleaved). Null = undated.
  `
    ALTER TABLE todos ADD COLUMN due_at TEXT;
  `,
  // 25: outbound_drafts — pending outbound messages for comm channels without a
  // native provider draft (WhatsApp). Approved via the same draft→send card as
  // email; a human click or an armed autosend dispatches them.
  `
    CREATE TABLE outbound_drafts (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      target TEXT NOT NULL,
      target_label TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      sent_ref TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `,
  // 26: todos gain a manual sort key (drag-and-drop order within an agenda
  // group) and sub-todos gain their own optional due date (shown as a chip
  // under the parent, never a standalone agenda item).
  `
    ALTER TABLE todos ADD COLUMN position REAL NOT NULL DEFAULT 0;
    ALTER TABLE todo_steps ADD COLUMN due_at TEXT;
  `,
  // 27: a todo may link an automation fired when the user completes it
  // (open→done), chaining a human step into the next agent step. Null = none.
  `
    ALTER TABLE todos ADD COLUMN linked_automation_id TEXT;
  `,
  // 28: sub-todos retired — todos are flat. Existing checklists fold into the
  // parent's body as plain lines (content moves forward, never dropped), then
  // the table goes.
  `
    UPDATE todos SET body = TRIM(
      body || char(10) || char(10) || (
        SELECT group_concat(
          '- ' || CASE WHEN done THEN '☑ ' ELSE '☐ ' END || label ||
            CASE WHEN due_at IS NOT NULL THEN ' · ' || due_at ELSE '' END,
          char(10)
        )
        FROM (
          SELECT label, done, due_at FROM todo_steps
          WHERE todo_steps.todo_id = todos.id ORDER BY ordinal
        )
      )
    )
    WHERE EXISTS (SELECT 1 FROM todo_steps WHERE todo_steps.todo_id = todos.id);
    DROP TABLE todo_steps;
  `,
  // 29: automations get a manual sort key. Seeded as the negated created_at
  // epoch so ascending position reproduces the old newest-first order; new
  // rows get -now and land on top.
  `
    ALTER TABLE automations ADD COLUMN position REAL NOT NULL DEFAULT 0;
    UPDATE automations SET position = -CAST(strftime('%s', created_at) AS REAL) * 1000;
  `,
];
