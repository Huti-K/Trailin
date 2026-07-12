import type { ConnectedAccount, ContactThread } from "@trailin/shared";
import { lazyStatement } from "../../db/index.js";
import { getContactThreadsLimitSetting } from "../../db/settings.js";
import { moduleLogger } from "../../logger.js";
import { listAccounts } from "../../pipedream/connect.js";
import { decodeStringArray } from "../sync/rows.js";
import { threadWebUrl } from "../webLinks.js";
import { parseAddressEntry } from "./addressMatch.js";

const log = moduleLogger("contacts");

interface RawThreadRow {
  threadId: string;
  accountId: string;
  providerThreadId: string;
  subject: string;
  participants: string;
  lastMessageAt: string;
}

const selectThreadsByRecency = lazyStatement(`
  SELECT id AS threadId, account_id AS accountId, provider_thread_id AS providerThreadId,
         subject, participants, last_message_at AS lastMessageAt
  FROM mail_threads
  ORDER BY last_message_at DESC
`);

const selectGist = lazyStatement("SELECT gist FROM mail_thread_state WHERE thread_id = ?");

/**
 * The newest threads whose participants include `address` (capped by the
 * contact-threads-limit setting), for GET /api/contacts/:address.
 * mail_threads carries no per-address index, so this walks the mirror's
 * thread rollups newest-first and stops once enough matches are found;
 * participants entries are re-parsed with parseAddressEntry (not
 * substring-matched) so "eve@x.com" can't match "steve@x.com". A Pipedream
 * outage drops every hit's webUrl, not the hits.
 */
export async function recentThreadsForContact(address: string): Promise<ContactThread[]> {
  const limit = await getContactThreadsLimitSetting();
  const accounts = await listAccounts().catch((err: unknown) => {
    log.warn({ err }, "recent threads: account lookup failed, hits keep no web link");
    return [] as ConnectedAccount[];
  });
  const accountById = new Map(accounts.map((account) => [account.id, account]));

  const rows = selectThreadsByRecency().all() as RawThreadRow[];
  const matches: ContactThread[] = [];
  for (const row of rows) {
    if (matches.length >= limit) break;
    const participants = decodeStringArray(row.participants);
    if (!participants.some((entry) => parseAddressEntry(entry).address === address)) continue;
    const state = selectGist().get(row.threadId) as { gist: string } | undefined;
    const account = accountById.get(row.accountId);
    matches.push({
      threadId: row.providerThreadId,
      accountId: row.accountId,
      subject: row.subject,
      date: row.lastMessageAt,
      gist: state?.gist ?? "",
      webUrl: account ? threadWebUrl(account, row.providerThreadId) || "" : "",
    });
  }
  return matches;
}
