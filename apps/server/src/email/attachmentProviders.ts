import type { ConnectedAccount } from "@trailin/shared";

/**
 * Attachment-provider abstraction — mirrors ./providers.ts's DraftProvider
 * registry so the save-attachment agent tool (./attachmentTool.ts) can be
 * built for whichever connected accounts have a driver instead of hardcoding
 * "gmail". An app with nothing registered simply doesn't get the tool, same
 * as an app with no DraftProvider gets no draft tool.
 *
 * Registration happens centrally in ./registerAttachmentProviders.ts (see
 * ./registerProviders.ts for why registration is never an import side
 * effect in the provider files).
 */

export interface EmailAttachment {
  filename: string;
  mimeType?: string;
  size?: number;
  /**
   * Opaque per-provider handle for downloadAttachment — whatever the provider
   * needs to fetch the bytes later (Gmail packs its attachmentId). Absent
   * when `data` is already inline.
   */
  ref?: string;
  /** Raw bytes, present when the provider inlined them in the list call (small attachments). */
  data?: Buffer;
}

export interface AttachmentProvider {
  /** Every attachment of one message, in the provider's own order. */
  listAttachments(account: ConnectedAccount, messageId: string): Promise<EmailAttachment[]>;
  /** Fetch the bytes of an attachment whose `data` wasn't inline, by its `ref`. */
  downloadAttachment(account: ConnectedAccount, messageId: string, ref: string): Promise<Buffer>;
}

const registry = new Map<string, AttachmentProvider>();

/** Called once per app by registerAttachmentProviders.ts. */
export function registerAttachmentProvider(app: string, provider: AttachmentProvider): void {
  registry.set(app, provider);
}

/** null when `app` has no attachment driver yet — callers must handle that, not assume Gmail. */
export function getAttachmentProvider(app: string): AttachmentProvider | null {
  return registry.get(app) ?? null;
}
