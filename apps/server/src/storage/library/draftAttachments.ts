import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { formatFileSize } from "@trailin/shared";
import { mimeForExt } from "../../core/utils/fileResponse.js";
import type { DraftAttachment } from "../../email/providers.js";
import { documentPath } from "./ingest.js";
import * as store from "./store.js";

/**
 * Resolve library document ids into DraftAttachments for the create-draft
 * tools. Every failure throws an Error whose message steers the model toward a
 * fix (wrong id, too big); the caller returns it as tool result text without
 * creating a draft.
 *
 * A document with status "error" (e.g. a scanned PDF with no text layer) is
 * still attachable: indexing failed, but the file is fine to send.
 */

export const MAX_DRAFT_ATTACHMENTS = 5;

/** Gmail caps the encoded message at 25 MB and base64 inflates ~4/3, so 15 MB of raw bytes stays safely under that on every provider. */
export const MAX_TOTAL_ATTACHMENT_BYTES = 15 * 1024 * 1024;

interface ResolvedFile {
  absPath: string;
  filename: string;
  mimeType: string;
  size: number;
}

async function resolveOne(id: string): Promise<ResolvedFile> {
  const doc = await store.getDocument(id);
  if (!doc) {
    throw new Error(
      `No library document with id "${id}" — use library_list or library_search to find the ` +
        `right id, and pass ids exactly as listed.`,
    );
  }

  // Confined to the knowledge folder, so a row can't point an attachment at an
  // arbitrary file on disk.
  const absPath = documentPath(doc.path);
  if (!absPath) {
    throw new Error(
      `Library document "${doc.title}" points outside the library folder and cannot be attached.`,
    );
  }

  try {
    const info = await stat(absPath);
    return {
      absPath,
      filename: basename(doc.path),
      mimeType: mimeForExt(extname(doc.path)),
      size: info.size,
    };
  } catch {
    throw new Error(
      `The file for library document "${doc.title}" (${doc.path}) is missing from the library ` +
        `folder — it may have been moved or deleted. Use library_list to see what is available.`,
    );
  }
}

export async function resolveLibraryAttachments(documentIds: string[]): Promise<DraftAttachment[]> {
  const ids = [...new Set(documentIds)];
  if (ids.length === 0) return [];
  if (ids.length > MAX_DRAFT_ATTACHMENTS) {
    throw new Error(
      `Too many attachments: ${ids.length} documents requested, but a draft can carry at most ` +
        `${MAX_DRAFT_ATTACHMENTS}. Attach only the most relevant ones.`,
    );
  }

  const files: ResolvedFile[] = [];
  for (const id of ids) {
    files.push(await resolveOne(id));
  }

  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
    throw new Error(
      `These documents total ${formatFileSize(totalBytes)}, over the ` +
        `${formatFileSize(MAX_TOTAL_ATTACHMENT_BYTES)} attachment limit per draft. ` +
        `Attach fewer or smaller files.`,
    );
  }

  return Promise.all(
    files.map(
      async (file): Promise<DraftAttachment> => ({
        filename: file.filename,
        mimeType: file.mimeType,
        content: await readFile(file.absPath),
      }),
    ),
  );
}
