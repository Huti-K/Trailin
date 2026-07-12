/**
 * Web-UI hosts for providers whose links get the "open in mailbox" chip in
 * rendered markdown (see components/ui/markdown.tsx). Provider-specific by
 * nature, but kept in this one spot so the renderer itself stays generic —
 * add a new provider's webmail host here, not as a special case in the UI.
 */
const MAILBOX_HOSTS = new Set([
  "mail.google.com",
  "outlook.office.com",
  "outlook.office365.com", // Graph webLink host (draft deep links)
  "outlook.live.com",
]);

/** True when `href` is a link into a known provider's webmail UI (matched by hostname). */
export function isMailboxUrl(href: string | undefined): boolean {
  if (!href) return false;
  try {
    return MAILBOX_HOSTS.has(new URL(href).hostname);
  } catch {
    return false;
  }
}
