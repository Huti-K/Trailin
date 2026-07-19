import type { ConnectedAccount } from "@trailin/shared";
import { proxyRequest } from "../../integrations/pipedream/connect.js";

export const GRAPH_API = "https://graph.microsoft.com/v1.0/me";

/** Page size; Graph's own default (10) is too small for an active thread. */
const CONVERSATION_PAGE_SIZE = 50;

interface GraphMessagePage<T> {
  value?: T[];
  "@odata.nextLink"?: string;
}

/**
 * Messages of one conversation, paging `@odata.nextLink` up to `cap` (the last
 * page is trimmed to it). `$orderby` is deliberately not combined with
 * `$filter`, which Graph often rejects as inefficient, so the caller orders the
 * result itself; an unknown conversation comes back empty.
 */
export async function fetchConversationMessages<T>(
  account: ConnectedAccount,
  threadId: string,
  select: string,
  cap: number,
  signal?: AbortSignal,
): Promise<T[]> {
  // OData escapes a single quote by doubling it.
  const escapedThreadId = threadId.replace(/'/g, "''");
  const messages: T[] = [];
  let url = `${GRAPH_API}/messages`;
  let params: Record<string, string> | undefined = {
    $filter: `conversationId eq '${escapedThreadId}'`,
    $select: select,
    $top: String(Math.min(cap, CONVERSATION_PAGE_SIZE)),
  };

  while (messages.length < cap) {
    const res = (await proxyRequest(account.id, "get", url, {
      params,
      signal,
    })) as GraphMessagePage<T>;
    messages.push(...(res.value ?? []));
    const nextLink = res["@odata.nextLink"];
    if (!nextLink) break;
    // nextLink already carries the full query, so passing params again would duplicate it.
    url = nextLink;
    params = undefined;
  }
  return messages.slice(0, cap);
}

export interface GraphRecipient {
  emailAddress?: { name?: string; address?: string };
}

function recipientAddress(recipient: GraphRecipient | undefined): string | undefined {
  const address = recipient?.emailAddress?.address;
  return address?.trim() || undefined;
}

function recipientAddresses(recipients: GraphRecipient[] | undefined): string[] {
  return (recipients ?? []).map(recipientAddress).filter((a): a is string => !!a);
}

export function addressListOf(recipients: GraphRecipient[] | undefined): string {
  return recipientAddresses(recipients).join(", ");
}

/** "Name <address>", which Graph splits into separate fields; bare address or name when one half is missing, undefined when neither. */
export function formatRecipient(recipient: GraphRecipient | undefined): string | undefined {
  const address = recipient?.emailAddress?.address?.trim();
  const name = recipient?.emailAddress?.name?.trim();
  if (!address) return name || undefined;
  return name && name !== address ? `${name} <${address}>` : address;
}

export function formatRecipients(recipients: GraphRecipient[] | undefined): string[] {
  return (recipients ?? []).map(formatRecipient).filter((r): r is string => !!r);
}

/** The item with the latest `receivedDateTime` (ISO-8601 sorts correctly as plain strings); undefined for an empty list, a missing field sorts oldest. */
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
