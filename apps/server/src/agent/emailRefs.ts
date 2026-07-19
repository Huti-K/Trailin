import type { EmailRef } from "@trailin/shared";
import { isNonEmptyString, isRecord } from "../core/utils/util.js";

/**
 * Owns EmailRef serialization (messages.refs). Refs are never inferred by the
 * model, only supplied by the client on a user turn.
 */

export function serializeRefs(refs: EmailRef[] | undefined): string | null {
  return refs && refs.length > 0 ? JSON.stringify(refs) : null;
}

/** threadId/accountId are required (the account's read/draft tools need both); returns undefined for anything malformed. */
export function parseEmailRef(value: unknown): EmailRef | undefined {
  if (!isRecord(value)) return undefined;
  const { threadId, accountId, accountName, messageId, subject, from, date } = value;
  if (!isNonEmptyString(threadId) || !isNonEmptyString(accountId)) return undefined;
  return {
    threadId,
    accountId,
    ...(isNonEmptyString(accountName) ? { accountName } : {}),
    ...(isNonEmptyString(messageId) ? { messageId } : {}),
    ...(isNonEmptyString(subject) ? { subject } : {}),
    ...(isNonEmptyString(from) ? { from } : {}),
    ...(isNonEmptyString(date) ? { date } : {}),
  };
}

/** Our own db write, but it round-trips through JSON, so malformed entries are dropped rather than crashing message restore. */
export function parseStoredRefs(raw: string | null | undefined): EmailRef[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    const refs = parsed.map(parseEmailRef).filter((r): r is EmailRef => r !== undefined);
    return refs.length > 0 ? refs : undefined;
  } catch {
    return undefined;
  }
}

export function renderRefNotes(refs: EmailRef[]): string {
  return refs
    .map((ref) => {
      const parts = [`thread ${ref.threadId} in ${ref.accountName ?? ref.accountId}`];
      if (ref.subject) parts.push(`subject "${ref.subject}"`);
      if (ref.from) parts.push(`from ${ref.from}`);
      if (ref.date) parts.push(`date ${ref.date}`);
      return (
        `[Attached email: ${parts.join(", ")}. This reference is authoritative — read this ` +
        `exact thread with the account's thread read tool and use its threadId for any reply ` +
        `draft; do not search for a different match.]`
      );
    })
    .join("\n");
}

/** The persisted message row keeps `content` raw (see turnRecorder.ts); only the live prompt is decorated with the ref notes. */
export function decoratePrompt(content: string, refs: EmailRef[] | undefined): string {
  if (!refs || refs.length === 0) return content;
  return `${content}\n\n${renderRefNotes(refs)}`;
}
