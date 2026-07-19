import type { ConnectedAccount } from "@trailin/shared";

/**
 * Webmail deep links, keyed by Pipedream app slug. Provider-specific by
 * nature, but kept in this one spot so consumers (agent/briefingTool.ts)
 * stay provider-neutral — add a new provider's link builder here, not a
 * branch at a call site. The web app's counterpart (which hosts get the
 * "open in mailbox" chip) lives in apps/web/src/lib/mailboxLinks.ts.
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

/**
 * Outlook web is split across two hosts by account class, and the split is
 * load-bearing: sending a personal (consumer) Microsoft account through the
 * organizational host's sign-in hard-fails with AADSTS500200 ("personal
 * Microsoft accounts are not supported"), it doesn't redirect. Personal
 * accounts are recognized by Microsoft's own consumer email domains
 * (hotmail.*, outlook.*, live.*, msn.com); anything else is treated as a
 * work/school account. A personal account on a custom domain would be
 * misrouted, but nothing in the connected-account data distinguishes it.
 */
const OUTLOOK_WEB_ROOT = "https://outlook.office.com/mail/";
const OUTLOOK_CONSUMER_WEB_ROOT = "https://outlook.live.com/mail/";
const CONSUMER_MS_DOMAIN = /^(hotmail|outlook|live)\.|^msn\.com$/;

/** True when the account's email domain marks a personal Microsoft account. */
export function isConsumerOutlookAccount(accountName: string): boolean {
  const domain = accountName.split("@")[1]?.toLowerCase() ?? "";
  return CONSUMER_MS_DOMAIN.test(domain);
}

/** The Outlook web mailbox root for this account's class (work vs personal). */
export function outlookWebRoot(accountName: string): string {
  return isConsumerOutlookAccount(accountName) ? OUTLOOK_CONSUMER_WEB_ROOT : OUTLOOK_WEB_ROOT;
}

/**
 * `login_hint=<email>` is Outlook web's counterpart of Gmail's `authuser`:
 * with several Microsoft accounts signed in, a bare Outlook URL opens
 * whichever account the browser session defaults to. The hint routes through
 * Microsoft sign-in, which switches to (or silently signs in) the hinted
 * account instead. Outlook web has no account-index path form to pin an
 * account, so every Outlook link we hand out must carry this parameter — on
 * the host matching the account's class (see outlookWebRoot). Appended as a
 * raw string so an already-encoded query (Graph ItemIDs contain `+` and
 * `%2b`) is never re-serialized.
 */
export function withOutlookLoginHint(url: string, accountName: string): string {
  if (!accountName.includes("@")) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}login_hint=${encodeURIComponent(accountName)}`;
}

const THREAD_LINKS: Record<string, ThreadLinkBuilder> = {
  gmail: (account, threadId) => gmailThreadUrl(account.name, threadId),
  // Graph's per-message webLink isn't available here, and Outlook's web UI
  // has no stable thread-by-conversationId URL — land on the mailbox (pinned
  // to the right account) rather than risk a broken deep link.
  microsoft_outlook: (account) => withOutlookLoginHint(outlookWebRoot(account.name), account.name),
};

/** Deep link to a thread in the account's webmail UI; "" when the app has no known web UI. */
export function threadWebUrl(account: ConnectedAccount, providerThreadId: string): string {
  const builder = THREAD_LINKS[account.app];
  return builder ? builder(account, providerThreadId) : "";
}
