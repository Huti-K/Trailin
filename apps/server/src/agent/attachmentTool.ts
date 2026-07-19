import { extname } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { type AttachmentItem, type ConnectedAccount, formatFileSize } from "@trailin/shared";
import { inlineForMime, mimeForExt } from "../core/utils/fileResponse.js";
import { errorMessage } from "../core/utils/util.js";
import {
  type AttachmentProvider,
  type EmailAttachment,
  findAttachmentByFilename,
  resolveAttachmentBytes,
} from "../email/attachmentProviders.js";
import { LIBRARY_EXTENSIONS, SUPPORTED_FORMATS, saveUpload } from "../storage/library/ingest.js";
import { buildAttachmentsCard, toCardAccount } from "./cards.js";
import { textResult, tool } from "./toolkit.js";

function hasSupportedExt(filename: string): boolean {
  return LIBRARY_EXTENSIONS.has(extname(filename).toLowerCase());
}

function toAttachmentItem(
  account: ConnectedAccount,
  messageId: string,
  attachment: EmailAttachment,
): AttachmentItem {
  const ext = extname(attachment.filename).toLowerCase();
  return {
    accountId: account.id,
    messageId,
    filename: attachment.filename,
    ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
    ...(attachment.size !== undefined ? { size: attachment.size } : {}),
    viewable: inlineForMime(mimeForExt(ext)),
    saveable: LIBRARY_EXTENSIONS.has(ext),
  };
}

export function buildListAttachmentsTool(
  account: ConnectedAccount,
  name: string,
  provider: AttachmentProvider,
): AgentTool {
  return tool({
    name,
    label: "List email attachments",
    description:
      `List the attachments on an email in this account and publish them as an interactive card ` +
      `the user can act on: viewable files (PDF, images, plain text) open in a side-panel viewer, ` +
      `and library-supported files (${SUPPORTED_FORMATS}) can be saved to the document library — ` +
      `both from the card, without you saving anything. Call this when a message has an ` +
      `attachment the user might want to see, instead of only offering to save it. Pass the ` +
      `messageId from this account's email read tools' results.\n\n` +
      `Acts as the connected account: ${account.name}.`,
    params: {
      messageId: Type.String({
        description: "The message id, from this account's email read tools' results.",
      }),
    },
    execute: async ({ messageId }) => {
      const attachments = await provider.listAttachments(account, messageId);
      if (attachments.length === 0) return textResult("This message has no attachments.");

      const items = attachments.map((a) => toAttachmentItem(account, messageId, a));
      const card = buildAttachmentsCard({ account: toCardAccount(account), items });

      const lines = attachments
        .map((a) => `- ${a.filename}${a.size !== undefined ? ` (${formatFileSize(a.size)})` : ""}`)
        .join("\n");
      const viewable = items.filter((i) => i.viewable).length;
      const summary =
        `${attachments.length} attachment${attachments.length === 1 ? "" : "s"} on this message` +
        `${viewable > 0 ? `, ${viewable} viewable in the side panel` : ""}:`;
      return textResult(`${summary}\n${lines}`, card);
    },
  });
}

export function buildSaveAttachmentTool(
  account: ConnectedAccount,
  name: string,
  provider: AttachmentProvider,
): AgentTool {
  return tool({
    name,
    label: "Save attachment to library",
    description:
      `Download an attachment from an email in this account and save it into the user's local ` +
      `document library, where it is indexed — afterwards it can be found with library_search, ` +
      `read with library_read (library_list shows its id). Only these formats can be saved: ` +
      `${SUPPORTED_FORMATS}. Pass the messageId from this account's email read tools' results; if the ` +
      `message has several attachments, call this once per attachment with its filename.\n\n` +
      `Acts as the connected account: ${account.name}.`,
    params: {
      messageId: Type.String({
        description: "The message id, from this account's email read tools' results.",
      }),
      filename: Type.Optional(
        Type.String({
          description:
            "Which attachment to save, by filename. Omit when the message has exactly one supported attachment.",
        }),
      ),
    },
    execute: async ({ messageId, filename }) => {
      // A bad messageId or provider error throws as-is, surfacing as an error tool result.
      const attachments = await provider.listAttachments(account, messageId);
      if (attachments.length === 0) return textResult("This message has no attachments.");

      let picked: EmailAttachment;
      if (filename?.trim()) {
        const match = findAttachmentByFilename(attachments, filename);
        if (!match) {
          return textResult(
            `No attachment named "${filename}" on this message. Attachments: ` +
              `${attachments.map((a) => a.filename).join(", ")}.`,
          );
        }
        picked = match;
      } else if (attachments.length === 1) {
        const [only] = attachments;
        if (!only) throw new Error("Attachment list changed unexpectedly.");
        picked = only;
      } else {
        const supported = attachments.filter((a) => hasSupportedExt(a.filename));
        if (supported.length !== 1) {
          return textResult(
            `This message has several attachments: ${attachments.map((a) => a.filename).join(", ")}. ` +
              `Call again with filename set to the one to save.`,
          );
        }
        const [only] = supported;
        if (!only) throw new Error("Supported attachment list changed unexpectedly.");
        picked = only;
      }

      // Check the extension before downloading anything.
      if (!hasSupportedExt(picked.filename)) {
        return textResult(
          `"${picked.filename}" is not a format the library can save. Only these formats can be ` +
            `saved: ${SUPPORTED_FORMATS}.`,
        );
      }

      const buffer = await resolveAttachmentBytes(provider, account, messageId, picked);
      if (!buffer) {
        throw new Error(`Attachment "${picked.filename}" has no downloadable data.`);
      }

      let stored: string;
      try {
        stored = await saveUpload(picked.filename, buffer);
      } catch (error) {
        throw new Error(
          `Could not save "${picked.filename}" to the library: ${errorMessage(error)}`,
        );
      }

      return textResult(
        `Saved "${stored}" (${formatFileSize(buffer.length)}) to the document library; it is being ` +
          `indexed and will be searchable with library_search / readable with library_read momentarily.`,
      );
    },
  });
}
