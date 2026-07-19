import { decodeHTML } from "entities";
import libmime from "libmime";
import { stripHtml } from "../textUtils.js";

export const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

export interface MessagePart {
  filename?: string;
  mimeType?: string;
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: MessagePart[];
}

type MessageHeaders = { headers?: { name: string; value: string }[] };

export interface ThreadGetMessage {
  id?: string;
  internalDate?: string;
  labelIds?: string[];
  payload?: MessagePart & { headers?: { name: string; value: string }[] };
}

export interface ThreadGetResponse {
  messages?: ThreadGetMessage[];
}

/** Case-insensitive header lookup over Gmail's `payload.headers`. */
export function headerLookup(payload: MessageHeaders | undefined) {
  const headers = payload?.headers ?? [];
  return (name: string) =>
    headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function findPart(part: MessagePart | undefined, mimeType: string): MessagePart | undefined {
  if (!part) return undefined;
  if (part.mimeType === mimeType && part.body?.data) return part;
  for (const child of part.parts ?? []) {
    const hit = findPart(child, mimeType);
    if (hit) return hit;
  }
  return undefined;
}

/** Visits every part with a non-empty filename, Gmail's definition of "this part is an attachment". */
export function forEachAttachmentPart(
  part: MessagePart | undefined,
  visit: (part: MessagePart, filename: string) => void,
): void {
  if (!part) return;
  if (part.filename) visit(part, part.filename);
  for (const child of part.parts ?? []) forEachAttachmentPart(child, visit);
}

function decodeBody(data: string): string {
  return Buffer.from(data, "base64url").toString("utf8");
}

export function plainTextBody(payload: MessagePart | undefined): string {
  const plain = findPart(payload, "text/plain");
  if (plain?.body?.data) return decodeBody(plain.body.data);
  const html = findPart(payload, "text/html");
  if (!html?.body?.data) return "";
  return stripHtml(decodeBody(html.body.data));
}

/** Decode the HTML entities Gmail escapes in `message.snippet`; non-breaking spaces become plain spaces. */
export function decodeHtmlEntities(text: string): string {
  return decodeHTML(text).replace(/\u00a0/g, " ");
}

/**
 * Decode RFC 2047 encoded-words (`=?UTF-8?B?…?=`): Gmail returns header values
 * verbatim from the RFC 822 source, so non-ASCII names/subjects arrive encoded.
 * A malformed encoding falls back to the raw value. Display-path only: code
 * that reuses headers to rebuild raw MIME (drafts.ts) keeps them verbatim.
 */
export function decodeHeaderText(value: string): string {
  if (!value.includes("=?")) return value;
  try {
    return libmime.decodeWords(value);
  } catch {
    return value;
  }
}
