import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { AccountWaiting, AccountWaitingOnYou, OpenConversations } from "@trailin/shared";
import { dismissThread } from "../email/enrich/enrichStore.js";
import { accountSupportsWaiting, listOpenConversations } from "../email/waiting.js";
import { notFound, upstreamError } from "../errors.js";
import { listAccounts, pipedreamConfigured } from "../pipedream/connect.js";
import { errorMessage } from "../util.js";

const waitingQuery = Type.Object({ refresh: Type.Optional(Type.String()) });
const dismissParams = Type.Object({ accountId: Type.String(), threadId: Type.String() });

export const waitingRoutes: FastifyPluginAsyncTypebox = async (app) => {
  /**
   * Home's "Open conversations" section, computed from the mailbox mirror,
   * per synced account: threads needing the owner's reply, and sent threads
   * still awaiting a counterpart's. A per-account fetch failure lands in
   * that account's own `error` field rather than failing the whole request,
   * so one broken account never hides everyone else's.
   */
  app.get(
    "/api/waiting",
    { schema: { querystring: waitingQuery } },
    async (req): Promise<OpenConversations> => {
      if (!(await pipedreamConfigured())) return { waitingOnYou: [], waitingOnOthers: [] };
      const refresh = req.query.refresh === "1";
      try {
        const accounts = (await listAccounts()).filter((a) => accountSupportsWaiting(a.app));
        const results = await Promise.all(
          accounts.map(async (account) => {
            try {
              const lanes = await listOpenConversations(account, { refresh });
              return {
                onYou: {
                  account: account.name,
                  accountId: account.id,
                  items: lanes.waitingOnYou,
                } satisfies AccountWaitingOnYou,
                onOthers: {
                  account: account.name,
                  accountId: account.id,
                  items: lanes.waitingOnOthers,
                } satisfies AccountWaiting,
              };
            } catch (error) {
              const failed = {
                account: account.name,
                accountId: account.id,
                error: errorMessage(error),
              };
              return {
                onYou: { ...failed, items: [] } satisfies AccountWaitingOnYou,
                onOthers: { ...failed, items: [] } satisfies AccountWaiting,
              };
            }
          }),
        );
        return {
          waitingOnYou: results.map((r) => r.onYou),
          waitingOnOthers: results.map((r) => r.onOthers),
        };
      } catch (error) {
        throw upstreamError(errorMessage(error), error);
      }
    },
  );

  /**
   * Dismisses one thread from the "waiting on you" lane by stamping its
   * current input_hash into dismissed_hash (enrichStore.ts) — a new inbound
   * message changes the hash, so a genuinely revived thread resurfaces on
   * its own. 404 when the thread has no enrichment state row yet.
   */
  app.post(
    "/api/waiting/:accountId/:threadId/dismiss",
    { schema: { params: dismissParams } },
    async (req) => {
      const dismissed = dismissThread(req.params.accountId, req.params.threadId);
      if (!dismissed) throw notFound("thread not found");
      return { ok: true };
    },
  );
};
