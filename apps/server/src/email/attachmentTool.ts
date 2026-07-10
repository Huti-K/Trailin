import { extname } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { formatFileSize, type ConnectedAccount } from "@trailin/shared";
import { LIBRARY_EXTENSIONS, saveUpload, SUPPORTED_FORMATS } from "../library/ingest.js";
import { errorMessage } from "../util.js";
import type { AttachmentProvider, EmailAttachment } from "./attachmentProviders.js";

/**
 * "Save attachment to library" agent tool, generic over any app with an
 * AttachmentProvider — the provider fetches attachment listings and bytes in
 * its own wire format; everything here (attachment selection, extension
 * validation, library ingest, result text) is provider-neutral. The caller
 * (pipedream/mcp.ts) wires this once per live account whose app has a
 * provider, alongside the MCP-bridged tools — copy the shape of
 * buildDraftTool there.
 *
 * Live accounts only: demo mode swaps the entire email toolset
 * (mcp.ts's loadEmailTools) before attachment tools are wired, and the demo
 * mailbox has no attachments to download, so there is no demo path here.
 */

const text = (value: string) => ({
  content: [{ type: "text" as const, text: value }],
  details: undefined,
});

function hasSupportedExt(filename: string): boolean {
  return LIBRARY_EXTENSIONS.has(extname(filename).toLowerCase());
}

export function buildSaveAttachmentTool(
  account: ConnectedAccount,
  name: string,
  provider: AttachmentProvider,
): AgentTool {
  return {
    name,
    label: "Save attachment to library",
    description:
      `Download an attachment from an email in this account and save it into the user's local ` +
      `document library, where it is indexed — afterwards it can be found with library_search, ` +
      `read with library_read (library_list shows its id). Only these formats can be saved: ` +
      `${SUPPORTED_FORMATS}. Pass the messageId from find/list/get email tools; if the message ` +
      `has several attachments, call this once per attachment with its filename.\n\n` +
      `Acts as the connected account: ${account.name}.`,
    parameters: {
      type: "object",
      properties: {
        messageId: {
          type: "string",
          description: "The message id, from find/list/get email tools.",
        },
        filename: {
          type: "string",
          description:
            "Which attachment to save, by filename. Omit when the message has exactly one supported attachment.",
        },
      },
      required: ["messageId"],
    } as AgentTool["parameters"],
    execute: async (_toolCallId, params) => {
      const { messageId, filename } = params as { messageId: string; filename?: string };

      // Hard failure on a bad messageId or a provider error — thrown as-is;
      // pi turns it into an error tool result.
      const attachments = await provider.listAttachments(account, messageId);
      if (attachments.length === 0) return text("This message has no attachments.");

      let picked: EmailAttachment;
      if (filename?.trim()) {
        const wanted = filename.trim().toLowerCase();
        const match = attachments.find((a) => a.filename.toLowerCase() === wanted);
        if (!match) {
          return text(
            `No attachment named "${filename}" on this message. Attachments: ` +
              `${attachments.map((a) => a.filename).join(", ")}.`,
          );
        }
        picked = match;
      } else if (attachments.length === 1) {
        picked = attachments[0]!;
      } else {
        const supported = attachments.filter((a) => hasSupportedExt(a.filename));
        if (supported.length !== 1) {
          return text(
            `This message has several attachments: ${attachments.map((a) => a.filename).join(", ")}. ` +
              `Call again with filename set to the one to save.`,
          );
        }
        picked = supported[0]!;
      }

      // Check the extension before downloading anything.
      if (!hasSupportedExt(picked.filename)) {
        return text(
          `"${picked.filename}" is not a format the library can save. Only these formats can be ` +
            `saved: ${SUPPORTED_FORMATS}.`,
        );
      }

      let buffer = picked.data;
      if (!buffer) {
        if (!picked.ref) {
          throw new Error(`Attachment "${picked.filename}" has no downloadable data.`);
        }
        buffer = await provider.downloadAttachment(account, messageId, picked.ref);
      }

      let stored: string;
      try {
        stored = await saveUpload(picked.filename, buffer);
      } catch (error) {
        throw new Error(`Could not save "${picked.filename}" to the library: ${errorMessage(error)}`);
      }

      return text(
        `Saved "${stored}" (${formatFileSize(buffer.length)}) to the document library; it is being ` +
          `indexed and will be searchable with library_search / readable with library_read momentarily.`,
      );
    },
  };
}
