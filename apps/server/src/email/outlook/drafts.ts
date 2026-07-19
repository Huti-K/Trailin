import type { ConnectedAccount, CreatedDraft, EmailDraft } from "@trailin/shared";
import { moduleLogger } from "../../logger.js";
import { proxyRequest } from "../../pipedream/connect.js";
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

/**
 * Outlook / Microsoft 365 draft provider, via the Connect proxy against
 * Microsoft Graph v1.0 — the same proxy mechanism ../gmail/drafts.ts uses for
 * Gmail, just pointed at a different API. Registered under app slug
 * "microsoft_outlook" at the bottom of this file.
 *
 * `listOutlookDrafts` is a pure live fetch — no caching in here (see
 * ../draftsCache.ts, the shared cache every provider's listDrafts sits
 * behind). Every mutation below ends with draftsCache.ts's `draftsMutated`
 * epilogue, mirroring ../gmail/drafts.ts's flow.
 */

const log = moduleLogger("outlook-drafts");

/** Fields fetched for the drafts list — detail uses its own $select (see getOutlookDraftDetail), and the list view only needs bodyPreview for its snippet, not the full body. */
const LIST_SELECT = "id,subject,toRecipients,ccRecipients,bodyPreview,lastModifiedDateTime,webLink";

/** Fields fetched when a reply draft just needs to find the conversation's newest message id. */
const REPLY_TARGET_SELECT = "id,receivedDateTime";

/**
 * Hard cap on how many messages one conversation fetch will page through
 * while looking for the reply target — a runaway thread shouldn't turn the
 * lookup into an unbounded loop of Graph requests, and the newest message of
 * any thread this size is overwhelmingly inside the cap.
 */
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

/** The account's Drafts folder; consumer Outlook web nests folders under a fixed primary-mailbox index. */
function outlookDraftsFolderUrl(accountName: string): string {
  const root = outlookWebRoot(accountName);
  return isConsumerOutlookAccount(accountName) ? `${root}0/drafts` : `${root}drafts`;
}

/**
 * Graph is documented to return `webLink` on every message resource by
 * default, including the one echoed back from a create/update call — but it
 * is only usable for work/school accounts: it points at the organizational
 * web host, whose sign-in rejects personal Microsoft accounts outright (and
 * it's a known-broken link for outlook.com mailboxes regardless). Personal
 * accounts land on their Drafts folder instead, as does any message missing
 * webLink. Every variant carries the account's login_hint — webLink itself
 * names no account, so without it the browser opens whichever Microsoft
 * account the session defaults to.
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
    // Outlook doesn't distinguish a "draft id" from the message id the way
    // Gmail does — a draft is just a message sitting in the Drafts folder.
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

/** The brand-new, standalone-message path: no threadId, or a reply target that couldn't be resolved. */
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
 * A reply draft threaded onto an existing conversation, via Graph's
 * createReply + a follow-up PATCH. createReply (rather than createReplyAll)
 * mirrors ../gmail/drafts.ts's createGmailDraft, which never derives recipients
 * from the thread at all — the caller's to/cc/bcc there are the entire
 * recipient list, full stop. createReply's narrower "To: original sender
 * only" prefill is the closer match: it risks silently adding fewer
 * recipients the caller didn't ask for than createReplyAll's "Cc: everyone
 * else on the thread" would.
 *
 * Falls back to a standalone draft (logged at warn) when the conversation has
 * no messages to reply to — e.g. a stale or mistyped threadId.
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

  // The caller's body always wins. Subject/to/cc/bcc only override Graph's
  // prefill (sender-only To, "RE: …" subject) when the caller actually
  // supplied them — an absent one keeps what createReply already filled in.
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

/**
 * Narrow the created draft's id before it is dereferenced — the proxy can
 * answer an error envelope instead of a Graph message, and a descriptive
 * failure beats a bare TypeError from inside a cast.
 */
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

  // Graph can't attach files in the create call, so attachments are added to
  // the just-created draft. A failure propagates (the error names the draft
  // and the missing files; the draft survives for the user to fix up), but
  // the cache invalidation still runs — the draft exists either way.
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

/**
 * Save body/subject edits to an existing draft — the Outlook counterpart of
 * ../gmail/drafts.ts's updateGmailDraft. Graph's PATCH only touches the fields
 * sent, so (unlike Gmail's drafts.update, which replaces the whole message)
 * there's no need to first fetch and re-send the fields the caller didn't
 * change.
 */
async function updateOutlookDraft(
  account: ConnectedAccount,
  draftId: string,
  patch: UpdateDraftPatch,
): Promise<void> {
  const body: Record<string, unknown> = {};
  if (patch.subject !== undefined) body.subject = patch.subject;
  // Always Text, matching ../gmail/drafts.ts's updateGmailDraft — an edit made in
  // Trailin's plain-text editor should save as plain text, not silently
  // become (or stay) HTML.
  if (patch.body !== undefined) body.body = { contentType: "Text", content: patch.body };

  await proxyRequest(account.id, "patch", `${GRAPH_API}/messages/${draftId}`, { body });

  draftsMutated(account.id);
}

/**
 * Dispatch an existing draft via Graph's message send. Graph answers an empty
 * 202 with no message id — the sent copy gets a new id in Sent Items — so the
 * result carries no sentMessageId and the learning loop matches this send
 * from the provider's sent mail later instead.
 */
async function sendOutlookDraft(
  account: ConnectedAccount,
  draftId: string,
): Promise<SendDraftResult> {
  await proxyRequest(account.id, "post", `${GRAPH_API}/messages/${draftId}/send`, { body: {} });
  draftsMutated(account.id);
  return {};
}

/** This module's DraftProvider — registered by ../registerProviders.ts. */
export const outlookDraftProvider: DraftProvider = {
  listDrafts: listOutlookDrafts,
  getDraftDetail: getOutlookDraftDetail,
  createDraft: createOutlookDraft,
  deleteDraft: deleteOutlookDraft,
  updateDraft: updateOutlookDraft,
  sendDraft: sendOutlookDraft,
};
