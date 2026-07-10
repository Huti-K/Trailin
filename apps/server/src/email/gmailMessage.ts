import { stripHtml } from "./textUtils.js";

/**
 * Gmail message-payload helpers shared by every file that reads the Gmail
 * REST API (gmailDrafts.ts, gmailSync.ts, gmailAttachments.ts). Before this
 * module, gmailSync imported these as private helpers out of gmailDrafts and
 * gmailAttachments carried its own copy of the MIME walk — one provider's
 * wire format now lives in one place.
 */

export const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

/** One Gmail MIME part — the superset of what drafts, sync and attachments each read. */
export interface MessagePart {
  filename?: string;
  mimeType?: string;
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: MessagePart[];
}

export type MessageHeaders = { headers?: { name: string; value: string }[] };

/** Case-insensitive header lookup, the way Gmail's `payload.headers` needs to be read. */
export function headerLookup(payload: MessageHeaders | undefined) {
  const headers = payload?.headers ?? [];
  return (name: string) => headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

/** Depth-first search for the first part of the wanted MIME type. */
function findPart(part: MessagePart | undefined, mimeType: string): MessagePart | undefined {
  if (!part) return undefined;
  if (part.mimeType === mimeType && part.body?.data) return part;
  for (const child of part.parts ?? []) {
    const hit = findPart(child, mimeType);
    if (hit) return hit;
  }
  return undefined;
}

function decodeBody(data: string): string {
  return Buffer.from(data, "base64url").toString("utf8");
}

/**
 * Plain-text body of one message payload: text/plain if present, else
 * text/html with tags stripped (crude but serviceable for display). The one
 * MIME walker for every Gmail reader.
 */
export function plainTextBody(payload: MessagePart | undefined): string {
  const plain = findPart(payload, "text/plain");
  if (plain?.body?.data) return decodeBody(plain.body.data);
  const html = findPart(payload, "text/html");
  if (!html?.body?.data) return "";
  return stripHtml(decodeBody(html.body.data));
}

/**
 * Decode the common HTML entities Gmail escapes in `message.snippet`. Not a
 * full entity decoder — just enough for the handful Gmail actually emits.
 */
const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
};

export function decodeHtmlEntities(text: string): string {
  return text.replace(
    /&amp;|&lt;|&gt;|&quot;|&#39;|&nbsp;/g,
    (match) => HTML_ENTITIES[match] ?? match,
  );
}
