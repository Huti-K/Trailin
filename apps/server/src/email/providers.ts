import type { ConnectedAccount, CreatedDraft, EmailDraft } from "@trailin/shared";
import { createProviderRegistry } from "./registry.js";

/**
 * One file to attach at draft creation: the caller passes resolved bytes;
 * providers persist it on the draft so a later sendDraft dispatches it.
 */
export interface DraftAttachment {
  filename: string;
  mimeType: string;
  content: Buffer;
}

export interface CreateDraftInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  /** Plain-text body; providers save it as text/plain. */
  body: string;
  threadId?: string;
  attachments?: DraftAttachment[];
}

export interface UpdateDraftPatch {
  body?: string;
  subject?: string;
}

export const DRAFTS_LIST_LIMIT = 15;

export interface SendDraftResult {
  /** Sent message's provider id when the provider returns it: Gmail does; Graph's send is an empty 202, so Outlook omits it and the matcher pairs it later. */
  sentMessageId?: string;
}

export interface DraftProvider {
  listDrafts(account: ConnectedAccount): Promise<EmailDraft[]>;
  getDraftDetail(
    account: ConnectedAccount,
    draftId: string,
  ): Promise<{ body: string; cc: string; bcc: string }>;
  createDraft(account: ConnectedAccount, input: CreateDraftInput): Promise<CreatedDraft>;
  deleteDraft(account: ConnectedAccount, draftId: string): Promise<void>;
  /** Optional: absent means "not supported for this account" and the route replies 400, provider-neutral. */
  updateDraft?(account: ConnectedAccount, draftId: string, patch: UpdateDraftPatch): Promise<void>;
  /**
   * Optional: dispatch a draft as-is. Human-initiated only (the Send button):
   * the agent has no tool for it, and write-arming isn't consulted, so the
   * click is the authorization.
   */
  sendDraft?(account: ConnectedAccount, draftId: string): Promise<SendDraftResult>;
}

const registry = createProviderRegistry<DraftProvider>();

export const registerDraftProvider = registry.register;

/** null when `app` has no draft driver (not necessarily Gmail). */
export const getDraftProvider = registry.get;
