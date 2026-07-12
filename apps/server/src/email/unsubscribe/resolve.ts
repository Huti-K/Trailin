import type { ConnectedAccount, NewsletterSender, UnsubscribeInfo } from "@trailin/shared";
import { emitServerEvent } from "../../events.js";
import { mapWithConcurrency } from "../../jobs.js";
import { moduleLogger } from "../../logger.js";
import { listAccounts } from "../../pipedream/connect.js";
import "../sync/registerSyncProviders.js";
import { getSyncProvider, type SyncProvider } from "../sync/syncProviders.js";
import { executeOneClickUnsubscribe, type UnsubscribeExecuteResult } from "./execute.js";
import { classifyParsed, parseListUnsubscribe } from "./parse.js";
import {
  type BulkSenderRow,
  listBulkSenders,
  markUnsubscribeRequested,
  newestMessageFromSender,
  newestMessageFromSenderInAccount,
  persistMessageHeaders,
  type SenderMessageRow,
} from "./store.js";

/**
 * Orchestrates classification + lazy header backfill on top of ./store.ts's
 * raw reads/writes and ./parse.ts's pure parsing. The single source of truth
 * for "what can this sender's unsubscribe do" — routes/newsletters.ts and
 * email/unsubscribe/tool.ts (the agent tool) both call into this rather than
 * re-deriving the answer themselves.
 */

const log = moduleLogger("unsubscribe");

/** Bulk-resolve budget for GET /api/newsletters: bounds how many Outlook-style lazy header fetches one request pays for. Senders past the budget stay "unknown" and get a chance on a later request. */
const LAZY_RESOLVE_BUDGET = 10;
const LAZY_RESOLVE_CONCURRENCY = 5;

interface Evaluated {
  info: UnsubscribeInfo;
  /** Only ever set when info.state === "one_click" — the URL ./execute.ts posts to. */
  oneClickUrl?: string;
}

/** Classify one mail_messages row, given whether its owning account's provider can lazily fetch headers at all. */
function evaluateRow(row: SenderMessageRow | null, hasCapability: boolean): Evaluated {
  if (!row) return { info: { state: "none" } };
  if (row.listUnsubscribe === null) {
    return { info: { state: hasCapability ? "unknown" : "none" } };
  }
  if (row.listUnsubscribe === "") return { info: { state: "none" } };
  const parsed = parseListUnsubscribe(row.listUnsubscribe, row.listUnsubscribePost === 1);
  return { info: classifyParsed(parsed), oneClickUrl: parsed.oneClickUrl };
}

/** One SyncProvider.fetchMessageHeaders call plus its store.ts write-back, folded into the row shape evaluateRow expects. */
async function fetchAndPersist(
  account: ConnectedAccount,
  row: SenderMessageRow,
  provider: SyncProvider,
): Promise<SenderMessageRow> {
  const headers = (await provider.fetchMessageHeaders?.(account, row.providerMessageId)) ?? {};
  persistMessageHeaders(account.id, row.providerMessageId, headers);
  return {
    ...row,
    listUnsubscribe: headers.listUnsubscribe ?? "",
    listUnsubscribePost: headers.listUnsubscribe ? (headers.listUnsubscribePost ? 1 : 0) : 0,
  };
}

/**
 * Single-account resolution: the newest message this sender sent into THIS
 * account, with at most one lazy header fetch if that message's headers were
 * never captured. Shared by POST /api/newsletters/unsubscribe
 * (routes/newsletters.ts) and the `unsubscribe` agent tool
 * (email/unsubscribe/tool.ts) — the one place either decides whether a
 * one-click URL exists, so there is exactly one implementation of that
 * decision. Propagates a fetch failure rather than swallowing it: a single
 * targeted action (a button click, a tool call) should fail loudly instead
 * of silently reporting "not possible".
 */
export async function resolveAccountUnsubscribe(
  address: string,
  account: ConnectedAccount,
): Promise<Evaluated> {
  const provider = getSyncProvider(account.app);
  const hasCapability = Boolean(provider?.fetchMessageHeaders);
  const row = newestMessageFromSenderInAccount(address, account.id);
  const evaluated = evaluateRow(row, hasCapability);
  if (evaluated.info.state !== "unknown" || !row || !provider?.fetchMessageHeaders) {
    return evaluated;
  }
  const fetched = await fetchAndPersist(account, row, provider);
  return evaluateRow(fetched, hasCapability);
}

/**
 * The one write path for a successful one-click: fire the RFC 8058 POST and,
 * when it succeeds, stamp the sender's contact row (unsubscribe_requested_at)
 * so every surface renders "requested" persistently, and emit "contacts" so
 * open Newsletters lanes refetch. Shared by POST /api/newsletters/unsubscribe
 * and the agent tool — the stamp can never be forgotten by one of them.
 */
export async function executeAndMarkUnsubscribe(
  address: string,
  oneClickUrl: string,
): Promise<UnsubscribeExecuteResult> {
  const result = await executeOneClickUnsubscribe(oneClickUrl);
  if (result.ok) {
    markUnsubscribeRequested(address);
    emitServerEvent("contacts");
  }
  return result;
}

/**
 * Bulk-sender resolution for one row of the GET /api/newsletters list: the
 * sender's newest message across every connected account it corresponds on,
 * lazily backfilling headers only while `budget` allows it. Failures here are
 * swallowed (logged, left "unknown") — one sender's transient fetch failure
 * must never break the whole list, and the same sender simply gets another
 * chance on the next request.
 */
async function resolveSenderState(
  sender: BulkSenderRow,
  accountsById: Map<string, ConnectedAccount>,
  budget: { remaining: number },
): Promise<UnsubscribeInfo> {
  const row = newestMessageFromSender(sender.address);
  const owner = row ? accountsById.get(row.accountId) : undefined;
  const provider = owner ? getSyncProvider(owner.app) : null;
  const hasCapability = Boolean(provider?.fetchMessageHeaders);
  const evaluated = evaluateRow(row, hasCapability);
  if (evaluated.info.state !== "unknown" || !row || !owner || !provider?.fetchMessageHeaders) {
    return evaluated.info;
  }
  if (budget.remaining <= 0) return evaluated.info;
  budget.remaining--;
  try {
    const fetched = await fetchAndPersist(owner, row, provider);
    return evaluateRow(fetched, hasCapability).info;
  } catch (error) {
    log.warn({ err: error, address: sender.address }, "lazy unsubscribe header fetch failed");
    return evaluated.info;
  }
}

/** GET /api/newsletters's full response: every bulk sender with its resolved unsubscribe state. */
export async function listNewsletterSenders(): Promise<NewsletterSender[]> {
  const senders = listBulkSenders();
  if (senders.length === 0) return [];

  const accountsById = new Map((await listAccounts()).map((a) => [a.id, a]));
  const budget = { remaining: LAZY_RESOLVE_BUDGET };
  const infos = await mapWithConcurrency(senders, LAZY_RESOLVE_CONCURRENCY, (sender) =>
    resolveSenderState(sender, accountsById, budget),
  );

  return senders.map((sender, i) => ({
    address: sender.address,
    displayName: sender.displayName,
    messageCount: sender.messageCount,
    lastContactAt: sender.lastContactAt,
    accounts: sender.accounts,
    unsubscribe: infos[i] ?? { state: "none" },
    ...(sender.unsubscribeRequestedAt
      ? { unsubscribeRequestedAt: sender.unsubscribeRequestedAt }
      : {}),
  }));
}
