import { PipedreamError } from "@pipedream/sdk";
import type { ConnectedAccount } from "@trailin/shared";
import { proxyRequest } from "../../pipedream/connect.js";
import {
  parseOpaqueCursor,
  SyncCursorExpiredError,
  type SyncMessage,
  type SyncOptions,
  type SyncPage,
  type SyncProvider,
} from "../sync/syncProviders.js";
import { stripHtml } from "../textUtils.js";
import { formatRecipient, formatRecipients, GRAPH_API, type GraphRecipient } from "./message.js";

/**
 * Outlook / Microsoft 365 mailbox-mirror sync driver, via the Connect proxy
 * against Microsoft Graph's delta query API — the same proxy mechanism
 * ./drafts.ts uses, pointed at /me/mailFolders('…')/messages/delta
 * instead of the drafts endpoints. Registered under app slug
 * "microsoft_outlook" at the bottom of this file.
 *
 * Graph tracks changes per folder, so this runs two independent delta
 * streams — Inbox and Sent Items (sent mail is what lets downstream features
 * confirm "did the user actually send our draft"). The opaque cursor this
 * file hands back to the engine is a small JSON envelope carrying both
 * streams' resume state; nothing outside this file ever parses it.
 *
 * Per fetchChanges call, at most one Graph request per not-yet-caught-up
 * stream happens (inbox first) until both streams reach their deltaLink; from
 * then on every call does one steady-state sweep of each stream's deltaLink
 * together, which is normally an empty page each but still catches genuine
 * changes. proxyRequest has no custom-header support, so the `Prefer:
 * outlook.body-content-type=text` header Graph would otherwise honor can't be
 * sent — bodies arrive as HTML and are stripped to plain text here.
 */

/** Selected fields for both streams — enough to build a SyncMessage without a second round-trip. */
const DELTA_SELECT =
  "subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,bodyPreview,body,isRead,conversationId,isDraft";

type StreamKey = "inbox" | "sent";

/** The Graph folder id each stream reads from. */
const FOLDER_ID: Record<StreamKey, string> = { inbox: "inbox", sent: "sentitems" };

interface StreamState {
  /** Full @odata.nextLink or @odata.deltaLink URL, or null for "not started yet". */
  link: string | null;
  /** True once `link` holds a deltaLink (caught up to steady state). */
  done: boolean;
}

/** The opaque cursor's decoded shape — only this file ever parses/builds it. */
interface OutlookCursor {
  inbox: StreamState;
  sent: StreamState;
}

function isOutlookCursor(value: unknown): value is OutlookCursor {
  if (typeof value !== "object" || value === null) return false;
  const { inbox, sent } = value as Partial<OutlookCursor>;
  return Boolean(inbox && sent);
}

/**
 * A tampered/unreadable cursor parses to null (see parseOpaqueCursor in
 * syncProviders.ts) — restart the backfill from the fresh-start state rather
 * than erroring on the same corrupt cursor every sweep forever.
 */
function parseCursor(cursor: string | null): OutlookCursor {
  return (
    parseOpaqueCursor(cursor, isOutlookCursor) ?? {
      inbox: { link: null, done: false },
      sent: { link: null, done: false },
    }
  );
}

interface GraphDeltaMessage {
  id: string;
  subject?: string;
  from?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  receivedDateTime?: string;
  sentDateTime?: string;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  isRead?: boolean;
  conversationId?: string;
  isDraft?: boolean;
  /** Present (with no other useful fields) when this id was removed from the folder. */
  "@removed"?: { reason?: string };
}

interface GraphDeltaResponse {
  value?: GraphDeltaMessage[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

function toSyncMessage(message: GraphDeltaMessage, stream: StreamKey): SyncMessage {
  const rawBody = message.body?.content ?? "";
  const bodyText =
    message.body?.contentType?.toLowerCase() === "html" ? stripHtml(rawBody) : rawBody.trim();
  return {
    providerMessageId: message.id,
    providerThreadId: message.conversationId ?? message.id,
    subject: message.subject ?? "",
    from: formatRecipient(message.from) ?? "",
    to: formatRecipients(message.toRecipients),
    cc: formatRecipients(message.ccRecipients),
    // Contract requires a sane, orderable date — "now" beats "" if Graph ever
    // omits both timestamps.
    date: message.receivedDateTime ?? message.sentDateTime ?? new Date().toISOString(),
    snippet: message.bodyPreview ?? "",
    bodyText,
    isFromMe: stream === "sent",
    // Sent mail is always treated as read — only inbox unread state is meaningful.
    isUnread: stream === "inbox" && message.isRead === false,
    labels: [stream],
  };
}

/** Split one delta page's raw entries into upserts and deletes, skipping drafts entirely. */
function splitPage(
  res: GraphDeltaResponse,
  stream: StreamKey,
): { upserts: SyncMessage[]; deletes: string[] } {
  const upserts: SyncMessage[] = [];
  const deletes: string[] = [];
  for (const message of res.value ?? []) {
    if ("@removed" in message) {
      deletes.push(message.id);
      continue;
    }
    if (message.isDraft) continue;
    upserts.push(toSyncMessage(message, stream));
  }
  return { upserts, deletes };
}

/** Fold a Graph delta response's paging links into the stream's next resume state. */
function nextStreamState(res: GraphDeltaResponse, prev: StreamState): StreamState {
  const deltaLink = res["@odata.deltaLink"];
  if (deltaLink) return { link: deltaLink, done: true };
  const nextLink = res["@odata.nextLink"];
  if (nextLink) return { link: nextLink, done: false };
  // Graph always returns one of the two; if a future response somehow omits both,
  // treat it as caught up on the existing link rather than looping forever.
  return { link: prev.link, done: true };
}

/** One Graph request for a stream: its stored link verbatim, or the initial bounded-backfill query. */
async function fetchStreamPage(
  account: ConnectedAccount,
  stream: StreamKey,
  state: StreamState,
  opts: SyncOptions,
): Promise<GraphDeltaResponse> {
  if (state.link) {
    return (await proxyRequest(account.id, "get", state.link)) as GraphDeltaResponse;
  }
  const since = new Date(Date.now() - opts.backfillDays * 24 * 60 * 60 * 1000).toISOString();
  return (await proxyRequest(
    account.id,
    "get",
    `${GRAPH_API}/mailFolders('${FOLDER_ID[stream]}')/messages/delta`,
    {
      params: {
        $select: DELTA_SELECT,
        $top: String(opts.pageSize),
        $filter: `receivedDateTime ge ${since}`,
      },
    },
  )) as GraphDeltaResponse;
}

/** Substrings Graph is documented to use for a stale delta token when it doesn't surface a clean 410. */
const CURSOR_EXPIRED_MARKERS = ["resyncrequired", "syncstatenotfound"];

function isCursorExpiredError(error: unknown): boolean {
  if (!(error instanceof PipedreamError)) return false;
  if (error.statusCode === 410) return true;
  const body = JSON.stringify(error.body ?? "").toLowerCase();
  return CURSOR_EXPIRED_MARKERS.some((marker) => body.includes(marker));
}

async function fetchChanges(
  account: ConnectedAccount,
  cursor: string | null,
  opts: SyncOptions,
): Promise<SyncPage> {
  const state = parseCursor(cursor);
  try {
    if (!state.inbox.done || !state.sent.done) {
      // Advance exactly one not-done stream per call, inbox first.
      const stream: StreamKey = !state.inbox.done ? "inbox" : "sent";
      const res = await fetchStreamPage(account, stream, state[stream], opts);
      const { upserts, deletes } = splitPage(res, stream);
      const updated = nextStreamState(res, state[stream]);
      const next: OutlookCursor =
        stream === "inbox"
          ? { inbox: updated, sent: state.sent }
          : { inbox: state.inbox, sent: updated };
      const otherDone = stream === "inbox" ? state.sent.done : state.inbox.done;
      return {
        upserts,
        deletes,
        cursor: JSON.stringify(next),
        // A nextLink always means more paging work; a deltaLink means this stream is
        // caught up, so there's more only if the other stream hasn't reached it too.
        hasMore: !updated.done || !otherDone,
      };
    }

    // Steady state: one deltaLink sweep per stream, merged into a single page.
    const [inboxRes, sentRes] = await Promise.all([
      fetchStreamPage(account, "inbox", state.inbox, opts),
      fetchStreamPage(account, "sent", state.sent, opts),
    ]);
    const inboxSplit = splitPage(inboxRes, "inbox");
    const sentSplit = splitPage(sentRes, "sent");
    const inboxState = nextStreamState(inboxRes, state.inbox);
    const sentState = nextStreamState(sentRes, state.sent);
    return {
      upserts: [...inboxSplit.upserts, ...sentSplit.upserts],
      deletes: [...inboxSplit.deletes, ...sentSplit.deletes],
      cursor: JSON.stringify({ inbox: inboxState, sent: sentState } satisfies OutlookCursor),
      // Only pages if a burst of changes made either sweep return a nextLink instead
      // of settling straight back on its deltaLink.
      hasMore: !inboxState.done || !sentState.done,
    };
  } catch (error) {
    // Never thrown for cursor === null — an initial backfill query can't hold a stale
    // delta token, so any 410 there is a real error the engine should surface as-is.
    if (cursor !== null && isCursorExpiredError(error)) {
      throw new SyncCursorExpiredError();
    }
    throw error;
  }
}

/** Graph field selected by fetchMessageHeaders — the delta streams above never request this (see DELTA_SELECT). */
const HEADERS_SELECT = "internetMessageHeaders";

interface GraphMessageHeader {
  name: string;
  value: string;
}

interface GraphMessageHeadersResponse {
  internetMessageHeaders?: GraphMessageHeader[];
}

/**
 * Lazy per-message header fetch: the one capability the delta streams above
 * can't provide (Graph's delta query never returns internetMessageHeaders,
 * with or without $select). One Graph request per call — callers
 * (email/unsubscribe/resolve.ts) bound how often this runs and persist the
 * result so the same message is never re-fetched.
 */
async function fetchMessageHeaders(
  account: ConnectedAccount,
  providerMessageId: string,
): Promise<{ listUnsubscribe?: string; listUnsubscribePost?: boolean }> {
  const res = (await proxyRequest(account.id, "get", `${GRAPH_API}/messages/${providerMessageId}`, {
    params: { $select: HEADERS_SELECT },
  })) as GraphMessageHeadersResponse;
  const headers = res.internetMessageHeaders ?? [];
  const find = (name: string) =>
    headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;

  const listUnsubscribe = find("List-Unsubscribe");
  if (!listUnsubscribe) return {};
  // Presence (not content) of the header is the RFC 8058 one-click signal —
  // same convention as ../gmail/sync.ts's toSyncMessage.
  return { listUnsubscribe, listUnsubscribePost: find("List-Unsubscribe-Post") !== undefined };
}

/** This module's SyncProvider — registered by ./sync/registerSyncProviders.ts. */
export const outlookSyncProvider: SyncProvider = { fetchChanges, fetchMessageHeaders };
