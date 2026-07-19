import { findAccount } from "../agent/accounts.js";
import { badRequest, notFound } from "../core/errors.js";
import { listAccounts } from "../integrations/pipedream/connect.js";
import {
  findAttachmentByFilename,
  getAttachmentProvider,
  resolveAttachmentBytes,
} from "./attachmentProviders.js";

/** Nothing is cached; blobs are never stored locally. */
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
