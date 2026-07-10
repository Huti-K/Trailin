/**
 * Provider-neutral text helpers shared by the mail provider drivers. Kept out
 * of any one provider file so gmail/outlook/demo don't each carry a drifting
 * copy — before this module, stripHtml existed three times and the snippet
 * builder four, character for character.
 */

/** Crude but serviceable: strip tags for display when a body/preview is HTML. */
export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .trim();
}

const SNIPPET_MAX_LENGTH = 140;

/** One-line preview for list rows: collapse whitespace, cap length (the demo mailbox uses a roomier 200). */
export function snippetFrom(text: string, maxLength = SNIPPET_MAX_LENGTH): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, maxLength).trimEnd()}…`;
}

/** Split a To/Cc-style header value ("a@x.com, B <b@y.com>") into its entries. */
export function splitAddressList(value: string): string[] {
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}
