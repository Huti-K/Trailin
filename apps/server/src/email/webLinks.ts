import type { ConnectedAccount } from "@trailin/shared";

type ThreadLinkBuilder = (account: ConnectedAccount, providerThreadId: string) => string;

/**
 * `authuser=<email>` makes Gmail links resolve to the right account across
 * several signed-in Google accounts. Avoid the `/mail/u/<N>/` form: `N` is a
 * per-browser login-order index, and the email there (URL-encoded) 404s when
 * more than one account is signed in. `authuser` sits before the `#`
 * fragment; past it, Gmail's server never sees it.
 */
function gmailAuthUser(accountName: string): string {
  return accountName.includes("@") ? `?authuser=${encodeURIComponent(accountName)}` : "";
}

function gmailThreadUrl(accountName: string, threadId: string): string {
  return `https://mail.google.com/mail/${gmailAuthUser(accountName)}#all/${threadId}`;
}

export function gmailDraftUrl(accountName: string, messageId: string): string {
  return `https://mail.google.com/mail/${gmailAuthUser(accountName)}#drafts?compose=${messageId}`;
}

/**
 * Outlook web is split across two hosts by account class, and the split is
 * load-bearing: a personal (consumer) Microsoft account sent through the
 * organizational host hard-fails with AADSTS500200 rather than redirecting.
 * Personal accounts are recognized by Microsoft's consumer domains
 * (hotmail/outlook/live/msn); a personal account on a custom domain would be
 * misrouted, but nothing in the connected-account data distinguishes it.
 */
const OUTLOOK_WEB_ROOT = "https://outlook.office.com/mail/";
const OUTLOOK_CONSUMER_WEB_ROOT = "https://outlook.live.com/mail/";
const CONSUMER_MS_DOMAIN = /^(hotmail|outlook|live)\.|^msn\.com$/;

export function isConsumerOutlookAccount(accountName: string): boolean {
  const domain = accountName.split("@")[1]?.toLowerCase() ?? "";
  return CONSUMER_MS_DOMAIN.test(domain);
}

export function outlookWebRoot(accountName: string): string {
  return isConsumerOutlookAccount(accountName) ? OUTLOOK_CONSUMER_WEB_ROOT : OUTLOOK_WEB_ROOT;
}

/**
 * `login_hint=<email>` is Outlook web's counterpart of Gmail's `authuser`:
 * with several Microsoft accounts signed in, a bare URL opens whichever the
 * session defaults to. Outlook has no account-index path form, so every
 * Outlook link carries it. Appended as a raw string so an already-encoded
 * query (Graph ItemIDs contain `+` and `%2b`) is never re-serialized.
 */
export function withOutlookLoginHint(url: string, accountName: string): string {
  if (!accountName.includes("@")) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}login_hint=${encodeURIComponent(accountName)}`;
}

const THREAD_LINKS: Record<string, ThreadLinkBuilder> = {
  gmail: (account, threadId) => gmailThreadUrl(account.name, threadId),
  // No stable Outlook thread-by-conversationId URL, so land on the mailbox (pinned to the account) rather than risk a broken deep link.
  microsoft_outlook: (account) => withOutlookLoginHint(outlookWebRoot(account.name), account.name),
};

/** Thread deep link, or "" when the app has no known web UI. */
export function threadWebUrl(account: ConnectedAccount, providerThreadId: string): string {
  const builder = THREAD_LINKS[account.app];
  return builder ? builder(account, providerThreadId) : "";
}
