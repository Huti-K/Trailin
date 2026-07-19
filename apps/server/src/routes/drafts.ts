import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { AccountDrafts, ConnectedAccount, EmailDraft } from "@trailin/shared";
import { badRequest, notFound, toProviderError, upstreamError } from "../core/errors.js";
import { errorMessage } from "../core/utils/util.js";
import {
  appendDraftVersion,
  getDraftConversationLinks,
  getDraftStatus,
  markDraftStatus,
} from "../db/draftStore.js";
import { listDraftsCached } from "../email/draftsCache.js";
import { type DraftProvider, getDraftProvider } from "../email/providers.js";
import { listAccounts, pipedreamConfigured } from "../integrations/pipedream/connect.js";

async function findDraftAccount(
  accountId: string,
): Promise<{ account: ConnectedAccount; provider: DraftProvider } | null> {
  const accounts = await listAccounts();
  const account = accounts.find((a) => a.id === accountId);
  if (!account) return null;
  const provider = getDraftProvider(account.app);
  return provider ? { account, provider } : null;
}

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
export const draftRoutes: FastifyPluginAsyncTypebox = async (app) => {
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
        // Only listAccounts is genuinely upstream; a failure in the local DB
        // join below is not misreported as an upstream error.
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

  app.get("/api/drafts/:accountId/:draftId", { schema: { params: draftParams } }, async (req) => {
    try {
      const found = await findDraftAccount(req.params.accountId);
      if (!found) throw notFound("account not found");
      return await found.provider.getDraftDetail(found.account, req.params.draftId);
    } catch (error) {
      throw toProviderError(error, "draft not found");
    }
  });

  app.delete(
    "/api/drafts/:accountId/:draftId",
    { schema: { params: draftParams } },
    async (req) => {
      try {
        const found = await findDraftAccount(req.params.accountId);
        if (!found) throw notFound("account not found");
        await found.provider.deleteDraft(found.account, req.params.draftId);
        // Best-effort: the provider delete already succeeded, so report success
        // even if the local snapshot mark fails.
        await markDraftStatus(req.params.accountId, req.params.draftId, "discarded").catch(
          (error: unknown) =>
            req.log.warn({ err: error }, "marking draft snapshot discarded failed"),
        );
        return { ok: true };
      } catch (error) {
        throw toProviderError(error, "draft not found");
      }
    },
  );

  /**
   * Human-initiated only (the in-app Send button): per-account write arming is
   * deliberately not consulted. The explicit click is the authorization, and
   * the agent has no tool over this route.
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
        // Best-effort, as with discard; recording the exact sent message id
        // spares the learning loop a match.
        await markDraftStatus(
          req.params.accountId,
          req.params.draftId,
          "sent",
          result.sentMessageId,
        ).catch((error: unknown) =>
          req.log.warn({ err: error }, "marking draft snapshot sent failed"),
        );
        return { ok: true };
      } catch (error) {
        throw toProviderError(error, "draft not found");
      }
    },
  );

  app.get(
    "/api/drafts/:accountId/:draftId/status",
    { schema: { params: draftParams } },
    async (req) => {
      const status = await getDraftStatus(req.params.accountId, req.params.draftId);
      if (!status) throw notFound("draft snapshot not found");
      return status;
    },
  );

  // Saved exactly as typed; the humanizer runs only in the agent's create-draft tool.
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
        // Best-effort: the provider save succeeded, so report success even if
        // appending the user-authored snapshot version fails.
        await appendDraftVersion(req.params.accountId, req.params.draftId, "user", {
          body,
          subject,
        }).catch((error: unknown) =>
          req.log.warn({ err: error }, "appending user draft version failed"),
        );
        return { ok: true };
      } catch (error) {
        throw toProviderError(error, "draft not found");
      }
    },
  );
};
