/**
 * Microsoft Graph message helpers shared by the Outlook drivers
 * (outlookDrafts.ts, outlookSync.ts). Before this module each file carried
 * its own GraphRecipient type and "Name <addr>" formatter, character for
 * character.
 */

export const GRAPH_API = "https://graph.microsoft.com/v1.0/me";

export interface GraphRecipient {
  emailAddress?: { name?: string; address?: string };
}

/** Bare address of one recipient; undefined when Graph gave none. */
export function recipientAddress(recipient: GraphRecipient | undefined): string | undefined {
  const address = recipient?.emailAddress?.address;
  return address?.trim() || undefined;
}

/** Bare addresses only, as an array — what EmailThreadMessage's to/cc want. */
export function recipientAddresses(recipients: GraphRecipient[] | undefined): string[] {
  return (recipients ?? []).map(recipientAddress).filter((a): a is string => !!a);
}

/** Bare addresses joined the way a mail header would list them. */
export function addressListOf(recipients: GraphRecipient[] | undefined): string {
  return recipientAddresses(recipients).join(", ");
}

/**
 * "Name <address>" the way a mail header would render it — Graph gives name
 * and address as separate fields rather than a single header string like
 * Gmail's. Bare address (or name) when the other half is missing; undefined
 * when there's nothing at all.
 */
export function formatRecipient(recipient: GraphRecipient | undefined): string | undefined {
  const address = recipient?.emailAddress?.address?.trim();
  const name = recipient?.emailAddress?.name?.trim();
  if (!address) return name || undefined;
  return name && name !== address ? `${name} <${address}>` : address;
}

/** "Name <address>" per entry, dropping recipients Graph left empty. */
export function formatRecipients(recipients: GraphRecipient[] | undefined): string[] {
  return (recipients ?? []).map(formatRecipient).filter((r): r is string => !!r);
}

/**
 * The item with the lexicographically latest `receivedDateTime` (ISO-8601
 * sorts correctly as plain strings, same assumption the thread/sync date
 * sorts elsewhere in this codebase already make). Undefined for an empty
 * list; an item missing the field sorts as if it were the oldest.
 *
 * Used to find "the newest message in a conversation" — e.g. the target for
 * a Graph createReply call — without requiring the whole page to already be
 * date-sorted.
 */
export function newestByReceivedDate<T extends { receivedDateTime?: string }>(
  items: T[],
): T | undefined {
  return items.reduce<T | undefined>((newest, item) => {
    if (!newest) return item;
    return (item.receivedDateTime ?? "").localeCompare(newest.receivedDateTime ?? "") > 0
      ? item
      : newest;
  }, undefined);
}
