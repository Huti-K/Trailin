/**
 * Newsletter/bulk-sender unsubscribe types, shared between the server
 * (email/unsubscribe/*, routes/newsletters.ts) and any client of the API.
 * Split out of index.ts to keep that file under the repo's line cap — every
 * export here is re-exported from index.ts, so `@trailin/shared` itself is
 * unaffected.
 */

/**
 * Where a bulk sender's unsubscribe stands, judged from the newest mirrored
 * message's List-Unsubscribe headers (server: email/unsubscribe/parse.ts).
 * "one_click" can be automated (RFC 8058 POST); "browse" needs the user to
 * open a link themselves; "mailto_only" has no automatable or browsable
 * mechanism at all; "unknown" only occurs for a provider whose sync can't
 * carry headers (Outlook) before the server has lazily fetched them for this
 * sender; "none" covers both "confirmed no header" and "no mirrored message
 * yet".
 */
export const UNSUBSCRIBE_STATES = [
  "one_click",
  "browse",
  "mailto_only",
  "unknown",
  "none",
] as const;
export type UnsubscribeState = (typeof UNSUBSCRIBE_STATES)[number];

export interface UnsubscribeInfo {
  state: UnsubscribeState;
  /** Only present for state "browse" — the client opens this itself; nothing here is auto-fetched. */
  browseUrl?: string;
}

/** One bulk/newsletter sender (GET /api/newsletters), derived from contacts rows with kind="bulk". */
export interface NewsletterSender {
  address: string;
  displayName: string;
  messageCount: number;
  lastContactAt: string;
  /** Connected-account ids this sender corresponds on. */
  accounts: string[];
  unsubscribe: UnsubscribeInfo;
  /** Set once a one-click request succeeded — the lane renders "requested" instead of the button. */
  unsubscribeRequestedAt?: string;
}

/** Body of POST /api/newsletters/unsubscribe. */
export interface UnsubscribeRequest {
  address: string;
  accountId: string;
}

/** Response of POST /api/newsletters/unsubscribe on success (failure is a normal API error). */
export interface UnsubscribeResult {
  ok: true;
  state: "requested";
}
