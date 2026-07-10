import { sqlite } from "../../db/index.js";
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

const selectState = sqlite.prepare(
  "SELECT account_id, cursor, status, error, last_synced_at FROM mail_sync_state WHERE account_id = ?",
);

const upsertState = sqlite.prepare(`
  INSERT INTO mail_sync_state (account_id, cursor, status, error, last_synced_at)
  VALUES (@account_id, @cursor, @status, @error, @last_synced_at)
  ON CONFLICT(account_id) DO UPDATE SET
    cursor = excluded.cursor,
    status = excluded.status,
    error = excluded.error,
    last_synced_at = excluded.last_synced_at
`);

export function getSyncState(accountId: string): SyncStateRow | null {
  const row = selectState.get(accountId) as
    | {
        account_id: string;
        cursor: string | null;
        status: string;
        error: string | null;
        last_synced_at: string | null;
      }
    | undefined;
  if (!row) return null;
  return {
    accountId: row.account_id,
    cursor: row.cursor,
    status: row.status as SyncStateRow["status"],
    error: row.error,
    lastSyncedAt: row.last_synced_at,
  };
}

function writeState(accountId: string, patch: Partial<Omit<SyncStateRow, "accountId">>): void {
  const current = getSyncState(accountId);
  upsertState.run({
    account_id: accountId,
    cursor: patch.cursor !== undefined ? patch.cursor : (current?.cursor ?? null),
    status: patch.status ?? current?.status ?? "idle",
    error: patch.error !== undefined ? patch.error : (current?.error ?? null),
    last_synced_at:
      patch.lastSyncedAt !== undefined ? patch.lastSyncedAt : (current?.lastSyncedAt ?? null),
  });
}

/** Persist the provider's resume cursor (null = restart backfill next sweep). */
export function setSyncCursor(accountId: string, cursor: string | null): void {
  writeState(accountId, { cursor });
}

export function markSyncStatus(
  accountId: string,
  status: SyncStateRow["status"],
  error?: string,
): void {
  writeState(accountId, {
    status,
    error: error ?? null,
    ...(status === "idle" ? { lastSyncedAt: new Date().toISOString() } : {}),
  });
}

const upsertMessage = sqlite.prepare(`
  INSERT INTO mail_messages (
    id, account_id, thread_id, provider_message_id, provider_thread_id,
    subject, from_addr, to_addrs, cc_addrs, date, snippet, body_text,
    is_from_me, is_unread, labels, synced_at
  ) VALUES (
    @id, @account_id, @thread_id, @provider_message_id, @provider_thread_id,
    @subject, @from_addr, @to_addrs, @cc_addrs, @date, @snippet, @body_text,
    @is_from_me, @is_unread, @labels, @synced_at
  )
  ON CONFLICT(id) DO UPDATE SET
    subject = excluded.subject,
    from_addr = excluded.from_addr,
    to_addrs = excluded.to_addrs,
    cc_addrs = excluded.cc_addrs,
    date = excluded.date,
    snippet = excluded.snippet,
    body_text = excluded.body_text,
    is_from_me = excluded.is_from_me,
    is_unread = excluded.is_unread,
    labels = excluded.labels,
    synced_at = excluded.synced_at
`);

const selectMessageThread = sqlite.prepare(
  "SELECT thread_id FROM mail_messages WHERE id = ?",
);
const deleteMessage = sqlite.prepare("DELETE FROM mail_messages WHERE id = ?");

const ftsDelete = sqlite.prepare("DELETE FROM mail_fts WHERE message_id = ?");
const ftsInsert = sqlite.prepare(
  "INSERT INTO mail_fts (subject, body_text, from_addr, message_id) VALUES (?, ?, ?, ?)",
);

const selectThreadMessages = sqlite.prepare(`
  SELECT provider_thread_id, subject, from_addr, to_addrs, date, is_from_me, is_unread
  FROM mail_messages WHERE thread_id = ? ORDER BY date ASC
`);

const upsertThread = sqlite.prepare(`
  INSERT INTO mail_threads (
    id, account_id, provider_thread_id, subject, participants,
    message_count, last_message_at, has_unread, last_from_me, updated_at
  ) VALUES (
    @id, @account_id, @provider_thread_id, @subject, @participants,
    @message_count, @last_message_at, @has_unread, @last_from_me, @updated_at
  )
  ON CONFLICT(id) DO UPDATE SET
    subject = excluded.subject,
    participants = excluded.participants,
    message_count = excluded.message_count,
    last_message_at = excluded.last_message_at,
    has_unread = excluded.has_unread,
    last_from_me = excluded.last_from_me,
    updated_at = excluded.updated_at
`);

const deleteThread = sqlite.prepare("DELETE FROM mail_threads WHERE id = ?");

/** Cap stored participants — a 200-person CC storm shouldn't bloat the rollup. */
const MAX_PARTICIPANTS = 25;

function recomputeThread(accountId: string, threadId: string, nowIso: string): void {
  const rows = selectThreadMessages.all(threadId) as Array<{
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
    deleteThread.run(threadId);
    return;
  }
  const participants: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const addr of [row.from_addr, ...(JSON.parse(row.to_addrs) as string[])]) {
      if (!addr || seen.has(addr)) continue;
      seen.add(addr);
      if (participants.length < MAX_PARTICIPANTS) participants.push(addr);
    }
  }
  upsertThread.run({
    id: threadId,
    account_id: accountId,
    provider_thread_id: first.provider_thread_id,
    // Threads are titled by their opening message; fall back for empty subjects.
    subject: first.subject || last.subject,
    participants: JSON.stringify(participants),
    message_count: rows.length,
    last_message_at: last.date,
    has_unread: rows.some((r) => r.is_unread === 1) ? 1 : 0,
    last_from_me: last.is_from_me,
    updated_at: nowIso,
  });
}

const applyTxn = sqlite.transaction((accountId: string, page: SyncPage, nowIso: string): number => {
  const touchedThreads = new Set<string>();
  for (const m of page.upserts) {
    const messageId = `${accountId}:${m.providerMessageId}`;
    const threadId = `${accountId}:${m.providerThreadId}`;
    upsertMessage.run({
      id: messageId,
      account_id: accountId,
      thread_id: threadId,
      provider_message_id: m.providerMessageId,
      provider_thread_id: m.providerThreadId,
      subject: m.subject,
      from_addr: m.from,
      to_addrs: JSON.stringify(m.to),
      cc_addrs: JSON.stringify(m.cc),
      date: m.date,
      snippet: m.snippet,
      body_text: m.bodyText,
      is_from_me: m.isFromMe ? 1 : 0,
      is_unread: m.isUnread ? 1 : 0,
      labels: m.labels.length > 0 ? JSON.stringify(m.labels) : null,
      synced_at: nowIso,
    });
    ftsDelete.run(messageId);
    ftsInsert.run(m.subject, m.bodyText, m.from, messageId);
    touchedThreads.add(threadId);
  }
  let deleted = 0;
  for (const providerMessageId of page.deletes) {
    const messageId = `${accountId}:${providerMessageId}`;
    const existing = selectMessageThread.get(messageId) as { thread_id: string } | undefined;
    if (!existing) continue;
    deleteMessage.run(messageId);
    ftsDelete.run(messageId);
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
