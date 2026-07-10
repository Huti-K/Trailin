import type { ConnectedAccount, EmailDraft, EmailThreadMessage } from "@trailin/shared";

/**
 * Draft-provider abstraction: every mail app Trailin can list/create drafts
 * for implements this interface against its own REST API — Gmail via the
 * plain Gmail REST API (./gmailDrafts.ts), Outlook via Microsoft
 * Graph (./outlookDrafts.ts) — all through Pipedream's Connect proxy so no
 * OAuth tokens ever touch this codebase directly.
 *
 * Keyed by Pipedream app slug in the registry below. `getDraftProvider`
 * returns null for apps with no driver yet (zoho_mail, imap, or anything
 * that isn't a mail app at all) so routes/tools can filter accounts down to
 * "drafts actually work here" instead of assuming every connected account is
 * Gmail. Adding a provider later is one new file (implementing DraftProvider
 * and calling registerDraftProvider) plus one import line in
 * registerProviders.ts — nothing else changes.
 *
 * `listDrafts` implementations are pure live fetches — no caching, no
 * refresh flag. Caching lives one layer up, in ./draftsService.ts, shared
 * across every provider instead of duplicated per provider.
 */

export interface CreateDraftInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  /** Attach the draft to an existing conversation, where the provider supports it. */
  threadId?: string;
}

export interface CreateDraftResult {
  draftId: string;
  messageId: string;
  threadId: string;
  /** Deep link to review/send the draft in the provider's web UI. */
  webUrl: string;
}

/** Body of DraftProvider.updateDraft: only body/subject are overridable. */
export interface UpdateDraftPatch {
  body?: string;
  subject?: string;
}

export interface DraftProvider {
  listDrafts(account: ConnectedAccount, limit?: number): Promise<EmailDraft[]>;
  getDraftDetail(
    account: ConnectedAccount,
    draftId: string,
  ): Promise<{ body: string; cc: string; bcc: string }>;
  createDraft(account: ConnectedAccount, input: CreateDraftInput): Promise<CreateDraftResult>;
  deleteDraft(account: ConnectedAccount, draftId: string): Promise<void>;
  /**
   * Optional capabilities: not every provider can do these (yet), so routes
   * check for the method rather than assuming any one app. Absent means "not
   * supported for this account" — the route replies 400, provider-neutral.
   */
  updateDraft?(account: ConnectedAccount, draftId: string, patch: UpdateDraftPatch): Promise<void>;
  getThread?(
    account: ConnectedAccount,
    threadId: string,
    opts?: { excludeMessageId?: string },
  ): Promise<EmailThreadMessage[]>;
}

const registry = new Map<string, DraftProvider>();

/** Called once per provider module, at import time (see registerProviders.ts). */
export function registerDraftProvider(app: string, provider: DraftProvider): void {
  registry.set(app, provider);
}

/** null when `app` has no draft driver yet — callers must handle that, not assume Gmail. */
export function getDraftProvider(app: string): DraftProvider | null {
  return registry.get(app) ?? null;
}
