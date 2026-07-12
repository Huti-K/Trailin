import type {
  ConnectedAccount,
  ThreadUrgency,
  WaitingOnYouThread,
  WaitingThread,
} from "@trailin/shared";
import { lazyStatement } from "../db/index.js";
import { decodeStringArray } from "./sync/rows.js";
import { syncAccount } from "./sync/syncEngine.js";
import { getSyncProvider } from "./sync/syncProviders.js";
// Side-effect import: populates the SyncProvider registry for accountSupportsWaiting.
import "./sync/registerSyncProviders.js";
import { threadWebUrl } from "./webLinks.js";

/**
 * The two lanes of Home's "Open conversations" section, both computed from
 * the local mailbox mirror (./sync/) and enrichment's per-thread judgments
 * (./enrich/) instead of live provider queries. Any app with a SyncProvider
 * gets both for free (Gmail and Outlook alike); the one provider-specific
 * ingredient left is the webmail deep link (./webLinks.ts).
 *
 * "Waiting on you" — inbound threads enrichment triaged needs_reply, newest
 * message not from the owner, excluding ones the user dismissed (until a new
 * inbound message revives them — see enrichStore.ts's dismissed_hash).
 *
 * "Waiting on others" — sent threads enrichment judged still awaiting a
 * counterpart reply (mail_thread_state.awaiting_reply), within a 14-day
 * outer window. The window is only an upper bound now: enrichment already
 * decides whether a reply is genuinely expected, so there's no lower-edge
 * "hasn't had time to reply yet" filter here.
 */

/** A counterpart address matching this looks automated, not a person waiting to reply. */
const NO_REPLY_RE = /no-?reply|noreply|newsletter|notification|mailer-daemon/i;

/** How far back a sent-and-unanswered thread still counts as "waiting". */
const WAITING_WINDOW_DAYS = 14;

const MAX_ITEMS_PER_ACCOUNT = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The thread rollup already stores "newest message was mine" (last_from_me)
 * and when it was sent (last_message_at); the correlated subquery reads the
 * newest message's sender/recipients, which the rollup doesn't carry. Dates
 * are ISO 8601 strings by SyncMessage contract, so lexicographic comparison
 * orders them (the same assumption mailStore's thread recompute already
 * makes).
 */
const selectWaitingOnYou = lazyStatement(`
  SELECT
    t.provider_thread_id AS providerThreadId,
    t.subject AS subject,
    t.last_message_at AS lastMessageAt,
    s.gist AS gist,
    s.urgency AS urgency,
    (
      SELECT m.from_addr FROM mail_messages m
      WHERE m.thread_id = t.id
      ORDER BY m.date DESC
      LIMIT 1
    ) AS fromAddr
  FROM mail_threads t
  JOIN mail_thread_state s ON s.thread_id = t.id
  WHERE t.account_id = @accountId
    AND t.last_from_me = 0
    AND s.triage = 'needs_reply'
    AND (s.dismissed_hash IS NULL OR s.dismissed_hash != s.input_hash)
  ORDER BY CASE WHEN s.urgency = 'high' THEN 0 ELSE 1 END, t.last_message_at DESC
  LIMIT @limit
`);

const selectWaitingOnOthers = lazyStatement(`
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
  JOIN mail_thread_state s ON s.thread_id = t.id
  WHERE t.account_id = @accountId
    AND t.last_from_me = 1
    AND s.awaiting_reply = 1
    AND t.last_message_at >= @windowStart
  ORDER BY t.last_message_at ASC
`);

/** Waiting covers exactly the apps the mirror can sync — routes/tools filter accounts on this. */
export function accountSupportsWaiting(app: string): boolean {
  return getSyncProvider(app) !== null;
}

function waitingOnYou(account: ConnectedAccount): WaitingOnYouThread[] {
  const rows = selectWaitingOnYou().all({
    accountId: account.id,
    limit: MAX_ITEMS_PER_ACCOUNT,
  }) as Array<{
    providerThreadId: string;
    subject: string;
    lastMessageAt: string;
    gist: string;
    urgency: ThreadUrgency;
    fromAddr: string | null;
  }>;

  return rows.map(
    (row): WaitingOnYouThread => ({
      threadId: row.providerThreadId,
      accountId: account.id,
      subject: row.subject,
      counterpart: row.fromAddr ?? "",
      gist: row.gist,
      urgency: row.urgency,
      webUrl: threadWebUrl(account, row.providerThreadId),
    }),
  );
}

function waitingOnOthers(account: ConnectedAccount): WaitingThread[] {
  const windowStart = new Date(Date.now() - WAITING_WINDOW_DAYS * DAY_MS).toISOString();
  const rows = selectWaitingOnOthers().all({ accountId: account.id, windowStart }) as Array<{
    providerThreadId: string;
    subject: string;
    lastMessageAt: string;
    toAddrs: string | null;
  }>;

  return rows
    .map((row): WaitingThread => {
      const to = row.toAddrs ? decodeStringArray(row.toAddrs) : [];
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

/**
 * One account's "waiting on others" threads, most-overdue first, capped at
 * 10. `refresh` pulls the account's change feed into the mirror first
 * (deduped against any sync already in flight) so an explicit Home refresh
 * reflects mail that arrived since the last sweep. Kept as its own export
 * (rather than folded into listOpenConversations) for agent/waitingTools.ts,
 * which only ever needs this one lane.
 */
export async function listWaitingOnOthers(
  account: ConnectedAccount,
  opts: { refresh?: boolean } = {},
): Promise<WaitingThread[]> {
  if (opts.refresh) await syncAccount(account);
  return waitingOnOthers(account);
}

/** Both Home "Open conversations" lanes for one account, sharing a single mirror refresh. */
export async function listOpenConversations(
  account: ConnectedAccount,
  opts: { refresh?: boolean } = {},
): Promise<{ waitingOnYou: WaitingOnYouThread[]; waitingOnOthers: WaitingThread[] }> {
  if (opts.refresh) await syncAccount(account);
  return {
    waitingOnYou: waitingOnYou(account),
    waitingOnOthers: waitingOnOthers(account),
  };
}
