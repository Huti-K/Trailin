import type { ConnectedAccount } from "@trailin/shared";
import {
  parseOpaqueCursor,
  SyncCursorExpiredError,
  type SyncMessage,
  type SyncOptions,
  type SyncPage,
  type SyncProvider,
} from "./sync/syncProviders.js";
import { errorMessage } from "../util.js";
import { proxyRequest } from "../pipedream/connect.js";
import {
  decodeHtmlEntities,
  GMAIL_API,
  headerLookup,
  plainTextBody,
  type MessagePart,
} from "./gmailMessage.js";
import { splitAddressList } from "./textUtils.js";

/**
 * Gmail SyncProvider: mirrors a Gmail mailbox into the local store
 * (email/sync/mailStore.ts) via the Connect proxy. Two-phase cursor, both
 * anchored on Gmail's historyId (the only thing Gmail's change-feed
 * understands):
 *
 *  - "backfill": messages.list over a bounded `newer_than` window, paged by
 *    Gmail's own pageToken. The historyId captured before the first list
 *    call is carried through unchanged — it is the point every subsequent
 *    history.list call resumes from, so nothing that changes during the
 *    (possibly multi-page) backfill is missed.
 *  - "history": history.list from that historyId onward, steady state. A
 *    rejected startHistoryId (aged out of Gmail's ~1 week retention) throws
 *    SyncCursorExpiredError so the engine restarts the backfill.
 *
 * Read-only, unlike gmailDrafts.ts — written against the SyncProvider
 * contract rather than DraftProvider; see syncProviders.ts for why the
 * cursor is opaque outside this file.
 */

/** Concurrency cap for per-message GET calls — keeps a big backfill/history page from opening dozens of connections at once. */
const BATCH_CONCURRENCY = 5;

/** Labels that mean "not real mail" — excluded from upserts, emitted as deletes when a previously-mirrored message moves here. */
const EXCLUDED_LABELS = new Set(["DRAFT", "TRASH", "SPAM"]);

interface BackfillCursor {
  phase: "backfill";
  historyId: string;
  pageToken?: string;
}

interface HistoryCursor {
  phase: "history";
  historyId: string;
  pageToken?: string;
}

type Cursor = BackfillCursor | HistoryCursor;

function isCursor(value: unknown): value is Cursor {
  if (typeof value !== "object" || value === null) return false;
  const phase = (value as { phase?: unknown }).phase;
  return phase === "backfill" || phase === "history";
}

function serializeCursor(cursor: Cursor): string {
  return JSON.stringify(cursor);
}

/** Duck-typed HTTP status off whatever proxyRequest's underlying SDK throws (see PipedreamError in @pipedream/sdk). */
function statusCodeOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const status = (error as { statusCode?: unknown }).statusCode;
  return typeof status === "number" ? status : undefined;
}

/**
 * Gmail returns 404 for a startHistoryId that has aged out of its retention
 * window (Gmail keeps ~1 week of history); some errors instead come back as
 * a 400 whose message names the historyId. Anything else (rate limit,
 * network blip, etc.) is a real failure and must propagate.
 */
function isHistoryIdExpired(error: unknown): boolean {
  const status = statusCodeOf(error);
  if (status === 404) return true;
  if (status === 400) return /history\s?id/i.test(errorMessage(error));
  return false;
}

async function mapBatched<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    const batch = items.slice(i, i + limit);
    results.push(...(await Promise.all(batch.map(fn))));
  }
  return results;
}

interface GmailMessageFull {
  id: string;
  threadId: string;
  labelIds?: string[];
  internalDate?: string;
  snippet?: string;
  payload?: MessagePart & { headers?: { name: string; value: string }[] };
}

function isExcludedLabel(labelIds: string[] | undefined): boolean {
  return (labelIds ?? []).some((label) => EXCLUDED_LABELS.has(label));
}

/** Gmail message -> the provider-neutral shape mailStore.ts writes. */
function toSyncMessage(msg: GmailMessageFull): SyncMessage {
  const header = headerLookup(msg.payload);
  const labelIds = msg.labelIds ?? [];
  return {
    providerMessageId: msg.id,
    providerThreadId: msg.threadId,
    subject: header("Subject"),
    from: header("From"),
    to: splitAddressList(header("To")),
    cc: splitAddressList(header("Cc")),
    // internalDate is ms-epoch and Gmail always returns it for a full fetch;
    // falling back to "now" (rather than "") keeps every SyncMessage's date
    // usable for ordering, per syncProviders.ts's contract.
    date: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : new Date().toISOString(),
    snippet: decodeHtmlEntities(msg.snippet ?? ""),
    bodyText: plainTextBody(msg.payload),
    isFromMe: labelIds.includes("SENT"),
    isUnread: labelIds.includes("UNREAD"),
    labels: labelIds,
  };
}

async function fetchMessageFull(
  account: ConnectedAccount,
  id: string,
): Promise<GmailMessageFull> {
  return (await proxyRequest(account.id, "get", `${GMAIL_API}/messages/${id}`, {
    params: { format: "full" },
  })) as GmailMessageFull;
}

interface ProfileResponse {
  historyId?: string;
}

/**
 * Captured before the first backfill list call (not after) so that anything
 * that changes the mailbox while the backfill is still paging falls after
 * this point, not into a gap between "listed" and "captured".
 */
async function fetchStartHistoryId(account: ConnectedAccount): Promise<string> {
  const profile = (await proxyRequest(account.id, "get", `${GMAIL_API}/profile`)) as ProfileResponse;
  if (!profile.historyId) throw new Error("Gmail profile response is missing historyId");
  return profile.historyId;
}

interface MessagesListResponse {
  messages?: { id: string }[];
  nextPageToken?: string;
}

async function fetchBackfillPage(
  account: ConnectedAccount,
  cursor: BackfillCursor | null,
  opts: SyncOptions,
): Promise<SyncPage> {
  const historyId = cursor?.historyId ?? (await fetchStartHistoryId(account));

  const list = (await proxyRequest(account.id, "get", `${GMAIL_API}/messages`, {
    params: {
      q: `newer_than:${opts.backfillDays}d -in:spam -in:trash -in:draft`,
      maxResults: String(opts.pageSize),
      ...(cursor?.pageToken ? { pageToken: cursor.pageToken } : {}),
    },
  })) as MessagesListResponse;

  const ids = (list.messages ?? []).map((m) => m.id);
  const messages = await mapBatched(ids, BATCH_CONCURRENCY, (id) => fetchMessageFull(account, id));
  // The `-in:draft -in:trash -in:spam` query already excludes these, but a
  // label can change between the list call and this fetch — filter again
  // rather than trust the query alone.
  const upserts = messages.filter((m) => !isExcludedLabel(m.labelIds)).map(toSyncMessage);

  if (list.nextPageToken) {
    return {
      upserts,
      deletes: [],
      cursor: serializeCursor({ phase: "backfill", historyId, pageToken: list.nextPageToken }),
      hasMore: true,
    };
  }
  return {
    upserts,
    deletes: [],
    cursor: serializeCursor({ phase: "history", historyId }),
    hasMore: false,
  };
}

interface HistoryMessageRef {
  message: { id: string };
}

interface HistoryRecord {
  messagesAdded?: HistoryMessageRef[];
  messagesDeleted?: HistoryMessageRef[];
  labelsAdded?: HistoryMessageRef[];
  labelsRemoved?: HistoryMessageRef[];
}

interface HistoryListResponse {
  history?: HistoryRecord[];
  historyId?: string;
  nextPageToken?: string;
}

/** Every message id touched by this page's history records, deduped — order doesn't matter, each is resolved to its current state independently. */
function collectTouchedIds(history: HistoryRecord[]): string[] {
  const ids = new Set<string>();
  for (const record of history) {
    for (const refs of [
      record.messagesAdded,
      record.messagesDeleted,
      record.labelsAdded,
      record.labelsRemoved,
    ]) {
      for (const ref of refs ?? []) ids.add(ref.message.id);
    }
  }
  return [...ids];
}

/**
 * Resolve each touched id to its *current* state with one uniform fetch —
 * this is what makes "added then deleted in the same window", trash/spam
 * moves and plain unread flips all fall out of the same code path instead of
 * needing separate handling per history record type.
 */
async function resolveTouched(
  account: ConnectedAccount,
  ids: string[],
): Promise<{ upserts: SyncMessage[]; deletes: string[] }> {
  const resolved = await mapBatched(ids, BATCH_CONCURRENCY, async (id) => {
    try {
      return { id, message: await fetchMessageFull(account, id) };
    } catch (error) {
      if (statusCodeOf(error) === 404) return { id, message: null };
      throw error;
    }
  });

  const upserts: SyncMessage[] = [];
  const deletes: string[] = [];
  for (const { id, message } of resolved) {
    if (!message || isExcludedLabel(message.labelIds)) {
      deletes.push(id);
      continue;
    }
    upserts.push(toSyncMessage(message));
  }
  return { upserts, deletes };
}

async function fetchHistoryPage(
  account: ConnectedAccount,
  cursor: HistoryCursor,
  opts: SyncOptions,
): Promise<SyncPage> {
  let list: HistoryListResponse;
  try {
    list = (await proxyRequest(account.id, "get", `${GMAIL_API}/history`, {
      params: {
        startHistoryId: cursor.historyId,
        maxResults: String(opts.pageSize),
        ...(cursor.pageToken ? { pageToken: cursor.pageToken } : {}),
      },
    })) as HistoryListResponse;
  } catch (error) {
    if (isHistoryIdExpired(error)) throw new SyncCursorExpiredError();
    throw error;
  }

  const { upserts, deletes } = await resolveTouched(account, collectTouchedIds(list.history ?? []));

  if (list.nextPageToken) {
    // Keep the ORIGINAL startHistoryId while paging: the pageToken belongs to
    // that query, and a crash mid-page must resume the same query (re-applied
    // records are idempotent upserts). Only the final page advances the anchor.
    return {
      upserts,
      deletes,
      cursor: serializeCursor({
        phase: "history",
        historyId: cursor.historyId,
        pageToken: list.nextPageToken,
      }),
      hasMore: true,
    };
  }
  return {
    upserts,
    deletes,
    cursor: serializeCursor({ phase: "history", historyId: list.historyId ?? cursor.historyId }),
    hasMore: false,
  };
}

/** This module's SyncProvider — registered by ./sync/registerSyncProviders.ts. */
export const gmailSyncProvider: SyncProvider = {
  fetchChanges(account: ConnectedAccount, cursor: string | null, opts: SyncOptions): Promise<SyncPage> {
    // A tampered/unreadable cursor parses to null — same as "no cursor",
    // restart the backfill (see parseOpaqueCursor in syncProviders.ts).
    const parsed = parseOpaqueCursor(cursor, isCursor);
    if (parsed?.phase === "history") return fetchHistoryPage(account, parsed, opts);
    return fetchBackfillPage(account, parsed, opts);
  },
};
