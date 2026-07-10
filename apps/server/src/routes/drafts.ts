import type { FastifyInstance } from "fastify";
import { eq, inArray } from "drizzle-orm";
import type { AccountDrafts, ConnectedAccount, EmailDraft, EmailThread } from "@trailin/shared";
import { db, schema } from "../db/index.js";
import "../email/registerProviders.js";
import { listDraftsCached } from "../email/draftsService.js";
import { getDraftProvider, type DraftProvider } from "../email/providers.js";
import { listAccounts, pipedreamConfigured } from "../pipedream/connect.js";
import { AppError, badRequest, notFound, upstreamError, upstreamStatusCode } from "../errors.js";
import { errorMessage } from "../util.js";

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
 * A provider (Gmail/Outlook, via the Pipedream proxy) throwing 404 means the
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
 * Attach the conversation that created each draft (draft_links), so the UI's
 * refine action can reopen that exact chat. Joined against conversations so a
 * deleted chat degrades to "no link" instead of navigating into a dead id.
 */
async function attachConversationLinks(byAccount: AccountDrafts[]): Promise<AccountDrafts[]> {
  const draftIds = byAccount.flatMap((a) => a.drafts.map((d) => d.id));
  if (draftIds.length === 0) return byAccount;

  const links = await db
    .select({
      draftId: schema.draftLinks.draftId,
      conversationId: schema.draftLinks.conversationId,
    })
    .from(schema.draftLinks)
    .innerJoin(schema.conversations, eq(schema.conversations.id, schema.draftLinks.conversationId))
    .where(inArray(schema.draftLinks.draftId, draftIds));
  if (links.length === 0) return byAccount;

  const byDraftId = new Map(links.map((l) => [l.draftId, l.conversationId]));
  return byAccount.map((account) => ({
    ...account,
    drafts: account.drafts.map((draft): EmailDraft => {
      const conversationId = byDraftId.get(draft.id);
      return conversationId ? { ...draft, conversationId } : draft;
    }),
  }));
}

export async function draftRoutes(app: FastifyInstance): Promise<void> {
  /** Live drafts per connected account that has a DraftProvider (Gmail, Outlook, ...). */
  app.get<{ Querystring: { refresh?: string } }>(
    "/api/drafts",
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
  app.get<{ Params: { accountId: string; draftId: string } }>(
    "/api/drafts/:accountId/:draftId",
    async (req) => {
      try {
        const found = await findDraftAccount(req.params.accountId);
        if (!found) throw notFound("account not found");
        return await found.provider.getDraftDetail(found.account, req.params.draftId);
      } catch (error) {
        throw toProviderError(error, "draft not found");
      }
    },
  );

  /** Discard a draft (user-initiated from the UI; the agent has no such tool). */
  app.delete<{ Params: { accountId: string; draftId: string } }>(
    "/api/drafts/:accountId/:draftId",
    async (req) => {
      try {
        const found = await findDraftAccount(req.params.accountId);
        if (!found) throw notFound("account not found");
        await found.provider.deleteDraft(found.account, req.params.draftId);
        return { ok: true };
      } catch (error) {
        throw toProviderError(error, "draft not found");
      }
    },
  );

  /**
   * Save body/subject edits to an existing draft, exactly as typed — no
   * humanizer, no signature (those only run in the agent's create-draft
   * tool). `updateDraft` is an optional DraftProvider capability — a provider
   * without one (no driver written yet) reports 400 rather than assuming
   * every connected account works like Gmail.
   */
  app.patch<{
    Params: { accountId: string; draftId: string };
    Body: { body?: string; subject?: string };
  }>("/api/drafts/:accountId/:draftId", async (req) => {
    try {
      const found = await findDraftAccount(req.params.accountId);
      if (!found) throw notFound("account not found");
      if (!found.provider.updateDraft) {
        throw badRequest("editing a draft is not supported for this account");
      }
      const { body, subject } = req.body ?? {};
      await found.provider.updateDraft(found.account, req.params.draftId, { body, subject });
      return { ok: true };
    } catch (error) {
      throw toProviderError(error, "draft not found");
    }
  });

  /**
   * The full email thread a draft belongs to, for the in-app viewer.
   * `getThread` is an optional DraftProvider capability, same reasoning as
   * updateDraft above. `excludeMessageId` omits the draft's own message,
   * which some providers (Gmail) count as part of the thread it replies to.
   */
  app.get<{
    Params: { accountId: string; threadId: string };
    Querystring: { excludeMessageId?: string };
  }>(
    "/api/threads/:accountId/:threadId",
    async (req): Promise<EmailThread> => {
      try {
        const found = await findDraftAccount(req.params.accountId);
        if (!found) throw notFound("account not found");
        if (!found.provider.getThread) {
          throw badRequest("reading the thread is not supported for this account");
        }
        const exclude = req.query.excludeMessageId?.trim();
        const messages = await found.provider.getThread(found.account, req.params.threadId, {
          ...(exclude ? { excludeMessageId: exclude } : {}),
        });
        return { messages };
      } catch (error) {
        throw toProviderError(error, "thread not found");
      }
    },
  );
}
