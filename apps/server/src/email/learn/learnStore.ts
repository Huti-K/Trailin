import { lazyStatement } from "../../db/index.js";
import { decodeStringArray } from "../sync/rows.js";

/**
 * Mirror reads for the draft-vs-sent learning loop (matcher.ts, extractor.ts).
 * Read-only: mail_messages is written exclusively by email/sync/mailStore.ts;
 * everything here is a plain SELECT against it, scoped by account so one
 * account's backlog never scans another's rows.
 */

export interface SentCandidate {
  providerMessageId: string;
  providerThreadId: string;
  subject: string;
  to: string[];
  date: string;
  bodyText: string;
}

// account_id leads idx_mail_messages_account(account_id, date), so this scans
// only the one account's rows from `afterIso` forward rather than the whole
// table; is_from_me is filtered after the index narrows the range.
const selectSentAfter = lazyStatement(`
  SELECT provider_message_id AS providerMessageId, provider_thread_id AS providerThreadId,
         subject, to_addrs AS toAddrs, date, body_text AS bodyText
  FROM mail_messages
  WHERE account_id = ? AND is_from_me = 1 AND date > ?
  ORDER BY date ASC
`);

/** Every message the account sent after `afterIso`, oldest first — the base candidate pool for one open draft. */
export function findSentAfter(accountId: string, afterIso: string): SentCandidate[] {
  const rows = selectSentAfter().all(accountId, afterIso) as Array<{
    providerMessageId: string;
    providerThreadId: string;
    subject: string;
    toAddrs: string;
    date: string;
    bodyText: string;
  }>;
  return rows.map((row) => ({
    providerMessageId: row.providerMessageId,
    providerThreadId: row.providerThreadId,
    subject: row.subject,
    to: decodeStringArray(row.toAddrs),
    date: row.date,
    bodyText: row.bodyText,
  }));
}

const selectByProviderMessageId = lazyStatement(`
  SELECT body_text AS bodyText FROM mail_messages WHERE account_id = ? AND provider_message_id = ?
`);

/** The sent message's mirrored body, or null when the mirror hasn't synced it (yet). */
export function findSentMessageBody(accountId: string, providerMessageId: string): string | null {
  const row = selectByProviderMessageId().get(accountId, providerMessageId) as
    | { bodyText: string }
    | undefined;
  return row?.bodyText ?? null;
}
