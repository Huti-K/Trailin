import type { ConnectedAccount } from "@trailin/shared";
import { proxyRequest } from "../../integrations/pipedream/connect.js";
import type { AttachmentProvider, EmailAttachment } from "../attachmentProviders.js";
import { GRAPH_API } from "./message.js";

/**
 * Only fileAttachments are surfaced: Graph's other kinds (itemAttachment, an
 * attached email; referenceAttachment, a OneDrive link) carry no file bytes.
 */

const FILE_ATTACHMENT_TYPE = "#microsoft.graph.fileAttachment";

interface GraphAttachment {
  "@odata.type"?: string;
  id?: string;
  name?: string;
  contentType?: string;
  size?: number;
  /** Base64 content; present only when a single attachment is fetched by id. */
  contentBytes?: string;
}

interface AttachmentsListResponse {
  value?: GraphAttachment[];
}

export const outlookAttachmentProvider: AttachmentProvider = {
  async listAttachments(account: ConnectedAccount, messageId: string): Promise<EmailAttachment[]> {
    // Without $select Graph inlines every attachment's base64 contentBytes into the list; fetch bytes per attachment instead.
    const list = (await proxyRequest(
      account.id,
      "get",
      `${GRAPH_API}/messages/${messageId}/attachments`,
      { params: { $select: "id,name,contentType,size" } },
    )) as AttachmentsListResponse;

    return (list.value ?? []).flatMap((attachment): EmailAttachment[] => {
      if (attachment["@odata.type"] !== FILE_ATTACHMENT_TYPE || !attachment.name || !attachment.id)
        return [];
      return [
        {
          filename: attachment.name,
          ...(attachment.contentType ? { mimeType: attachment.contentType } : {}),
          ...(attachment.size !== undefined ? { size: attachment.size } : {}),
          // The $select'ed list never inlines bytes, so every entry downloads by ref.
          ref: attachment.id,
        },
      ];
    });
  },

  async downloadAttachment(
    account: ConnectedAccount,
    messageId: string,
    ref: string,
  ): Promise<Buffer> {
    const fetched = (await proxyRequest(
      account.id,
      "get",
      `${GRAPH_API}/messages/${messageId}/attachments/${ref}`,
    )) as GraphAttachment;
    if (!fetched.contentBytes) throw new Error("Outlook returned no data for this attachment.");
    return Buffer.from(fetched.contentBytes, "base64");
  },
};
