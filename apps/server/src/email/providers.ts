import type { ConnectedAccount, EmailDraft } from "@trailin/shared";
import { createProviderRegistry } from "./registry.js";

/**
 * Draft-provider abstraction: every mail app Trailin can list/create drafts
 * for implements this interface against its own REST API — Gmail via the
 * plain Gmail REST API (./gmail/drafts.ts), Outlook via Microsoft
 * Graph (./outlook/drafts.ts) — all through Pipedream's Connect proxy so no
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
  /** MIME format of body. Agent prose is converted to HTML when a rich signature is present. */
  bodyFormat?: "text" | "html";
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

export interface SendDraftResult {
  /**
   * Provider id of the message that was sent, when the provider returns it
   * (Gmail does; Graph's send returns an empty 202, so Outlook omits it and
   * the mirror's sync sees the sent message later instead).
   */
  sentMessageId?: string;
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
   * Optional capability: not every provider can do this (yet), so routes
   * check for the method rather than assuming any one app. Absent means "not
   * supported for this account" — the route replies 400, provider-neutral.
   * (Thread reading is not a provider concern at all — the thread viewer is
   * served from the local mailbox mirror, email/sync/mailQuery.ts.)
   */
  updateDraft?(account: ConnectedAccount, draftId: string, patch: UpdateDraftPatch): Promise<void>;
  /**
   * Optional capability: dispatch an existing draft as-is. Only ever invoked
   * from a human-initiated request (the in-app Send button) — the agent has
   * no tool over this method, and per-account write arming is deliberately
   * not consulted: an explicit click is the authorization.
   */
  sendDraft?(account: ConnectedAccount, draftId: string): Promise<SendDraftResult>;
}

const registry = createProviderRegistry<DraftProvider>();

/** Called once per provider module, at import time (see registerProviders.ts). */
export const registerDraftProvider = registry.register;

/** null when `app` has no draft driver yet — callers must handle that, not assume Gmail. */
export const getDraftProvider = registry.get;
