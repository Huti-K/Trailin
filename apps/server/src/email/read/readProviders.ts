import type { ConnectedAccount, EmailThreadMessage } from "@trailin/shared";
import { createProviderRegistry } from "../registry.js";

/** Live mail-read drivers, one per app slug; mail is read straight from the provider and never stored locally. */

export interface SentMessage {
  providerMessageId: string;
  providerThreadId: string;
  subject: string;
  /** Recipients in `"Name <addr>"` form. */
  to: string[];
  /** ISO timestamp, orderable. */
  date: string;
  /** Plain text; HTML-only bodies arrive tag-stripped. */
  bodyText: string;
}

/** A thread for display: subject plus messages, oldest first. */
export interface ThreadDetail {
  subject: string;
  messages: EmailThreadMessage[];
}

export interface MailReadProvider {
  /**
   * The account's newest inbox message as `{ id, date }` (ISO), or null for an
   * empty inbox. When the newest id equals `opts.knownId`, a provider may
   * answer `{ id, date: null }` without a second fetch, since the caller
   * already holds that message's date.
   */
  newestInbound(
    account: ConnectedAccount,
    opts?: { knownId?: string; signal?: AbortSignal },
  ): Promise<{ id: string; date: string | null } | null>;
  /**
   * The account's sent mail after `sinceIso`, oldest first. When more than
   * `limit` exist in the range, the cap keeps the NEWEST `limit`, so recent
   * sends are never crowded out by an old anchor.
   */
  listSentSince(
    account: ConnectedAccount,
    sinceIso: string,
    opts?: { limit?: number; signal?: AbortSignal },
  ): Promise<SentMessage[]>;
  /** Plain-text body of one sent message, or null when it no longer exists (404). */
  getMessageBody(
    account: ConnectedAccount,
    providerMessageId: string,
    signal?: AbortSignal,
  ): Promise<string | null>;
  /**
   * Optional: one thread's messages, oldest first, drafts excluded (a reply
   * draft sits in the thread it answers). Null when the thread is gone (404) or
   * has no non-draft message. Absent means "not supported for this account" and
   * the route replies 400, provider-neutral.
   */
  getThread?(
    account: ConnectedAccount,
    providerThreadId: string,
    signal?: AbortSignal,
  ): Promise<ThreadDetail | null>;
}

const registry = createProviderRegistry<MailReadProvider>();

export const registerMailReadProvider = registry.register;
export const getMailReadProvider = registry.get;
