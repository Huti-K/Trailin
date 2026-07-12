import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type {
  AccountDrafts,
  ConnectedAccount,
  EmailDraft,
  EmailThread,
  EmailThreadMessage,
} from "@trailin/shared";
import {
  appendDraftVersion,
  getDraftConversationLinks,
  getDraftStatus,
  markDraftStatus,
} from "../db/draftStore.js";
import "../email/registerProviders.js";
import { listDraftsCached } from "../email/draftsService.js";
import { type DraftProvider, getDraftProvider } from "../email/providers.js";
import { getThreadDetail } from "../email/sync/mailQuery.js";
import { AppError, badRequest, notFound, upstreamError, upstreamStatusCode } from "../errors.js";
import { moduleLogger } from "../logger.js";
import { listAccounts, pipedreamConfigured } from "../pipedream/connect.js";
import { errorMessage } from "../util.js";

const log = moduleLogger("drafts-routes");

/** Resolve a connected account (any app with a draft provider) by its Pipedream account id. */
async function findDraftAccount(
  accountId: string,
): Promise<{ account: ConnectedAccount; provider: DraftProvider } | null> {
  const accounts = await listAccounts();
  const account = accounts.find((a) => a.id === accountId);
  if (!account) return null;
  const provider = getDraftProvider(account.app);
  return provider ? { account, provider } : null;
}

/**
 * A draft provider (reached via the Pipedream proxy) throwing 404 means the
 * id doesn't exist there anymore — that's a client-facing 404, not an
 * outage. Anything else genuinely failed upstream and stays a 502. An
 * AppError already thrown deliberately below (e.g. notFound("account not
 * found"), badRequest for an unsupported capability) passes through as-is.
 */
function toProviderError(error: unknown, notFoundMessage: string): AppError {
  if (error instanceof AppError) return error;
  if (upstreamStatusCode(error) === 404) return notFound(notFoundMessage);
  return upstreamError(errorMessage(error), error);
}

/**
 * Attach the conversation that created each draft (from its agent_drafts
 * snapshot), so the UI's refine action can reopen that exact chat.
 */
async function attachConversationLinks(byAccount: AccountDrafts[]): Promise<AccountDrafts[]> {
  const draftIds = byAccount.flatMap((a) => a.drafts.map((d) => d.id));
  if (draftIds.length === 0) return byAccount;

  const byDraftId = await getDraftConversationLinks(draftIds);
  if (byDraftId.size === 0) return byAccount;

  return byAccount.map((account) => ({
    ...account,
    drafts: account.drafts.map((draft): EmailDraft => {
      const conversationId = byDraftId.get(draft.id);
      return conversationId ? { ...draft, conversationId } : draft;
    }),
  }));
}

const draftsQuery = Type.Object({ refresh: Type.Optional(Type.String()) });
const draftParams = Type.Object({ accountId: Type.String(), draftId: Type.String() });
const draftPatchBody = Type.Object({
  body: Type.Optional(Type.String()),
  subject: Type.Optional(Type.String()),
});
const threadParams = Type.Object({ accountId: Type.String(), threadId: Type.String() });
const threadQuery = Type.Object({ excludeMessageId: Type.Optional(Type.String()) });

export const draftRoutes: FastifyPluginAsyncTypebox = async (app) => {
  /** Live drafts per connected account that has a DraftProvider (Gmail, Outlook, ...). */
  app.get(
    "/api/drafts",
    { schema: { querystring: draftsQuery } },
    async (req): Promise<AccountDrafts[]> => {
      if (!(await pipedreamConfigured())) return [];
      const refresh = req.query.refresh === "1";
      let accounts: ConnectedAccount[];
      try {
        accounts = (await listAccounts()).filter((a) => getDraftProvider(a.app) !== null);
      } catch (error) {
        // Listing accounts is the one genuinely-upstream (Pipedream) step
        // here; attachConversationLinks below is a local DB join and must
        // not be misreported the same way if it fails.
        throw upstreamError(errorMessage(error), error);
      }
      const byAccount = await Promise.all(
        accounts.map(async (account): Promise<AccountDrafts> => {
          try {
            return {
              account: account.name,
              accountId: account.id,
              drafts: await listDraftsCached(account, { refresh }),
            };
          } catch (error) {
            return {
              account: account.name,
              accountId: account.id,
              drafts: [],
              error: errorMessage(error),
            };
          }
        }),
      );
      return attachConversationLinks(byAccount);
    },
  );

  /** Full draft content for the in-app viewer. */
  app.get("/api/drafts/:accountId/:draftId", { schema: { params: draftParams } }, async (req) => {
    try {
      const found = await findDraftAccount(req.params.accountId);
      if (!found) throw notFound("account not found");
      return await found.provider.getDraftDetail(found.account, req.params.draftId);
    } catch (error) {
      throw toProviderError(error, "draft not found");
    }
  });

  /** Discard a draft (user-initiated from the UI; the agent has no such tool). */
  app.delete(
    "/api/drafts/:accountId/:draftId",
    { schema: { params: draftParams } },
    async (req) => {
      try {
        const found = await findDraftAccount(req.params.accountId);
        if (!found) throw notFound("account not found");
        await found.provider.deleteDraft(found.account, req.params.draftId);
        // Snapshot bookkeeping is best-effort: the provider delete succeeded,
        // so the request must report success even if the local mark fails. A
        // discarded draft is a learning signal in its own right.
        await markDraftStatus(req.params.accountId, req.params.draftId, "discarded").catch(
          (error: unknown) => log.warn({ err: error }, "marking draft snapshot discarded failed"),
        );
        return { ok: true };
      } catch (error) {
        throw toProviderError(error, "draft not found");
      }
    },
  );

  /**
   * Send an existing draft as-is. Human-initiated only (the in-app Send
   * button); per-account write arming is deliberately not consulted — the
   * explicit click is the authorization, and the agent has no tool over this
   * route. `sendDraft` is an optional provider capability, same contract as
   * `updateDraft` below.
   */
  app.post(
    "/api/drafts/:accountId/:draftId/send",
    { schema: { params: draftParams } },
    async (req) => {
      try {
        const found = await findDraftAccount(req.params.accountId);
        if (!found) throw notFound("account not found");
        if (!found.provider.sendDraft) {
          throw badRequest("sending a draft is not supported for this account");
        }
        const result = await found.provider.sendDraft(found.account, req.params.draftId);
        // In-app sends record the sent message id exactly, so the learning
        // loop never has to match them. Best-effort, as with discard above.
        await markDraftStatus(
          req.params.accountId,
          req.params.draftId,
          "sent",
          result.sentMessageId,
        ).catch((error: unknown) => log.warn({ err: error }, "marking draft snapshot sent failed"));
        return { ok: true };
      } catch (error) {
        throw toProviderError(error, "draft not found");
      }
    },
  );

  /**
   * The draft's recorded fate from its snapshot — what persisted chat cards
   * re-hydrate from, so a card whose draft was already sent or discarded
   * renders that terminal state instead of live buttons. 404 = no snapshot
   * (the draft wasn't agent-written); callers treat that as unknown.
   */
  app.get(
    "/api/drafts/:accountId/:draftId/status",
    { schema: { params: draftParams } },
    async (req) => {
      const status = await getDraftStatus(req.params.accountId, req.params.draftId);
      if (!status) throw notFound("draft snapshot not found");
      return status;
    },
  );

  /**
   * Save body/subject edits to an existing draft, exactly as typed — no
   * humanizer, no signature (those only run in the agent's create-draft
   * tool). `updateDraft` is an optional DraftProvider capability — a provider
   * without one (no driver written yet) reports 400 rather than assuming
   * every provider supports it.
   */
  app.patch(
    "/api/drafts/:accountId/:draftId",
    { schema: { params: draftParams, body: draftPatchBody } },
    async (req) => {
      try {
        const found = await findDraftAccount(req.params.accountId);
        if (!found) throw notFound("account not found");
        if (!found.provider.updateDraft) {
          throw badRequest("editing a draft is not supported for this account");
        }
        const { body, subject } = req.body;
        await found.provider.updateDraft(found.account, req.params.draftId, { body, subject });
        // A manual edit is a user-authored version in the draft's snapshot
        // history — the learning loop's strongest signal. Best-effort: the
        // provider save succeeded, so the request reports success regardless.
        await appendDraftVersion(req.params.accountId, req.params.draftId, "user", {
          body,
          subject,
        }).catch((error: unknown) =>
          log.warn({ err: error }, "appending user draft version failed"),
        );
        return { ok: true };
      } catch (error) {
        throw toProviderError(error, "draft not found");
      }
    },
  );

  /**
   * The full email thread a draft belongs to, for the in-app viewer — served
   * from the local mailbox mirror, so it works for every synced account
   * without a provider round-trip. 404 covers both a bad id and a thread
   * older than the mirror's backfill window. `excludeMessageId` omits one
   * message by provider id (drafts themselves are never mirrored, so the
   * draft's own message can't appear, but the parameter is honored).
   */
  app.get(
    "/api/threads/:accountId/:threadId",
    { schema: { params: threadParams, querystring: threadQuery } },
    async (req): Promise<EmailThread> => {
      const exclude = req.query.excludeMessageId?.trim();
      const detail = getThreadDetail(req.params.threadId, req.params.accountId);
      if (!detail) throw notFound("thread not found");
      const messages = detail.messages
        .filter((m) => !exclude || m.providerMessageId !== exclude)
        .map(
          (m): EmailThreadMessage => ({
            from: m.from,
            to: m.to,
            ...(m.cc.length > 0 ? { cc: m.cc } : {}),
            date: m.date,
            body: m.bodyText,
          }),
        );
      return { messages };
    },
  );
};
