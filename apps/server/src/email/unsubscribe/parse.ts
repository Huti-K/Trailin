import type { UnsubscribeInfo } from "@trailin/shared";

/**
 * List-Unsubscribe (RFC 2369) carries a comma-separated list of `<uri>`
 * entries — typically a `mailto:` fallback and/or an https URL. RFC 8058
 * adds List-Unsubscribe-Post: when it's present alongside an https entry,
 * that URL accepts a one-click POST (see ./execute.ts) instead of requiring
 * a browser visit. Only https is ever usable here — http can't be trusted
 * with a request that changes subscription state (unauthenticated,
 * unencrypted, trivially spoofed), and RFC 8058's one-click flow is defined
 * for https only. http and any other scheme are dropped outright, the same
 * as a malformed or unbracketed entry.
 */

export interface ParsedUnsubscribe {
  /** https URL to POST per RFC 8058 — only set when List-Unsubscribe-Post was present. */
  oneClickUrl?: string;
  /** https URL to open in a browser — only set when no one-click support was signaled. */
  browseUrl?: string;
  /** True when every entry in the header was mailto: — no https URL of any kind. */
  mailtoOnly: boolean;
}

const URI_ENTRY = /<([^>]*)>/g;

/**
 * Parse one raw List-Unsubscribe header value plus whether
 * List-Unsubscribe-Post was present on the same message. When both an https
 * entry and one-click support exist, the https entry becomes oneClickUrl;
 * with no one-click support it becomes browseUrl instead. mailtoOnly is only
 * true when the header had no usable https entry at all (mailto entries
 * alongside a usable https one don't count — the https entry always wins).
 */
export function parseListUnsubscribe(
  headerValue: string,
  hasOneClickPost: boolean,
): ParsedUnsubscribe {
  const entries = [...headerValue.matchAll(URI_ENTRY)]
    .map((match) => match[1]?.trim() ?? "")
    .filter(Boolean);
  const httpsUrl = entries.find((entry) => /^https:\/\//i.test(entry));
  const hasMailto = entries.some((entry) => /^mailto:/i.test(entry));

  if (httpsUrl && hasOneClickPost) return { oneClickUrl: httpsUrl, mailtoOnly: false };
  if (httpsUrl) return { browseUrl: httpsUrl, mailtoOnly: false };
  return { mailtoOnly: hasMailto };
}

/**
 * Turn one parse result into the state the API/UI acts on. Never returns
 * "unknown" — that state describes whether headers were fetched at all, not
 * a header value already in hand (see ./resolve.ts, the only place that
 * decides "unknown" vs. calling this).
 */
export function classifyParsed(parsed: ParsedUnsubscribe): UnsubscribeInfo {
  if (parsed.oneClickUrl) return { state: "one_click" };
  if (parsed.browseUrl) return { state: "browse", browseUrl: parsed.browseUrl };
  if (parsed.mailtoOnly) return { state: "mailto_only" };
  return { state: "none" };
}
