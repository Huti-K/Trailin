import type { ConnectedAccount } from "@trailin/shared";
import { proxyRequest } from "../pipedream/connect.js";
import type { AttachmentProvider, EmailAttachment } from "./attachmentProviders.js";
import { GMAIL_API, type MessagePart } from "./gmailMessage.js";

/**
 * Gmail AttachmentProvider: lists a message's attachments and downloads
 * their bytes through the Connect proxy (plain Gmail REST API, same pattern
 * as gmailDrafts.ts). Everything user-facing — attachment selection,
 * extension validation, library ingest — lives one layer up in the
 * provider-neutral ./attachmentTool.ts; this file only speaks Gmail's wire
 * format. Registered by ./registerAttachmentProviders.ts.
 */

/**
 * Depth-first walk collecting every part with a non-empty filename — Gmail's
 * own definition of "this part is an attachment". Mirrors findPart's
 * recursion in gmailMessage.ts, just collecting instead of stopping at a hit.
 */
function collectAttachments(part: MessagePart | undefined, out: EmailAttachment[]): void {
  if (!part) return;
  if (part.filename) {
    out.push({
      filename: part.filename,
      ...(part.mimeType ? { mimeType: part.mimeType } : {}),
      ...(part.body?.size !== undefined ? { size: part.body.size } : {}),
      // Small attachments arrive inline as base64url; larger ones only carry
      // an attachmentId, packed into the opaque `ref` for downloadAttachment.
      ...(part.body?.attachmentId ? { ref: part.body.attachmentId } : {}),
      ...(part.body?.data ? { data: Buffer.from(part.body.data, "base64url") } : {}),
    });
  }
  for (const child of part.parts ?? []) collectAttachments(child, out);
}

interface MessageGetResponse {
  payload?: MessagePart;
}

interface AttachmentGetResponse {
  data?: string;
}

export const gmailAttachmentProvider: AttachmentProvider = {
  async listAttachments(account: ConnectedAccount, messageId: string): Promise<EmailAttachment[]> {
    const message = (await proxyRequest(account.id, "get", `${GMAIL_API}/messages/${messageId}`, {
      params: { format: "full" },
    })) as MessageGetResponse;
    const attachments: EmailAttachment[] = [];
    collectAttachments(message.payload, attachments);
    return attachments;
  },

  async downloadAttachment(
    account: ConnectedAccount,
    messageId: string,
    ref: string,
  ): Promise<Buffer> {
    const fetched = (await proxyRequest(
      account.id,
      "get",
      `${GMAIL_API}/messages/${messageId}/attachments/${ref}`,
    )) as AttachmentGetResponse;
    if (!fetched.data) throw new Error("Gmail returned no data for this attachment.");
    return Buffer.from(fetched.data, "base64url");
  },
};
