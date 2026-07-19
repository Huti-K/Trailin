import addrs from "email-addresses";
import { type HtmlToTextOptions, htmlToText } from "html-to-text";

/** Keep link text but drop hrefs and images; keep heading case (html-to-text uppercases headings by default). */
const STRIP_HTML_OPTIONS: HtmlToTextOptions = {
  wordwrap: false,
  selectors: [
    { selector: "a", options: { ignoreHref: true } },
    { selector: "img", format: "skip" },
    ...["h1", "h2", "h3", "h4", "h5", "h6"].map((selector) => ({
      selector,
      options: { uppercase: false },
    })),
  ],
};

export function stripHtml(html: string): string {
  return htmlToText(html, STRIP_HTML_OPTIONS).trim();
}

const SNIPPET_MAX_LENGTH = 140;

export function snippetFrom(text: string, maxLength = SNIPPET_MAX_LENGTH): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, maxLength).trimEnd()}…`;
}

/**
 * Split a To/Cc header value into entries. RFC 5322-aware: a quoted display
 * name may itself contain commas, so the value is parsed rather than split, and
 * groups are flattened; a value that doesn't parse falls back to a comma split.
 */
export function splitAddressList(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  const parsed = addrs.parseAddressList({ input: trimmed, rfc6532: true });
  if (!parsed) {
    return trimmed
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return parsed
    .flatMap((entry) => (entry.type === "group" ? entry.addresses : [entry]))
    .map((mailbox) => (mailbox.name ? `${mailbox.name} <${mailbox.address}>` : mailbox.address));
}
