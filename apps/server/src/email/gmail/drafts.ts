import { randomUUID } from "node:crypto";
import type { ConnectedAccount, EmailDraft } from "@trailin/shared";
import { moduleLogger } from "../../core/logger.js";
import { contentDisposition } from "../../core/utils/fileResponse.js";
import { mapWithConcurrency } from "../../core/utils/jobs.js";
import { proxyRequest } from "../../integrations/pipedream/connect.js";
import { draftsMutated } from "../draftsCache.js";
import {
  type CreateDraftInput,
  DRAFTS_LIST_LIMIT,
  type DraftAttachment,
  type DraftProvider,
  type SendDraftResult,
  type UpdateDraftPatch,
} from "../providers.js";
import { gmailDraftUrl } from "../webLinks.js";
import { downloadGmailAttachment } from "./attachments.js";
import {
  decodeHtmlEntities,
  forEachAttachmentPart,
  GMAIL_API,
  headerLookup,
  type MessagePart,
  plainTextBody,
  type ThreadGetResponse,
} from "./message.js";

/**
 * Gmail drafts via the Connect proxy (plain Gmail REST API): Pipedream's
 * prebuilt create-draft component needs a paid workspace (File Stash), while
 * the proxy works on every plan and returns clean JSON.
 */

const log = moduleLogger("gmail-drafts");

interface DraftsListResponse {
  drafts?: { id: string; message: { id: string; threadId: string } }[];
}

interface DraftGetResponse {
  message?: {
    id: string;
    threadId: string;
    internalDate?: string;
    payload?: { headers?: { name: string; value: string }[] };
    snippet?: string;
  };
}

const LIST_CONCURRENCY = 5;

async function listGmailDrafts(account: ConnectedAccount): Promise<EmailDraft[]> {
  const list = (await proxyRequest(account.id, "get", `${GMAIL_API}/drafts`, {
    params: { maxResults: String(DRAFTS_LIST_LIMIT) },
  })) as DraftsListResponse;

  const fetched = await mapWithConcurrency(
    list.drafts ?? [],
    LIST_CONCURRENCY,
    async (entry): Promise<EmailDraft | null> => {
      try {
        const full = (await proxyRequest(account.id, "get", `${GMAIL_API}/drafts/${entry.id}`, {
          params: { format: "metadata" },
        })) as DraftGetResponse;
        const header = headerLookup(full.message?.payload);
        const snippet = decodeHtmlEntities(full.message?.snippet ?? "").trim();
        return {
          id: entry.id,
          messageId: entry.message.id,
          threadId: entry.message.threadId,
          subject: header("Subject"),
          to: header("To"),
          date: full.message?.internalDate
            ? new Date(Number(full.message.internalDate)).toISOString()
            : "",
          webUrl: gmailDraftUrl(account.name, entry.message.id),
          ...(snippet ? { snippet } : {}),
        };
      } catch (error) {
        // Skip a single unreadable draft rather than failing the whole list.
        log.warn(
          { err: error, accountId: account.id, draftId: entry.id },
          "draft metadata fetch failed — leaving it out of the list",
        );
        return null;
      }
    },
  );
  // Newest first.
  return fetched
    .filter((d): d is EmailDraft => d !== null)
    .sort((a, b) => b.date.localeCompare(a.date));
}

async function getGmailDraftDetail(
  account: ConnectedAccount,
  draftId: string,
): Promise<{ body: string; cc: string; bcc: string }> {
  const full = (await proxyRequest(account.id, "get", `${GMAIL_API}/drafts/${draftId}`, {
    params: { format: "full" },
  })) as {
    message?: { payload?: MessagePart & { headers?: { name: string; value: string }[] } };
  };
  const payload = full.message?.payload;
  const header = headerLookup(payload);
  return { body: plainTextBody(payload), cc: header("Cc"), bcc: header("Bcc") };
}

async function deleteGmailDraft(account: ConnectedAccount, draftId: string): Promise<void> {
  await proxyRequest(account.id, "delete", `${GMAIL_API}/drafts/${draftId}`);
  draftsMutated(account.id);
}

/** RFC 2047 B-encoding, so non-ASCII subjects (umlauts) survive. */
function encodeHeaderWord(value: string): string {
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/**
 * To/Cc/Bcc are interpolated into RFC822 header lines and trace back to LLM
 * tool params: a prompt-injected email could steer a recipient value
 * containing CR/LF to smuggle an extra header (e.g. a hidden `Bcc:`). Reject
 * rather than strip, so the caller sees a clear failure.
 */
function assertSafeHeaderValue(header: string, value: string): void {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matches CR/LF and other control characters to reject header-injection attempts (see comment above)
  if (/[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`Invalid ${header} header value: contains a line break or control character.`);
  }
}

function textPartLines(body: string): string[] {
  return [
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(body, "utf8").toString("base64"),
  ];
}

/** One attachment as MIME part lines: an ASCII `filename` fallback plus RFC 5987/6266 `filename*`, so names like "Exposé.pdf" survive. */
function attachmentPartLines(attachment: DraftAttachment): string[] {
  // A CR/LF in a filename would smuggle extra MIME headers, same as a recipient (see assertSafeHeaderValue).
  assertSafeHeaderValue("attachment filename", attachment.filename);
  const ascii = attachment.filename.replace(/[\\"]/g, "").replace(/[^\x20-\x7e]/g, "_");
  return [
    `Content-Type: ${attachment.mimeType}; name="${ascii}"`,
    `Content-Disposition: ${contentDisposition("attachment", attachment.filename)}`,
    "Content-Transfer-Encoding: base64",
    "",
    attachment.content.toString("base64"),
  ];
}

/**
 * Build the RFC822 `raw` MIME message Gmail's drafts.create/drafts.update both
 * take. Recipients are already-joined header strings, so a caller can preserve
 * an existing draft's To/Cc/Bcc without a lossy split/rejoin. `extraHeaders` go
 * at the top level (so In-Reply-To/References keep threading whether or not the
 * message is multipart); drafts.update replaces the whole message, so an
 * updating caller passes back every header it wants to survive (PRESERVED_HEADERS).
 */
function buildRawMessage(input: {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  extraHeaders?: string[];
  attachments?: DraftAttachment[];
}): string {
  assertSafeHeaderValue("To", input.to);
  if (input.cc) assertSafeHeaderValue("Cc", input.cc);
  if (input.bcc) assertSafeHeaderValue("Bcc", input.bcc);

  const headerLines = [
    `To: ${input.to}`,
    ...(input.cc ? [`Cc: ${input.cc}`] : []),
    ...(input.bcc ? [`Bcc: ${input.bcc}`] : []),
    `Subject: ${encodeHeaderWord(input.subject)}`,
    ...(input.extraHeaders ?? []),
    "MIME-Version: 1.0",
  ];

  const lines =
    input.attachments && input.attachments.length > 0
      ? [...headerLines, ...multipartMixedLines(input.body, input.attachments)]
      : [...headerLines, ...textPartLines(input.body)];
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}

function multipartMixedLines(body: string, attachments: DraftAttachment[]): string[] {
  const boundary = `part-${randomUUID()}`;
  return [
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    ...textPartLines(body),
    ...attachments.flatMap((attachment) => [`--${boundary}`, ...attachmentPartLines(attachment)]),
    `--${boundary}--`,
  ];
}

/**
 * Headers an update carries over. In-Reply-To/References are what non-Gmail
 * clients thread on (Gmail itself uses threadId); From/Reply-To carry the
 * send-as alias, which silently falls back to the primary address if dropped.
 */
const PRESERVED_HEADERS = ["From", "Reply-To", "In-Reply-To", "References"] as const;

/**
 * In-Reply-To/References for a reply draft, from the thread's last non-draft
 * message. Drafts in the thread are skipped: unsent, no meaningful Message-ID
 * to reply to. Undefined on any failure or an empty thread, so createGmailDraft
 * falls back to its threadId-only behavior rather than blocking on this lookup.
 */
async function lastMessageThreadingHeaders(
  account: ConnectedAccount,
  threadId: string,
): Promise<{ inReplyTo: string; references: string } | undefined> {
  try {
    const res = (await proxyRequest(account.id, "get", `${GMAIL_API}/threads/${threadId}`, {
      params: { format: "full" },
    })) as ThreadGetResponse;
    const messages = (res.messages ?? []).filter((m) => !m.labelIds?.includes("DRAFT"));
    const last = messages[messages.length - 1];
    if (!last) return undefined;
    const header = headerLookup(last.payload);
    const inReplyTo = header("Message-ID");
    if (!inReplyTo) return undefined;
    const references = [header("References"), inReplyTo].filter(Boolean).join(" ");
    return { inReplyTo, references };
  } catch (error) {
    log.warn(
      { err: error, accountId: account.id, threadId },
      "reply threading headers lookup failed",
    );
    return undefined;
  }
}

async function createGmailDraft(
  account: ConnectedAccount,
  input: CreateDraftInput,
): Promise<{ draftId: string; messageId: string; threadId: string }> {
  const threadingHeaders = input.threadId
    ? await lastMessageThreadingHeaders(account, input.threadId)
    : undefined;

  const raw = buildRawMessage({
    to: input.to.join(", "),
    ...(input.cc?.length ? { cc: input.cc.join(", ") } : {}),
    ...(input.bcc?.length ? { bcc: input.bcc.join(", ") } : {}),
    subject: input.subject,
    body: input.body,
    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    ...(threadingHeaders
      ? {
          extraHeaders: [
            `In-Reply-To: ${threadingHeaders.inReplyTo}`,
            `References: ${threadingHeaders.references}`,
          ],
        }
      : {}),
  });

  const res = (await proxyRequest(account.id, "post", `${GMAIL_API}/drafts`, {
    body: { message: { raw, ...(input.threadId ? { threadId: input.threadId } : {}) } },
  })) as { id?: unknown; message?: { id?: unknown; threadId?: unknown } };

  draftsMutated(account.id);
  return {
    draftId: requireResponseString(res.id, "draft id"),
    messageId: requireResponseString(res.message?.id, "message id"),
    threadId: requireResponseString(res.message?.threadId, "thread id"),
  };
}

/** The proxy can answer an error envelope instead of the API shape; a descriptive failure beats a bare TypeError from a cast. */
function requireResponseString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`Gmail draft response carries no ${field} — unexpected response shape.`);
  }
  return value;
}

/**
 * The draft's attachments with bytes resolved: inline base64url `body.data`
 * decoded, ref-only parts downloaded. updateGmailDraft re-embeds these because
 * drafts.update replaces the whole message and would otherwise drop them.
 */
async function fetchDraftAttachments(
  account: ConnectedAccount,
  messageId: string,
  payload: MessagePart | undefined,
): Promise<DraftAttachment[]> {
  const parts: { filename: string; mimeType: string; data?: string; attachmentId?: string }[] = [];
  forEachAttachmentPart(payload, (part, filename) => {
    parts.push({
      filename,
      mimeType: part.mimeType ?? "application/octet-stream",
      ...(part.body?.data ? { data: part.body.data } : {}),
      ...(part.body?.attachmentId ? { attachmentId: part.body.attachmentId } : {}),
    });
  });

  const resolved: DraftAttachment[] = [];
  for (const part of parts) {
    let content: Buffer;
    if (part.data) {
      content = Buffer.from(part.data, "base64url");
    } else if (part.attachmentId) {
      content = await downloadGmailAttachment(
        account,
        messageId,
        part.attachmentId,
        `attachment "${part.filename}"`,
      );
    } else {
      continue;
    }
    resolved.push({ filename: part.filename, mimeType: part.mimeType, content });
  }
  return resolved;
}

async function fetchGmailDraftFull(
  account: ConnectedAccount,
  draftId: string,
): Promise<{
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  threadId: string;
  extraHeaders: string[];
  attachments: DraftAttachment[];
}> {
  const full = (await proxyRequest(account.id, "get", `${GMAIL_API}/drafts/${draftId}`, {
    params: { format: "full" },
  })) as {
    message?: {
      id?: string;
      threadId?: string;
      payload?: MessagePart & { headers?: { name: string; value: string }[] };
    };
  };
  const payload = full.message?.payload;
  const header = headerLookup(payload);
  const messageId = full.message?.id;
  return {
    to: header("To"),
    cc: header("Cc"),
    bcc: header("Bcc"),
    subject: header("Subject"),
    body: plainTextBody(payload),
    threadId: full.message?.threadId ?? "",
    extraHeaders: PRESERVED_HEADERS.filter((name) => header(name)).map(
      (name) => `${name}: ${header(name)}`,
    ),
    attachments: messageId ? await fetchDraftAttachments(account, messageId, payload) : [],
  };
}

/**
 * Save body/subject as passed. Everything the caller doesn't override is
 * fetched from the current draft first, since Gmail's drafts.update replaces
 * the whole message rather than patching it. The rebuilt message is always
 * text/plain, so saving an edit to an HTML draft composed in Gmail's web UI
 * converts it to plain text: lossy for markup, not for anything shown here.
 */
async function updateGmailDraft(
  account: ConnectedAccount,
  draftId: string,
  input: UpdateDraftPatch,
): Promise<void> {
  const current = await fetchGmailDraftFull(account, draftId);
  const raw = buildRawMessage({
    to: current.to,
    ...(current.cc ? { cc: current.cc } : {}),
    ...(current.bcc ? { bcc: current.bcc } : {}),
    subject: input.subject ?? current.subject,
    body: input.body ?? current.body,
    extraHeaders: current.extraHeaders,
    ...(current.attachments.length > 0 ? { attachments: current.attachments } : {}),
  });

  await proxyRequest(account.id, "put", `${GMAIL_API}/drafts/${draftId}`, {
    body: { message: { raw, ...(current.threadId ? { threadId: current.threadId } : {}) } },
  });

  draftsMutated(account.id);
}

/** Gmail's drafts.send returns the sent message's id, recorded on the snapshot so the learning loop needn't match this send. */
async function sendGmailDraft(
  account: ConnectedAccount,
  draftId: string,
): Promise<SendDraftResult> {
  const res = (await proxyRequest(account.id, "post", `${GMAIL_API}/drafts/send`, {
    body: { id: draftId },
  })) as { id?: string };
  draftsMutated(account.id);
  return res.id ? { sentMessageId: res.id } : {};
}

export const gmailDraftProvider: DraftProvider = {
  listDrafts: listGmailDrafts,
  getDraftDetail: getGmailDraftDetail,
  async createDraft(account, input) {
    const result = await createGmailDraft(account, input);
    return { ...result, webUrl: gmailDraftUrl(account.name, result.messageId) };
  },
  deleteDraft: deleteGmailDraft,
  updateDraft: updateGmailDraft,
  sendDraft: sendGmailDraft,
};
