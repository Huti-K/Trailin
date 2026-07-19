import type { ConnectedAccount, EmailThreadMessage } from "@trailin/shared";
import { upstreamStatusCode } from "../../core/errors.js";
import { mapWithConcurrency } from "../../core/utils/jobs.js";
import { proxyRequest } from "../../integrations/pipedream/connect.js";
import type { MailReadProvider, SentMessage, ThreadDetail } from "../read/readProviders.js";
import { splitAddressList } from "../textUtils.js";
import {
  decodeHeaderText,
  GMAIL_API,
  headerLookup,
  type MessagePart,
  plainTextBody,
  type ThreadGetMessage,
  type ThreadGetResponse,
} from "./message.js";

/** Gmail messages.list `after:` takes epoch seconds; the per-id fetches that follow are concurrency-capped. */
const BATCH_CONCURRENCY = 5;

const DEFAULT_LIMIT = 50;

interface MessagesListResponse {
  messages?: { id: string }[];
}

interface GmailMessageFull {
  id: string;
  threadId: string;
  internalDate?: string;
  payload?: MessagePart & { headers?: { name: string; value: string }[] };
}

function toSentMessage(msg: GmailMessageFull): SentMessage {
  const header = headerLookup(msg.payload);
  return {
    providerMessageId: msg.id,
    providerThreadId: msg.threadId,
    subject: decodeHeaderText(header("Subject")),
    // Decode encoded-words AFTER splitting: a decoded display name may contain a comma that would create a bogus entry.
    to: splitAddressList(header("To")).map(decodeHeaderText),
    date: msg.internalDate
      ? new Date(Number(msg.internalDate)).toISOString()
      : new Date().toISOString(),
    bodyText: plainTextBody(msg.payload),
  };
}

async function listSentSince(
  account: ConnectedAccount,
  sinceIso: string,
  opts?: { limit?: number; signal?: AbortSignal },
): Promise<SentMessage[]> {
  const limit = opts?.limit ?? DEFAULT_LIMIT;
  const afterEpochSeconds = Math.floor(Date.parse(sinceIso) / 1000);
  // messages.list returns newest first, so maxResults keeps the newest `limit`; the final sort restores oldest-first.
  const list = (await proxyRequest(account.id, "get", `${GMAIL_API}/messages`, {
    params: {
      q: `in:sent after:${afterEpochSeconds}`,
      maxResults: String(limit),
    },
    signal: opts?.signal,
  })) as MessagesListResponse;
  const ids = (list.messages ?? []).map((m) => m.id);

  const full = await mapWithConcurrency(ids, BATCH_CONCURRENCY, async (id) => {
    return (await proxyRequest(account.id, "get", `${GMAIL_API}/messages/${id}`, {
      params: { format: "full" },
      signal: opts?.signal,
    })) as GmailMessageFull;
  });

  return full.map(toSentMessage).sort((a, b) => a.date.localeCompare(b.date));
}

async function newestInbound(
  account: ConnectedAccount,
  opts?: { knownId?: string; signal?: AbortSignal },
): Promise<{ id: string; date: string | null } | null> {
  const list = (await proxyRequest(account.id, "get", `${GMAIL_API}/messages`, {
    params: { q: "in:inbox", maxResults: "1" },
    signal: opts?.signal,
  })) as MessagesListResponse;
  const id = list.messages?.[0]?.id;
  if (!id) return null;
  // Newest is the id the caller already knows, so skip the date fetch (contract: date is null exactly when id === knownId).
  if (id === opts?.knownId) return { id, date: null };
  const msg = (await proxyRequest(account.id, "get", `${GMAIL_API}/messages/${id}`, {
    params: { format: "minimal" },
    signal: opts?.signal,
  })) as GmailMessageFull;
  return {
    id,
    // internalDate is a millisecond epoch carried as a string.
    date: msg.internalDate
      ? new Date(Number(msg.internalDate)).toISOString()
      : new Date().toISOString(),
  };
}

async function getMessageBody(
  account: ConnectedAccount,
  providerMessageId: string,
  signal?: AbortSignal,
): Promise<string | null> {
  let msg: GmailMessageFull;
  try {
    msg = (await proxyRequest(account.id, "get", `${GMAIL_API}/messages/${providerMessageId}`, {
      params: { format: "full" },
      signal,
    })) as GmailMessageFull;
  } catch (error) {
    if (upstreamStatusCode(error) === 404) return null;
    throw error;
  }
  return plainTextBody(msg.payload);
}

function toThreadMessage(msg: ThreadGetMessage): EmailThreadMessage {
  const header = headerLookup(msg.payload);
  const cc = splitAddressList(header("Cc")).map(decodeHeaderText);
  return {
    ...(msg.id ? { id: msg.id } : {}),
    from: decodeHeaderText(header("From")),
    to: splitAddressList(header("To")).map(decodeHeaderText),
    ...(cc.length > 0 ? { cc } : {}),
    date: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : "",
    body: plainTextBody(msg.payload),
  };
}

async function getThread(
  account: ConnectedAccount,
  providerThreadId: string,
  signal?: AbortSignal,
): Promise<ThreadDetail | null> {
  let res: ThreadGetResponse;
  try {
    res = (await proxyRequest(
      account.id,
      "get",
      `${GMAIL_API}/threads/${encodeURIComponent(providerThreadId)}`,
      { params: { format: "full" }, signal },
    )) as ThreadGetResponse;
  } catch (error) {
    if (upstreamStatusCode(error) === 404) return null;
    throw error;
  }
  // Unsent drafts sit inside the thread they answer; the view does not echo them as sent.
  const messages = (res.messages ?? [])
    .filter((m) => !m.labelIds?.includes("DRAFT"))
    .sort((a, b) => Number(a.internalDate ?? 0) - Number(b.internalDate ?? 0));
  if (messages.length === 0) return null;

  return {
    subject: decodeHeaderText(headerLookup(messages[0]?.payload)("Subject")),
    messages: messages.map(toThreadMessage),
  };
}

export const gmailReadProvider: MailReadProvider = {
  newestInbound,
  listSentSince,
  getMessageBody,
  getThread,
};
