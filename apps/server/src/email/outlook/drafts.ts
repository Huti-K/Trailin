import type { ConnectedAccount, CreatedDraft, EmailDraft } from "@trailin/shared";
import { moduleLogger } from "../../core/logger.js";
import { proxyRequest } from "../../integrations/pipedream/connect.js";
import { draftsMutated } from "../draftsCache.js";
import {
  type CreateDraftInput,
  DRAFTS_LIST_LIMIT,
  type DraftProvider,
  type SendDraftResult,
  type UpdateDraftPatch,
} from "../providers.js";
import { snippetFrom, stripHtml } from "../textUtils.js";
import { isConsumerOutlookAccount, outlookWebRoot, withOutlookLoginHint } from "../webLinks.js";
import { addOutlookAttachments } from "./draftAttachments.js";
import {
  addressListOf,
  fetchConversationMessages,
  GRAPH_API,
  type GraphRecipient,
  newestByReceivedDate,
} from "./message.js";

const log = moduleLogger("outlook-drafts");

/** List-view fields; only bodyPreview (not the full body) is needed for the snippet. */
const LIST_SELECT = "id,subject,toRecipients,ccRecipients,bodyPreview,lastModifiedDateTime,webLink";

const REPLY_TARGET_SELECT = "id,receivedDateTime";

/** Cap on messages paged through when finding the reply target, so a runaway thread can't make the lookup an unbounded loop of Graph requests. */
const CONVERSATION_MESSAGE_CAP = 100;

interface GraphMessage {
  id: string;
  subject?: string;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  bccRecipients?: GraphRecipient[];
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  lastModifiedDateTime?: string;
  receivedDateTime?: string;
  webLink?: string;
  /** Graph's rough equivalent of a Gmail threadId. */
  conversationId?: string;
}

interface ListMessagesResponse {
  value?: GraphMessage[];
  "@odata.nextLink"?: string;
}

function toRecipientsPayload(addresses: string[]): { emailAddress: { address: string } }[] {
  return addresses.map((address) => ({ emailAddress: { address } }));
}

/** The Drafts folder URL; consumer Outlook web nests folders under a fixed primary-mailbox index. */
function outlookDraftsFolderUrl(accountName: string): string {
  const root = outlookWebRoot(accountName);
  return isConsumerOutlookAccount(accountName) ? `${root}0/drafts` : `${root}drafts`;
}

/**
 * Graph returns `webLink` on every message, but it's only usable for
 * work/school accounts: it points at the organizational host, which rejects
 * personal Microsoft accounts (and is known-broken for outlook.com anyway).
 * Personal accounts, and any message missing webLink, land on the Drafts
 * folder. Every variant carries login_hint, since webLink names no account.
 */
function outlookDraftUrl(account: ConnectedAccount, webLink: string | undefined): string {
  const url =
    webLink && !isConsumerOutlookAccount(account.name)
      ? webLink
      : outlookDraftsFolderUrl(account.name);
  return withOutlookLoginHint(url, account.name);
}

function toEmailDraft(account: ConnectedAccount, message: GraphMessage): EmailDraft {
  const snippet = message.bodyPreview ? snippetFrom(message.bodyPreview) : "";
  return {
    id: message.id,
    // Outlook has no distinct "draft id": a draft is just a message in the Drafts folder.
    messageId: message.id,
    threadId: message.conversationId ?? "",
    subject: message.subject ?? "",
    to: addressListOf(message.toRecipients),
    date: message.lastModifiedDateTime ?? "",
    webUrl: outlookDraftUrl(account, message.webLink),
    ...(snippet ? { snippet } : {}),
  };
}

async function listOutlookDrafts(account: ConnectedAccount): Promise<EmailDraft[]> {
  const res = (await proxyRequest(account.id, "get", `${GRAPH_API}/mailFolders/drafts/messages`, {
    params: {
      $select: LIST_SELECT,
      $top: String(DRAFTS_LIST_LIMIT),
      $orderby: "lastModifiedDateTime desc",
    },
  })) as ListMessagesResponse;

  return (res.value ?? []).map((message) => toEmailDraft(account, message));
}

async function getOutlookDraftDetail(
  account: ConnectedAccount,
  draftId: string,
): Promise<{ body: string; cc: string; bcc: string }> {
  const message = (await proxyRequest(account.id, "get", `${GRAPH_API}/messages/${draftId}`, {
    params: { $select: "body,ccRecipients,bccRecipients" },
  })) as GraphMessage;

  const raw = message.body?.content ?? "";
  const body = message.body?.contentType?.toLowerCase() === "html" ? stripHtml(raw) : raw.trim();
  return {
    body,
    cc: addressListOf(message.ccRecipients),
    bcc: addressListOf(message.bccRecipients),
  };
}

async function deleteOutlookDraft(account: ConnectedAccount, draftId: string): Promise<void> {
  await proxyRequest(account.id, "delete", `${GRAPH_API}/messages/${draftId}`);
  draftsMutated(account.id);
}

/** Standalone-message path: no threadId, or a reply target that couldn't be resolved. */
async function createStandaloneOutlookDraft(
  account: ConnectedAccount,
  input: CreateDraftInput,
): Promise<GraphMessage> {
  return (await proxyRequest(account.id, "post", `${GRAPH_API}/messages`, {
    body: {
      subject: input.subject,
      body: { contentType: "Text", content: input.body },
      toRecipients: toRecipientsPayload(input.to),
      ...(input.cc?.length ? { ccRecipients: toRecipientsPayload(input.cc) } : {}),
      ...(input.bcc?.length ? { bccRecipients: toRecipientsPayload(input.bcc) } : {}),
    },
  })) as GraphMessage;
}

/**
 * A reply draft via Graph's createReply plus a follow-up PATCH. createReply
 * (not createReplyAll) mirrors ../gmail/drafts.ts, where the caller's to/cc/bcc
 * is the entire recipient list: createReply's "To: original sender only"
 * prefill errs toward fewer recipients than createReplyAll's "Cc: everyone
 * else" would. Falls back to a standalone draft when the conversation has no
 * messages.
 */
async function createOutlookReplyDraft(
  account: ConnectedAccount,
  input: CreateDraftInput,
  threadId: string,
): Promise<GraphMessage> {
  const target = newestByReceivedDate(
    await fetchConversationMessages<GraphMessage>(
      account,
      threadId,
      REPLY_TARGET_SELECT,
      CONVERSATION_MESSAGE_CAP,
    ),
  );
  if (!target) {
    log.warn(
      { accountId: account.id, threadId },
      "no messages found in conversation; creating a standalone draft instead",
    );
    return createStandaloneOutlookDraft(account, input);
  }

  const draft = (await proxyRequest(
    account.id,
    "post",
    `${GRAPH_API}/messages/${target.id}/createReply`,
    { body: {} },
  )) as GraphMessage;

  // The caller's body always wins; subject/to/cc/bcc override Graph's prefill only when actually supplied.
  return (await proxyRequest(account.id, "patch", `${GRAPH_API}/messages/${draft.id}`, {
    body: {
      body: { contentType: "Text", content: input.body },
      ...(input.subject ? { subject: input.subject } : {}),
      ...(input.to.length ? { toRecipients: toRecipientsPayload(input.to) } : {}),
      ...(input.cc?.length ? { ccRecipients: toRecipientsPayload(input.cc) } : {}),
      ...(input.bcc?.length ? { bccRecipients: toRecipientsPayload(input.bcc) } : {}),
    },
  })) as GraphMessage;
}

/** The proxy can answer an error envelope instead of a Graph message; a descriptive failure beats a bare TypeError from a cast. */
function requireDraftId(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Graph draft response carries no message id — unexpected response shape.");
  }
  return value;
}

async function createOutlookDraft(
  account: ConnectedAccount,
  input: CreateDraftInput,
): Promise<CreatedDraft> {
  const res = input.threadId
    ? await createOutlookReplyDraft(account, input, input.threadId)
    : await createStandaloneOutlookDraft(account, input);
  const draftId = requireDraftId(res.id);

  // Graph can't attach in the create call; a failure propagates, but the finally still invalidates since the draft exists either way.
  try {
    if (input.attachments?.length) {
      await addOutlookAttachments(account, draftId, input.attachments);
    }
  } finally {
    draftsMutated(account.id);
  }
  return {
    draftId,
    messageId: draftId,
    threadId: res.conversationId ?? "",
    webUrl: outlookDraftUrl(account, res.webLink),
  };
}

/** Graph's PATCH touches only the fields sent, so (unlike Gmail's whole-message drafts.update) there's no need to fetch and re-send unchanged fields. */
async function updateOutlookDraft(
  account: ConnectedAccount,
  draftId: string,
  patch: UpdateDraftPatch,
): Promise<void> {
  const body: Record<string, unknown> = {};
  if (patch.subject !== undefined) body.subject = patch.subject;
  // Always Text: an edit in Trailin's plain-text editor saves as plain text, not silently as HTML.
  if (patch.body !== undefined) body.body = { contentType: "Text", content: patch.body };

  await proxyRequest(account.id, "patch", `${GRAPH_API}/messages/${draftId}`, { body });

  draftsMutated(account.id);
}

/** Graph's send answers an empty 202 with no message id, so the result carries no sentMessageId and the learning loop matches this send later. */
async function sendOutlookDraft(
  account: ConnectedAccount,
  draftId: string,
): Promise<SendDraftResult> {
  await proxyRequest(account.id, "post", `${GRAPH_API}/messages/${draftId}/send`, { body: {} });
  draftsMutated(account.id);
  return {};
}

export const outlookDraftProvider: DraftProvider = {
  listDrafts: listOutlookDrafts,
  getDraftDetail: getOutlookDraftDetail,
  createDraft: createOutlookDraft,
  deleteDraft: deleteOutlookDraft,
  updateDraft: updateOutlookDraft,
  sendDraft: sendOutlookDraft,
};
