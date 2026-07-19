import type { ConnectedAccount } from "@trailin/shared";
import { errorMessage } from "../../core/utils/util.js";
import { proxyRequest } from "../../integrations/pipedream/connect.js";
import type { DraftAttachment } from "../providers.js";
import { GRAPH_API } from "./message.js";

/**
 * Graph can't create a message with attachments in one call, so the draft is
 * created first and its files are added here: small ones as a single
 * fileAttachment POST, large ones via Graph's upload-session protocol.
 */

/** Graph's ceiling for a single fileAttachment POST; larger files need an upload session. */
const SMALL_ATTACHMENT_MAX = 3 * 1024 * 1024;

/**
 * Graph requires every non-final upload chunk to be a multiple of 320 KiB;
 * this is 10 of them (~3.1 MB), comfortably under Graph's 4 MB request ceiling.
 */
const UPLOAD_CHUNK_SIZE = 3_276_800;

async function attachSmall(
  account: ConnectedAccount,
  messageId: string,
  attachment: DraftAttachment,
): Promise<void> {
  await proxyRequest(account.id, "post", `${GRAPH_API}/messages/${messageId}/attachments`, {
    body: {
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: attachment.filename,
      contentType: attachment.mimeType,
      contentBytes: attachment.content.toString("base64"),
    },
  });
}

/**
 * PUT the bytes in chunks straight to the session's uploadUrl with `fetch`:
 * the URL is pre-authenticated, so it bypasses the proxy, which
 * would add credentials Graph rejects on that endpoint.
 */
async function attachViaUploadSession(
  account: ConnectedAccount,
  messageId: string,
  attachment: DraftAttachment,
): Promise<void> {
  const session = (await proxyRequest(
    account.id,
    "post",
    `${GRAPH_API}/messages/${messageId}/attachments/createUploadSession`,
    {
      body: {
        AttachmentItem: {
          attachmentType: "file",
          name: attachment.filename,
          size: attachment.content.length,
        },
      },
    },
  )) as { uploadUrl?: string };
  if (!session.uploadUrl) {
    throw new Error(`Graph returned no upload URL for "${attachment.filename}".`);
  }

  const total = attachment.content.length;
  for (let start = 0; start < total; start += UPLOAD_CHUNK_SIZE) {
    const end = Math.min(start + UPLOAD_CHUNK_SIZE, total);
    const chunk = attachment.content.subarray(start, end);
    const res = await fetch(session.uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Length": String(chunk.length),
        "Content-Range": `bytes ${start}-${end - 1}/${total}`,
      },
      body: new Uint8Array(chunk),
    });
    if (!res.ok) {
      throw new Error(
        `Uploading "${attachment.filename}" failed at bytes ${start}-${end - 1}: HTTP ${res.status}.`,
      );
    }
  }
}

/** Attach every file in order. On failure the already-attached files stay and the error names what's missing; the draft is never deleted here. */
export async function addOutlookAttachments(
  account: ConnectedAccount,
  messageId: string,
  attachments: DraftAttachment[],
): Promise<void> {
  for (let i = 0; i < attachments.length; i++) {
    const attachment = attachments[i];
    if (!attachment) continue;
    try {
      if (attachment.content.length <= SMALL_ATTACHMENT_MAX) {
        await attachSmall(account, messageId, attachment);
      } else {
        await attachViaUploadSession(account, messageId, attachment);
      }
    } catch (error) {
      const missing = attachments.slice(i).map((a) => `"${a.filename}"`);
      throw new Error(
        `Draft ${messageId} was created, but attaching ${missing.join(", ")} failed: ` +
          `${errorMessage(error)}. ` +
          `The draft exists without ${missing.length === 1 ? "this file" : "these files"} — ` +
          `the user can attach ${missing.length === 1 ? "it" : "them"} in Outlook, or the draft can be recreated.`,
      );
    }
  }
}
