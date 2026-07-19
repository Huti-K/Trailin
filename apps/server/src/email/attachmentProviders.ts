import type { ConnectedAccount } from "@trailin/shared";
import { createProviderRegistry } from "./registry.js";

export interface EmailAttachment {
  filename: string;
  mimeType?: string;
  size?: number;
  /** Opaque per-provider download handle (Gmail's attachmentId); absent when `data` is inline. */
  ref?: string;
  /** Inline bytes, present only when the provider inlined them (small attachments). */
  data?: Buffer;
}

export interface AttachmentProvider {
  listAttachments(account: ConnectedAccount, messageId: string): Promise<EmailAttachment[]>;
  downloadAttachment(account: ConnectedAccount, messageId: string, ref: string): Promise<Buffer>;
}

/** The attachment matching `filename` case-insensitively, or undefined. */
export function findAttachmentByFilename(
  attachments: EmailAttachment[],
  filename: string,
): EmailAttachment | undefined {
  const wanted = filename.trim().toLowerCase();
  return attachments.find((a) => a.filename.toLowerCase() === wanted);
}

export async function resolveAttachmentBytes(
  provider: AttachmentProvider,
  account: ConnectedAccount,
  messageId: string,
  attachment: EmailAttachment,
): Promise<Buffer | undefined> {
  if (attachment.data) return attachment.data;
  if (!attachment.ref) return undefined;
  return provider.downloadAttachment(account, messageId, attachment.ref);
}

const registry = createProviderRegistry<AttachmentProvider>();

export const registerAttachmentProvider = registry.register;

/** null when `app` has no attachment driver (not necessarily Gmail). */
export const getAttachmentProvider = registry.get;
