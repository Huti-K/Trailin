import { createHash } from "node:crypto";
import type { ThreadTriage, ThreadUrgency } from "@trailin/shared";
import { sqlite } from "../../db/index.js";

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
}

/**
 * A failed thread isn't retried until this long after the failing attempt.
 * Exported so enrichService can reason about the same window (e.g. for
 * logging) without a second constant drifting out of sync with this query.
 */
export const ERROR_BACKOFF_MS = 10 * 60_000;

const selectStale = sqlite.prepare(`
  SELECT t.id AS thread_id, t.account_id, s.error AS last_error, s.enriched_at AS last_enriched_at
  FROM mail_threads t
  LEFT JOIN mail_thread_state s ON s.thread_id = t.id
  WHERE s.thread_id IS NULL
    OR t.updated_at > s.enriched_at
    OR (s.error IS NOT NULL AND s.enriched_at < ?)
  ORDER BY t.last_message_at DESC
  LIMIT ?
`);

export function findStaleCandidates(limit: number): StaleCandidate[] {
  // Recomputed per call rather than cached so a long-idle process doesn't
  // retry against a stale cutoff.
  const errorCutoff = new Date(Date.now() - ERROR_BACKOFF_MS).toISOString();
  const rows = selectStale.all(errorCutoff, limit) as Array<{
    thread_id: string;
    account_id: string;
    last_error: string | null;
    last_enriched_at: string | null;
  }>;
  return rows.map((row) => ({
    threadId: row.thread_id,
    accountId: row.account_id,
    lastError: row.last_error,
    lastEnrichedAt: row.last_enriched_at,
  }));
}

const selectThread = sqlite.prepare("SELECT subject FROM mail_threads WHERE id = ?");

const selectMessages = sqlite.prepare(`
  SELECT id, from_addr, to_addrs, date, body_text, is_from_me
  FROM mail_messages WHERE thread_id = ? ORDER BY date ASC
`);

const selectStoredHash = sqlite.prepare(
  "SELECT input_hash FROM mail_thread_state WHERE thread_id = ?",
);

export function storedInputHash(threadId: string): string | null {
  const row = selectStoredHash.get(threadId) as { input_hash: string } | undefined;
  return row?.input_hash ?? null;
}

/** null when the thread vanished between the candidate query and this read. */
export function snapshotThread(threadId: string, accountId: string): ThreadSnapshot | null {
  const takenAt = new Date().toISOString();
  const thread = selectThread.get(threadId) as { subject: string } | undefined;
  if (!thread) return null;
  const rows = selectMessages.all(threadId) as Array<{
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
  const hash = createHash("sha256").update("enrich-v2\n");
  for (const row of rows) hash.update(row.id).update("\n");
  return {
    threadId,
    accountId,
    subject: thread.subject,
    inputHash: hash.digest("hex"),
    takenAt,
    messages: rows.map((row) => ({
      from: row.from_addr,
      to: JSON.parse(row.to_addrs) as string[],
      date: row.date,
      bodyText: row.body_text,
      isFromMe: row.is_from_me === 1,
    })),
  };
}

const upsertState = sqlite.prepare(`
  INSERT INTO mail_thread_state (
    thread_id, account_id, input_hash, gist, summary, action_items,
    triage, urgency, deadline, model, error, enriched_at
  ) VALUES (
    @thread_id, @account_id, @input_hash, @gist, @summary, @action_items,
    @triage, @urgency, @deadline, @model, @error, @enriched_at
  )
  ON CONFLICT(thread_id) DO UPDATE SET
    account_id = excluded.account_id,
    input_hash = excluded.input_hash,
    gist = excluded.gist,
    summary = excluded.summary,
    action_items = excluded.action_items,
    triage = excluded.triage,
    urgency = excluded.urgency,
    deadline = excluded.deadline,
    model = excluded.model,
    error = excluded.error,
    enriched_at = excluded.enriched_at
`);

export function saveEnrichment(
  snapshot: ThreadSnapshot,
  result: EnrichmentResult,
  model: string,
): void {
  upsertState.run({
    thread_id: snapshot.threadId,
    account_id: snapshot.accountId,
    input_hash: snapshot.inputHash,
    gist: result.gist,
    summary: result.summary,
    action_items: JSON.stringify(result.actionItems),
    triage: result.triage,
    urgency: result.urgency,
    deadline: result.deadline ?? null,
    model,
    error: null,
    enriched_at: snapshot.takenAt,
  });
}

/**
 * Record a failed attempt. Keeps any previous good content (a stale summary
 * beats none) but stamps error + snapshot hash/time so the candidate query
 * stops flagging it until something changes or the backoff elapses.
 */
const markErrorStmt = sqlite.prepare(`
  INSERT INTO mail_thread_state (thread_id, account_id, input_hash, error, enriched_at)
  VALUES (@thread_id, @account_id, @input_hash, @error, @enriched_at)
  ON CONFLICT(thread_id) DO UPDATE SET
    input_hash = excluded.input_hash,
    error = excluded.error,
    enriched_at = excluded.enriched_at
`);

export function saveEnrichmentError(snapshot: ThreadSnapshot, error: string): void {
  markErrorStmt.run({
    thread_id: snapshot.threadId,
    account_id: snapshot.accountId,
    input_hash: snapshot.inputHash,
    error,
    enriched_at: snapshot.takenAt,
  });
}

/**
 * The hash matched, so the content is still valid — only refresh enriched_at
 * (e.g. after an unread flip touched the thread row) so the timestamp
 * pre-filter stops surfacing this thread every cycle.
 */
const touchStmt = sqlite.prepare(
  "UPDATE mail_thread_state SET enriched_at = ? WHERE thread_id = ?",
);

export function touchEnrichment(threadId: string, takenAt: string): void {
  touchStmt.run(takenAt, threadId);
}
