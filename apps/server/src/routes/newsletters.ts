import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { NewsletterSender, UnsubscribeResult } from "@trailin/shared";
import {
  executeAndMarkUnsubscribe,
  listNewsletterSenders,
  resolveAccountUnsubscribe,
} from "../email/unsubscribe/resolve.js";
import { badRequest, notFound, upstreamError } from "../errors.js";
import { moduleLogger } from "../logger.js";
import { listAccounts, pipedreamConfigured } from "../pipedream/connect.js";
import { errorMessage } from "../util.js";

const log = moduleLogger("newsletters-routes");

const unsubscribeBody = Type.Object({
  address: Type.String(),
  accountId: Type.String(),
});

/**
 * Newsletter/bulk-sender unsubscribe. GET lists contacts' kind="bulk" rows
 * with their resolved unsubscribe state, lazily backfilling headers for a
 * bounded number of Outlook-driven senders per request (see
 * email/unsubscribe/resolve.ts). POST fires the RFC 8058 one-click request
 * for one sender/account pair — a human clicking the button is the only
 * authorization this needs, so unlike the agent's MCP write tools it
 * deliberately does not consult per-account write-arming.
 */
export const newsletterRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get("/api/newsletters", async (): Promise<NewsletterSender[]> => {
    if (!(await pipedreamConfigured())) return [];
    try {
      return await listNewsletterSenders();
    } catch (error) {
      throw upstreamError(errorMessage(error), error);
    }
  });

  app.post(
    "/api/newsletters/unsubscribe",
    { schema: { body: unsubscribeBody } },
    async (req): Promise<UnsubscribeResult> => {
      const { address, accountId } = req.body;
      const account = (await listAccounts()).find((a) => a.id === accountId);
      if (!account) throw notFound("account not found");

      let resolved: Awaited<ReturnType<typeof resolveAccountUnsubscribe>>;
      try {
        resolved = await resolveAccountUnsubscribe(address, account);
      } catch (error) {
        throw upstreamError(errorMessage(error), error);
      }

      if (resolved.info.state !== "one_click" || !resolved.oneClickUrl) {
        if (resolved.info.state === "browse" && resolved.info.browseUrl) {
          throw badRequest(
            `${address} has no one-click unsubscribe; open this link instead: ${resolved.info.browseUrl}`,
          );
        }
        throw badRequest(`No one-click unsubscribe is available for ${address}.`);
      }

      const result = await executeAndMarkUnsubscribe(address, resolved.oneClickUrl);
      if (!result.ok) {
        log.warn({ address, accountId, err: result.error }, "one-click unsubscribe request failed");
        throw upstreamError(result.error ?? "unsubscribe request failed");
      }
      return { ok: true, state: "requested" };
    },
  );
};
