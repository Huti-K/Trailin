import { lazyStatement, sqlite } from "../../db/index.js";
import { upsertSql } from "../../db/sql.js";
import { decodeStringArray } from "./rows.js";
import type { SyncPage } from "./syncProviders.js";

/**
 * Write side of the mailbox mirror. Everything here is synchronous
 * better-sqlite3 with prepared statements: applySyncPage runs as one
 * transaction so a crash mid-page never leaves messages without their thread
 * rollup or FTS row. Thread rows are never written directly by anyone else —
 * they are recomputed from mail_messages for every thread a page touches,
 * which makes the whole store idempotent: replaying a page is a no-op.
 */

export interface SyncStateRow {
  accountId: string;
  cursor: string | null;
  status: "idle" | "syncing" | "error";
  error: string | null;
  lastSyncedAt: string | null;
}

const selectState = lazyStatement(`
  SELECT account_id AS accountId, cursor, status, error, last_synced_at AS lastSyncedAt
  FROM mail_sync_state WHERE account_id = ?
`);

export function getSyncState(accountId: string): SyncStateRow | null {
  return (selectState().get(accountId) as SyncStateRow | undefined) ?? null;
}

const upsertCursor = lazyStatement(
  upsertSql({ table: "mail_sync_state", conflict: ["account_id"], update: ["cursor"] }),
);

/** Persist the provider's resume cursor (null = restart backfill next sweep). */
export function setSyncCursor(accountId: string, cursor: string | null): void {
  upsertCursor().run({ accountId, cursor });
}

// last_synced_at only moves on a successful pass (COALESCE keeps the previous
// value when null is bound), so an error run never erases when mail was last
// fresh; the cursor column is untouched either way.
const upsertStatus = lazyStatement(`
  INSERT INTO mail_sync_state (account_id, status, error, last_synced_at)
  VALUES (@accountId, @status, @error, @lastSyncedAt)
  ON CONFLICT(account_id) DO UPDATE SET
    status = excluded.status,
    error = excluded.error,
    last_synced_at = COALESCE(excluded.last_synced_at, mail_sync_state.last_synced_at)
`);

export function markSyncStatus(
  accountId: string,
  status: SyncStateRow["status"],
  error?: string,
): void {
  upsertStatus().run({
    accountId,
    status,
    error: error ?? null,
    lastSyncedAt: status === "idle" ? new Date().toISOString() : null,
  });
}

const upsertMessage = lazyStatement(
  upsertSql({
    table: "mail_messages",
    conflict: ["id"],
    insertOnly: ["account_id", "thread_id", "provider_message_id", "provider_thread_id"],
    update: [
      "subject",
      "from_addr",
      "to_addrs",
      "cc_addrs",
      "date",
      "snippet",
      "body_text",
      "is_from_me",
      "is_unread",
      "labels",
      "list_unsubscribe",
      "list_unsubscribe_post",
      "synced_at",
    ],
  }),
);

const selectMessageThread = lazyStatement("SELECT thread_id FROM mail_messages WHERE id = ?");
const deleteMessage = lazyStatement("DELETE FROM mail_messages WHERE id = ?");

const ftsDelete = lazyStatement("DELETE FROM mail_fts WHERE message_id = ?");
const ftsInsert = lazyStatement(
  "INSERT INTO mail_fts (subject, body_text, from_addr, message_id) VALUES (?, ?, ?, ?)",
);

const selectThreadMessages = lazyStatement(`
  SELECT provider_thread_id, subject, from_addr, to_addrs, date, is_from_me, is_unread
  FROM mail_messages WHERE thread_id = ? ORDER BY date ASC
`);

const upsertThread = lazyStatement(
  upsertSql({
    table: "mail_threads",
    conflict: ["id"],
    insertOnly: ["account_id", "provider_thread_id"],
    update: [
      "subject",
      "participants",
      "message_count",
      "last_message_at",
      "has_unread",
      "last_from_me",
      "updated_at",
    ],
  }),
);

const deleteThread = lazyStatement("DELETE FROM mail_threads WHERE id = ?");

/** Cap stored participants — a 200-person CC storm shouldn't bloat the rollup. */
const MAX_PARTICIPANTS = 25;

function recomputeThread(accountId: string, threadId: string, nowIso: string): void {
  const rows = selectThreadMessages().all(threadId) as Array<{
    provider_thread_id: string;
    subject: string;
    from_addr: string;
    to_addrs: string;
    date: string;
    is_from_me: number;
    is_unread: number;
  }>;
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (first === undefined || last === undefined) {
    deleteThread().run(threadId);
    return;
  }
  const participants: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const addr of [row.from_addr, ...decodeStringArray(row.to_addrs)]) {
      if (!addr || seen.has(addr)) continue;
      seen.add(addr);
      if (participants.length < MAX_PARTICIPANTS) participants.push(addr);
    }
  }
  upsertThread().run({
    id: threadId,
    accountId,
    providerThreadId: first.provider_thread_id,
    // Threads are titled by their opening message; fall back for empty subjects.
    subject: first.subject || last.subject,
    participants: JSON.stringify(participants),
    messageCount: rows.length,
    lastMessageAt: last.date,
    hasUnread: rows.some((r) => r.is_unread === 1) ? 1 : 0,
    lastFromMe: last.is_from_me,
    updatedAt: nowIso,
  });
}

const applyTxn = sqlite.transaction((accountId: string, page: SyncPage, nowIso: string): number => {
  const touchedThreads = new Set<string>();
  for (const m of page.upserts) {
    const messageId = `${accountId}:${m.providerMessageId}`;
    const threadId = `${accountId}:${m.providerThreadId}`;
    upsertMessage().run({
      id: messageId,
      accountId,
      threadId,
      providerMessageId: m.providerMessageId,
      providerThreadId: m.providerThreadId,
      subject: m.subject,
      fromAddr: m.from,
      toAddrs: JSON.stringify(m.to),
      ccAddrs: JSON.stringify(m.cc),
      date: m.date,
      snippet: m.snippet,
      bodyText: m.bodyText,
      isFromMe: m.isFromMe ? 1 : 0,
      isUnread: m.isUnread ? 1 : 0,
      labels: m.labels.length > 0 ? JSON.stringify(m.labels) : null,
      // Undefined (provider doesn't capture headers, or the message has
      // none) maps to null — distinct from a captured, empty value, which
      // toSyncMessage never produces.
      listUnsubscribe: m.listUnsubscribe ?? null,
      listUnsubscribePost:
        m.listUnsubscribePost === undefined ? null : m.listUnsubscribePost ? 1 : 0,
      syncedAt: nowIso,
    });
    ftsDelete().run(messageId);
    ftsInsert().run(m.subject, m.bodyText, m.from, messageId);
    touchedThreads.add(threadId);
  }
  let deleted = 0;
  for (const providerMessageId of page.deletes) {
    const messageId = `${accountId}:${providerMessageId}`;
    const existing = selectMessageThread().get(messageId) as { thread_id: string } | undefined;
    if (!existing) continue;
    deleteMessage().run(messageId);
    ftsDelete().run(messageId);
    touchedThreads.add(existing.thread_id);
    deleted++;
  }
  for (const threadId of touchedThreads) recomputeThread(accountId, threadId, nowIso);
  return page.upserts.length + deleted;
});

/** Apply one provider page atomically; returns how many messages changed. */
export function applySyncPage(accountId: string, page: SyncPage): number {
  return applyTxn(accountId, page, new Date().toISOString());
}
