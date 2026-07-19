import type { ConnectedAccount, EmailThreadMessage } from "@trailin/shared";
import { upstreamStatusCode } from "../../core/errors.js";
import { proxyRequest } from "../../integrations/pipedream/connect.js";
import type { MailReadProvider, SentMessage, ThreadDetail } from "../read/readProviders.js";
import { stripHtml } from "../textUtils.js";
import {
  fetchConversationMessages,
  formatRecipient,
  formatRecipients,
  GRAPH_API,
  type GraphRecipient,
} from "./message.js";

const DEFAULT_LIMIT = 50;

const SENT_SELECT = "subject,toRecipients,sentDateTime,body,conversationId";

const THREAD_SELECT = "subject,from,toRecipients,ccRecipients,receivedDateTime,body,isDraft";

/** Display cap on a conversation view, not a paging unit. */
const THREAD_LIMIT = 50;

interface GraphSentMessage {
  id: string;
  conversationId?: string;
  subject?: string;
  toRecipients?: GraphRecipient[];
  sentDateTime?: string;
  body?: { contentType?: string; content?: string };
}

interface GraphThreadMessage {
  id: string;
  subject?: string;
  from?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  receivedDateTime?: string;
  body?: { contentType?: string; content?: string };
  isDraft?: boolean;
}

interface GraphListResponse {
  value?: GraphSentMessage[];
  "@odata.nextLink"?: string;
}

interface GraphThreadListResponse {
  value?: GraphThreadMessage[];
  "@odata.nextLink"?: string;
}

function bodyTextOf(message: { body?: { contentType?: string; content?: string } }): string {
  const rawBody = message.body?.content ?? "";
  return message.body?.contentType?.toLowerCase() === "html" ? stripHtml(rawBody) : rawBody.trim();
}

function toSentMessage(message: GraphSentMessage): SentMessage {
  return {
    providerMessageId: message.id,
    providerThreadId: message.conversationId ?? message.id,
    subject: message.subject ?? "",
    to: formatRecipients(message.toRecipients),
    date: message.sentDateTime ?? new Date().toISOString(),
    bodyText: bodyTextOf(message),
  };
}

async function listSentSince(
  account: ConnectedAccount,
  sinceIso: string,
  opts?: { limit?: number; signal?: AbortSignal },
): Promise<SentMessage[]> {
  const limit = opts?.limit ?? DEFAULT_LIMIT;
  const messages: SentMessage[] = [];

  // Queried newest-first so the cap keeps the newest `limit`; reversed into oldest-first for return.
  let page = (await proxyRequest(
    account.id,
    "get",
    `${GRAPH_API}/mailFolders('sentitems')/messages`,
    {
      params: {
        $select: SENT_SELECT,
        $filter: `sentDateTime ge ${sinceIso}`,
        $orderby: "sentDateTime desc",
        $top: String(Math.min(limit, DEFAULT_LIMIT)),
      },
      signal: opts?.signal,
    },
  )) as GraphListResponse;

  for (;;) {
    for (const message of page.value ?? []) {
      messages.push(toSentMessage(message));
      if (messages.length >= limit) return messages.reverse();
    }
    const next = page["@odata.nextLink"];
    if (!next) return messages.reverse();
    page = (await proxyRequest(account.id, "get", next, {
      signal: opts?.signal,
    })) as GraphListResponse;
  }
}

async function newestInbound(
  account: ConnectedAccount,
  opts?: { knownId?: string; signal?: AbortSignal },
): Promise<{ id: string; date: string | null } | null> {
  // id and receivedDateTime come back together, so there's no second fetch for knownId to short-circuit.
  const page = (await proxyRequest(
    account.id,
    "get",
    `${GRAPH_API}/mailFolders('inbox')/messages`,
    {
      params: {
        $select: "id,receivedDateTime",
        $orderby: "receivedDateTime desc",
        $top: "1",
      },
      signal: opts?.signal,
    },
  )) as GraphThreadListResponse;
  const newest = page.value?.[0];
  if (!newest) return null;
  return { id: newest.id, date: newest.receivedDateTime ?? null };
}

async function getMessageBody(
  account: ConnectedAccount,
  providerMessageId: string,
  signal?: AbortSignal,
): Promise<string | null> {
  let message: GraphSentMessage;
  try {
    message = (await proxyRequest(account.id, "get", `${GRAPH_API}/messages/${providerMessageId}`, {
      params: { $select: "id,body" },
      signal,
    })) as GraphSentMessage;
  } catch (error) {
    if (upstreamStatusCode(error) === 404) return null;
    throw error;
  }
  return bodyTextOf(message);
}

function toThreadMessage(message: GraphThreadMessage): EmailThreadMessage {
  return {
    id: message.id,
    from: formatRecipient(message.from) ?? "",
    to: formatRecipients(message.toRecipients),
    ...(message.ccRecipients?.length ? { cc: formatRecipients(message.ccRecipients) } : {}),
    date: message.receivedDateTime ?? "",
    body: bodyTextOf(message),
  };
}

async function getThread(
  account: ConnectedAccount,
  providerThreadId: string,
  signal?: AbortSignal,
): Promise<ThreadDetail | null> {
  const messages = await fetchConversationMessages<GraphThreadMessage>(
    account,
    providerThreadId,
    THREAD_SELECT,
    THREAD_LIMIT,
    signal,
  );

  // Cull unsent drafts here, not in the OData $filter, which rejects some property combinations as inefficient; an unknown conversation just comes back empty.
  const exchanged = messages
    .filter((m) => !m.isDraft)
    .sort((a, b) => (a.receivedDateTime ?? "").localeCompare(b.receivedDateTime ?? ""));
  if (exchanged.length === 0) return null;

  return { subject: exchanged[0]?.subject ?? "", messages: exchanged.map(toThreadMessage) };
}

export const outlookReadProvider: MailReadProvider = {
  newestInbound,
  listSentSince,
  getMessageBody,
  getThread,
};
