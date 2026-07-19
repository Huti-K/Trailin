import { findAccount } from "../agent/accounts.js";
import { badRequest, notFound } from "../errors.js";
import { listAccounts } from "../pipedream/connect.js";
import {
  findAttachmentByFilename,
  getAttachmentProvider,
  resolveAttachmentBytes,
} from "./attachmentProviders.js";

/**
 * Resolve an email attachment's bytes on demand, by (accountId, messageId,
 * filename) — the handle the `attachments` card carries. Shared by the file
 * routes (routes/mail.ts): the viewer streams the bytes, the "save to library"
 * action re-uses the same fetch. Nothing is cached; each call hits the
 * provider, so attachment blobs are never stored locally.
 *
 * Throws the errors.ts AppError helpers so the central handler renders them:
 * a bad account/app or a missing attachment is a 4xx, not a 500.
 */
export async function fetchAttachment(
  accountId: string,
  messageId: string,
  filename: string,
): Promise<{ filename: string; bytes: Buffer }> {
  const account = findAccount(await listAccounts(), accountId);
  if (!account) throw notFound("connected account not found");

  const provider = getAttachmentProvider(account.app);
  if (!provider) throw badRequest(`${account.app} has no attachment support`);

  const attachments = await provider.listAttachments(account, messageId);
  const picked = findAttachmentByFilename(attachments, filename);
  if (!picked) throw notFound(`no attachment named "${filename}" on this message`);

  const bytes = await resolveAttachmentBytes(provider, account, messageId, picked);
  if (!bytes) throw notFound("attachment has no downloadable data");

  return { filename: picked.filename, bytes };
}
