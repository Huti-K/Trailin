import { createHash } from "node:crypto";
import type { ThreadTriage, ThreadUrgency } from "@trailin/shared";
import { lazyStatement } from "../../db/index.js";
import { upsertSql } from "../../db/sql.js";
import { decodeStringArray } from "../sync/rows.js";

/**
 * Read/write side of thread enrichment. Staleness is DERIVED, never queued:
 * a thread is stale when its current message-id hash differs from the hash
 * its mail_thread_state row was computed from. Crashes, missed events and
 * races all self-heal on the next cycle because the source of truth is this
 * comparison, not any in-flight work list.
 *
 * The timestamp pre-filter (thread.updated_at > state.enriched_at) exists
 * only to keep the common no-op cycle cheap; the hash is what decides. A
 * third branch re-surfaces threads left in `error` state once ERROR_BACKOFF_MS
 * has elapsed since the failing attempt, so a transient LLM/network failure
 * doesn't leave a quiet thread un-triaged forever.
 *
 * The three conditions are expressed as separate UNIONed branches rather
 * than one LEFT JOIN with an OR across both tables' columns: an OR spanning
 * mail_threads and mail_thread_state columns can't be satisfied by any
 * single index, so the planner falls back to a full unindexed scan plus a
 * temporary sort for the ORDER BY on every call (this query reruns on every
 * "mail" event, 2s-debounced). Each branch below drives its scan off
 * mail_threads in idx_mail_threads_last_message_at order — already in the
 * ORDER BY's direction, so no temp sort — and reaches the other table only
 * through a primary-key lookup. Each branch is independently capped at
 * `limit`, then re-merged and capped again; that preserves the exact
 * top-`limit` result a single global ORDER BY would produce (any row in the
 * true global top-`limit` must also rank within its own branch's top-`limit`,
 * since restricting to a subset of rows cannot push a row's rank down). UNION
 * (not UNION ALL) dedupes a thread that qualifies on more than one branch
 * (e.g. errored and also touched by new mail) to a single row.
 */

export interface StaleCandidate {
  threadId: string;
  accountId: string;
  /** Present when a previous attempt failed — used for retry backoff. */
  lastError: string | null;
  lastEnrichedAt: string | null;
}

export interface ThreadSnapshot {
  threadId: string;
  accountId: string;
  subject: string;
  /** Hash over the ordered message ids this snapshot saw. */
  inputHash: string;
  /** Snapshot time — becomes enriched_at so mid-call changes stay flagged. */
  takenAt: string;
  messages: Array<{
    from: string;
    to: string[];
    date: string;
    bodyText: string;
    isFromMe: boolean;
  }>;
}

export interface EnrichmentResult {
  gist: string;
  summary: string;
  actionItems: string[];
  triage: ThreadTriage;
  urgency: ThreadUrgency;
  deadline?: string;
  /**
   * True only when the thread's newest message is from the owner's own
   * account AND it still expects a response from the other side — what the
   * Home "waiting on others" lane is built from.
   */
  awaitingReply: boolean;
}

/** A failed thread isn't retried until this long after the failing attempt. */
const ERROR_BACKOFF_MS = 10 * 60_000;

const selectStale = lazyStatement(`
  SELECT * FROM (
    SELECT t.id AS threadId, t.account_id AS accountId, NULL AS lastError, NULL AS lastEnrichedAt,
           t.last_message_at AS lastMessageAt
    FROM mail_threads t
    WHERE NOT EXISTS (SELECT 1 FROM mail_thread_state s WHERE s.thread_id = t.id)
    ORDER BY t.last_message_at DESC
    LIMIT @limit
  )
  UNION
  SELECT * FROM (
    SELECT t.id AS threadId, t.account_id AS accountId, s.error AS lastError,
           s.enriched_at AS lastEnrichedAt, t.last_message_at AS lastMessageAt
    FROM mail_threads t
    JOIN mail_thread_state s ON s.thread_id = t.id
    WHERE t.updated_at > s.enriched_at
    ORDER BY t.last_message_at DESC
    LIMIT @limit
  )
  UNION
  SELECT * FROM (
    SELECT t.id AS threadId, t.account_id AS accountId, s.error AS lastError,
           s.enriched_at AS lastEnrichedAt, t.last_message_at AS lastMessageAt
    FROM mail_threads t
    JOIN mail_thread_state s ON s.thread_id = t.id
    WHERE s.error IS NOT NULL AND s.enriched_at < @errorCutoff
    ORDER BY t.last_message_at DESC
    LIMIT @limit
  )
  ORDER BY lastMessageAt DESC
  LIMIT @limit
`);

export function findStaleCandidates(limit: number): StaleCandidate[] {
  // Recomputed per call rather than cached so a long-idle process doesn't
  // retry against a stale cutoff.
  const errorCutoff = new Date(Date.now() - ERROR_BACKOFF_MS).toISOString();
  return selectStale().all({ limit, errorCutoff }) as StaleCandidate[];
}

/** The prepared statement's own SQL text, for an EXPLAIN QUERY PLAN test. */
export function _selectStaleSqlForTest(): string {
  return selectStale().source;
}

const selectThread = lazyStatement("SELECT subject FROM mail_threads WHERE id = ?");

const selectMessages = lazyStatement(`
  SELECT id, from_addr, to_addrs, date, body_text, is_from_me
  FROM mail_messages WHERE thread_id = ? ORDER BY date ASC
`);

const selectStoredHash = lazyStatement(
  "SELECT input_hash FROM mail_thread_state WHERE thread_id = ?",
);

export function storedInputHash(threadId: string): string | null {
  const row = selectStoredHash().get(threadId) as { input_hash: string } | undefined;
  return row?.input_hash ?? null;
}

/** null when the thread vanished between the candidate query and this read. */
export function snapshotThread(threadId: string, accountId: string): ThreadSnapshot | null {
  const takenAt = new Date().toISOString();
  const thread = selectThread().get(threadId) as { subject: string } | undefined;
  if (!thread) return null;
  const rows = selectMessages().all(threadId) as Array<{
    id: string;
    from_addr: string;
    to_addrs: string;
    date: string;
    body_text: string;
    is_from_me: number;
  }>;
  if (rows.length === 0) return null;
  // Bump when the enrichment prompt/output contract changes meaningfully —
  // salting the hash re-enriches every thread on the new version.
  const hash = createHash("sha256").update("enrich-v3\n");
  for (const row of rows) hash.update(row.id).update("\n");
  return {
    threadId,
    accountId,
    subject: thread.subject,
    inputHash: hash.digest("hex"),
    takenAt,
    messages: rows.map((row) => ({
      from: row.from_addr,
      to: decodeStringArray(row.to_addrs),
      date: row.date,
      bodyText: row.body_text,
      isFromMe: row.is_from_me === 1,
    })),
  };
}

const upsertState = lazyStatement(
  upsertSql({
    table: "mail_thread_state",
    conflict: ["thread_id"],
    update: [
      "account_id",
      "input_hash",
      "gist",
      "summary",
      "action_items",
      "triage",
      "urgency",
      "deadline",
      "awaiting_reply",
      "model",
      "error",
      "enriched_at",
    ],
  }),
);

export function saveEnrichment(
  snapshot: ThreadSnapshot,
  result: EnrichmentResult,
  model: string,
): void {
  upsertState().run({
    threadId: snapshot.threadId,
    accountId: snapshot.accountId,
    inputHash: snapshot.inputHash,
    gist: result.gist,
    summary: result.summary,
    actionItems: JSON.stringify(result.actionItems),
    triage: result.triage,
    urgency: result.urgency,
    deadline: result.deadline ?? null,
    // better-sqlite3's raw bind (unlike drizzle's mode: "boolean" columns
    // elsewhere) only accepts numbers/strings/bigints/buffers/null.
    awaitingReply: result.awaitingReply ? 1 : 0,
    model,
    error: null,
    enrichedAt: snapshot.takenAt,
  });
}

/**
 * Record a failed attempt. Keeps any previous good content (a stale summary
 * beats none) but stamps error + snapshot hash/time so the candidate query
 * stops flagging it until something changes or the backoff elapses.
 */
const markErrorStmt = lazyStatement(
  upsertSql({
    table: "mail_thread_state",
    conflict: ["thread_id"],
    insertOnly: ["account_id"],
    update: ["input_hash", "error", "enriched_at"],
  }),
);

export function saveEnrichmentError(snapshot: ThreadSnapshot, error: string): void {
  markErrorStmt().run({
    threadId: snapshot.threadId,
    accountId: snapshot.accountId,
    inputHash: snapshot.inputHash,
    error,
    enrichedAt: snapshot.takenAt,
  });
}

/**
 * The hash matched, so the content is still valid — only refresh enriched_at
 * (e.g. after an unread flip touched the thread row) so the timestamp
 * pre-filter stops surfacing this thread every cycle.
 */
const touchStmt = lazyStatement("UPDATE mail_thread_state SET enriched_at = ? WHERE thread_id = ?");

export function touchEnrichment(threadId: string, takenAt: string): void {
  touchStmt().run(takenAt, threadId);
}

/**
 * Stamps the thread's current input_hash into dismissed_hash, which the
 * "waiting on you" lane query then excludes it by (mail_threads' provider
 * thread id + account id — the mirror's own thread_id is deterministic from
 * those but never exposed past this module, so the lookup goes through a
 * subquery rather than assuming the format). A later inbound message changes
 * input_hash, so the two values stop matching and the thread resurfaces on
 * its own — there is nothing to "undo" here.
 */
const dismissStmt = lazyStatement(`
  UPDATE mail_thread_state
  SET dismissed_hash = input_hash
  WHERE thread_id = (
    SELECT id FROM mail_threads WHERE account_id = @accountId AND provider_thread_id = @providerThreadId
  )
`);

/** False when no mail_thread_state row exists for this thread yet — nothing to dismiss. */
export function dismissThread(accountId: string, providerThreadId: string): boolean {
  const result = dismissStmt().run({ accountId, providerThreadId });
  return result.changes > 0;
}
