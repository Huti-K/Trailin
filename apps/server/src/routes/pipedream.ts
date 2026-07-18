import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { type ConnectedAccount, EMAIL_APPS } from "@trailin/shared";
import { resetSessions } from "../agent/sessionCache.js";
import { startVoiceLearnOnConnect } from "../agent/voiceLearn.js";
import { deleteVoiceLearnRun } from "../db/voiceRuns.js";
import { invalidateDraftsCache } from "../email/draftsCache.js";
import { env } from "../env.js";
import { badRequest, notFound, upstreamError, upstreamStatusCode } from "../errors.js";
import {
  clearConnectSettings,
  createConnectToken,
  deleteAccount,
  extractProjectId,
  getDefaultApps,
  getPipedreamStatus,
  getSavedClientSecret,
  invalidateAccountsCache,
  listAccounts,
  saveConnectSettings,
  searchApps,
  setUseCustom,
  verifyConnectConfig,
} from "../pipedream/connect.js";
import { errorMessage } from "../utils/util.js";

const pipedreamConfigBody = Type.Object({
  clientId: Type.String(),
  clientSecret: Type.Optional(Type.String()),
  // A raw proj_… id or any URL containing one.
  project: Type.String(),
  environment: Type.Optional(Type.String()),
});

const pipedreamModeBody = Type.Object({ useCustom: Type.Boolean() });

const appsQuerystring = Type.Object({ q: Type.Optional(Type.String()) });

const connectTokenBody = Type.Object({ app: Type.String() });

const accountIdParams = Type.Object({ id: Type.String() });

export const pipedreamRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get("/api/pipedream", async () => getPipedreamStatus());

  app.put("/api/pipedream", { schema: { body: pipedreamConfigBody } }, async (req) => {
    const body = req.body;
    const clientId = body.clientId.trim();
    if (!clientId) {
      throw badRequest("clientId is required");
    }
    // The project field accepts a raw proj_… id or any URL containing one.
    const projectId = extractProjectId(body.project);
    if (!projectId) {
      throw badRequest("project must be a proj_… id or a Pipedream project URL");
    }
    // An empty secret on edit means "keep the one already saved".
    const clientSecret = body.clientSecret?.trim() || (await getSavedClientSecret());
    if (!clientSecret) {
      throw badRequest("clientSecret is required");
    }
    const environment = body.environment === "production" ? "production" : "development";

    const candidate = {
      clientId,
      clientSecret,
      projectId,
      environment,
      externalUserId: env.pipedream.externalUserId,
    } as const;
    try {
      await verifyConnectConfig(candidate);
    } catch (error) {
      throw badRequest(`Pipedream rejected these credentials: ${errorMessage(error)}`);
    }

    await saveConnectSettings(candidate);
    // Saving your own credentials implies you want to use them.
    await setUseCustom(true);
    // Live agents hold MCP sessions built with the old credentials.
    await resetSessions();
    return getPipedreamStatus();
  });

  /** Switch between the built-in Pipedream credentials and the user's own. */
  app.put("/api/pipedream/mode", { schema: { body: pipedreamModeBody } }, async (req) => {
    await setUseCustom(req.body.useCustom);
    await resetSessions();
    return getPipedreamStatus();
  });

  app.delete("/api/pipedream", async () => {
    await clearConnectSettings();
    await resetSessions();
    return getPipedreamStatus();
  });

  /** ---- connected accounts (any app, any number per app) ---- */

  app.get("/api/pipedream/accounts", async (): Promise<ConnectedAccount[]> => {
    try {
      // This is the Settings/Connections screen, which refetches right after
      // the user finishes linking a new account in the Connect popup — it
      // must see that account immediately, and a forced refresh here
      // repopulates the shared cache for everyone else's next default-path call too.
      return await listAccounts({ refresh: true });
    } catch (error) {
      throw upstreamError(errorMessage(error), error);
    }
  });

  /** Search Pipedream's app catalog for the provider picker. */
  app.get("/api/pipedream/apps", { schema: { querystring: appsQuerystring } }, async (req) => {
    const q = req.query.q?.trim() || "";
    try {
      return q ? await searchApps(q) : await getDefaultApps();
    } catch (error) {
      throw upstreamError(errorMessage(error), error);
    }
  });

  app.post(
    "/api/pipedream/accounts/connect-token",
    { schema: { body: connectTokenBody } },
    async (req) => {
      const appSlug = req.body.app.trim();
      if (!appSlug || !/^[a-z0-9_]+$/.test(appSlug)) {
        throw badRequest("app must be a Pipedream app slug");
      }
      try {
        return await createConnectToken(appSlug);
      } catch (error) {
        throw upstreamError(errorMessage(error), error);
      }
    },
  );

  /**
   * Learn the account's writing voice from its own sent mail. The connect
   * flow calls this automatically for a freshly linked email account, and
   * the Settings account row's retry button calls it again after a failed
   * attempt. Runs in the background — sent mail is read live from the
   * provider — so this returns as soon as the job is launched.
   */
  app.post(
    "/api/pipedream/accounts/:id/learn-voice",
    { schema: { params: accountIdParams } },
    async (req) => {
      const account = (await listAccounts()).find((a) => a.id === req.params.id);
      if (!account) throw notFound("account not found");
      if (!(EMAIL_APPS as readonly string[]).includes(account.app)) {
        throw badRequest("voice learning needs an email account");
      }
      startVoiceLearnOnConnect(account.id);
      return { ok: true };
    },
  );

  app.delete(
    "/api/pipedream/accounts/:id",
    { schema: { params: accountIdParams } },
    async (req) => {
      try {
        await deleteAccount(req.params.id);
      } catch (error) {
        // Pipedream 404s when the account is already gone — that's a client-
        // facing 404, not an outage.
        if (upstreamStatusCode(error) === 404) throw notFound("account not found");
        throw upstreamError(errorMessage(error), error);
      }
      // Live agents may hold tools for the removed account.
      await resetSessions();
      invalidateDraftsCache(req.params.id);
      // The account list itself just changed.
      invalidateAccountsCache();
      // Drop the account's voice-learn attempt state with it.
      await deleteVoiceLearnRun(req.params.id);
      return { ok: true };
    },
  );
};
