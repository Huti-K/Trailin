import type { ConnectedAccount, WaitingThread } from "@trailin/shared";
import { sqlite } from "../db/index.js";
import { syncAccount } from "./sync/syncEngine.js";
import { getSyncProvider } from "./sync/syncProviders.js";
// Side-effect import: populates the SyncProvider registry for accountSupportsWaiting.
import "./sync/registerSyncProviders.js";
import { threadWebUrl } from "./webLinks.js";

/**
 * "Waiting on others" threads — threads where the user sent the last message
 * and nobody has replied yet — computed from the local mailbox mirror
 * (./sync/) instead of live provider queries. Any app with a SyncProvider
 * gets this for free (Gmail, Outlook, demo alike); the one provider-specific
 * ingredient left is the webmail deep link (./webLinks.ts).
 *
 * This replaced the per-provider WaitingProvider registry: the Gmail
 * implementation cost one live round-trip per candidate thread on every
 * cache miss, and Outlook never got an implementation at all. Here it's a
 * single local query, so there's no cache and no per-provider file.
 */

/** A counterpart address matching this looks automated, not a person waiting to reply. */
const NO_REPLY_RE = /no-?reply|noreply|newsletter|notification|mailer-daemon/i;

/** Below this age, whoever we're "waiting on" hasn't reasonably had time to reply yet. */
const MIN_WAIT_MS = 24 * 60 * 60 * 1000;

/** How far back a sent-and-unanswered thread still counts as "waiting" (the old Gmail path's newer_than:14d window). */
const WAITING_WINDOW_DAYS = 14;

const MAX_ITEMS_PER_ACCOUNT = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The thread rollup already stores "newest message was mine" (last_from_me)
 * and when it was sent (last_message_at); the correlated subquery reads the
 * newest message's recipients, which the rollup doesn't carry. Dates are ISO
 * 8601 strings by SyncMessage contract, so lexicographic comparison orders
 * them (the same assumption mailStore's thread recompute already makes).
 */
const selectWaiting = sqlite.prepare(`
  SELECT
    t.provider_thread_id AS providerThreadId,
    t.subject AS subject,
    t.last_message_at AS lastMessageAt,
    (
      SELECT m.to_addrs FROM mail_messages m
      WHERE m.thread_id = t.id
      ORDER BY m.date DESC
      LIMIT 1
    ) AS toAddrs
  FROM mail_threads t
  WHERE t.account_id = ?
    AND t.last_from_me = 1
    AND t.last_message_at >= ?
    AND t.last_message_at <= ?
  ORDER BY t.last_message_at ASC
`);

/** Waiting covers exactly the apps the mirror can sync — routes/tools filter accounts on this. */
export function accountSupportsWaiting(app: string): boolean {
  return getSyncProvider(app) !== null;
}

/**
 * One account's waiting threads, most-overdue first, capped at 10. `refresh`
 * pulls the account's change feed into the mirror first (deduped against any
 * sync already in flight) so an explicit Home refresh reflects mail that
 * arrived since the last sweep.
 */
export async function listWaiting(
  account: ConnectedAccount,
  opts: { refresh?: boolean } = {},
): Promise<WaitingThread[]> {
  if (opts.refresh) await syncAccount(account);

  const now = Date.now();
  const rows = selectWaiting.all(
    account.id,
    new Date(now - WAITING_WINDOW_DAYS * DAY_MS).toISOString(),
    new Date(now - MIN_WAIT_MS).toISOString(),
  ) as Array<{
    providerThreadId: string;
    subject: string;
    lastMessageAt: string;
    toAddrs: string | null;
  }>;

  return rows
    .map((row): WaitingThread => {
      const to = row.toAddrs ? (JSON.parse(row.toAddrs) as string[]) : [];
      return {
        threadId: row.providerThreadId,
        subject: row.subject,
        counterpart: to[0] ?? "",
        lastSentAt: row.lastMessageAt,
        webUrl: threadWebUrl(account, row.providerThreadId),
      };
    })
    .filter((item) => !NO_REPLY_RE.test(item.counterpart))
    .slice(0, MAX_ITEMS_PER_ACCOUNT);
}
