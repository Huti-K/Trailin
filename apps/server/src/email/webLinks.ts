import type { ConnectedAccount } from "@trailin/shared";

/**
 * Webmail deep links, keyed by Pipedream app slug. Provider-specific by
 * nature, but kept in this one spot so features computed from the local
 * mailbox mirror (email/waiting.ts today) stay provider-neutral — add a new
 * provider's link builder here, not a branch at a call site. The web app's
 * counterpart (which hosts get the "open in mailbox" chip) lives in
 * apps/web/src/lib/mailboxLinks.ts.
 */

type ThreadLinkBuilder = (account: ConnectedAccount, providerThreadId: string) => string;

/**
 * `authuser=<email>` is what makes Gmail links survive multiple signed-in
 * Google accounts: Gmail resolves it to the right account regardless of
 * login order. We deliberately avoid the `/mail/u/<N>/` path form — `N` is a
 * per-browser login-order index (not stable), and putting the email there
 * (URL-encoded, so `@` becomes `%40`) 404s when more than one account is
 * signed in. `authuser` must sit before the `#` fragment or Gmail's server
 * never sees it.
 */
function gmailAuthUser(accountName: string): string {
  return accountName.includes("@") ? `?authuser=${encodeURIComponent(accountName)}` : "";
}

/** Deep link that opens a thread in the Gmail web UI. */
function gmailThreadUrl(accountName: string, threadId: string): string {
  return `https://mail.google.com/mail/${gmailAuthUser(accountName)}#all/${threadId}`;
}

/** Deep link that opens a specific draft in the Gmail web UI. */
export function gmailDraftUrl(accountName: string, messageId: string): string {
  return `https://mail.google.com/mail/${gmailAuthUser(accountName)}#drafts?compose=${messageId}`;
}

const THREAD_LINKS: Record<string, ThreadLinkBuilder> = {
  gmail: (account, threadId) => gmailThreadUrl(account.name, threadId),
  // Graph's per-message webLink isn't mirrored, and Outlook's web UI has no
  // stable thread-by-conversationId URL — land on the mailbox rather than
  // risk a broken deep link (same fallback rationale as outlookDrafts.ts's
  // outlookFallbackUrl).
  microsoft_outlook: () => "https://outlook.office.com/mail/",
};

/** Deep link to a thread in the account's webmail UI; "" when the app has no known web UI. */
export function threadWebUrl(account: ConnectedAccount, providerThreadId: string): string {
  const builder = THREAD_LINKS[account.app];
  return builder ? builder(account, providerThreadId) : "";
}
