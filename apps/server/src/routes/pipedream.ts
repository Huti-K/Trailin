import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { type ConnectedAccount, EMAIL_APPS } from "@trailin/shared";
import { resetSessions } from "../agent/sessionCache.js";
import { startVoiceLearnOnConnect } from "../agent/voiceLearn.js";
import { env } from "../core/env.js";
import { badRequest, notFound, upstreamError, upstreamStatusCode } from "../core/errors.js";
import { emitServerEvent } from "../core/events.js";
import { errorMessage } from "../core/utils/util.js";
import { deleteVoiceLearnRun } from "../db/voiceRuns.js";
import { invalidateDraftsCache } from "../email/draftsCache.js";
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
} from "../integrations/pipedream/connect.js";

const pipedreamConfigBody = Type.Object({
  clientId: Type.String(),
  clientSecret: Type.Optional(Type.String()),
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
    const projectId = extractProjectId(body.project);
    if (!projectId) {
      throw badRequest("project must be a proj_… id or a Pipedream project URL");
    }
    // An empty secret on edit keeps the one already saved.
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
    emitServerEvent("accounts");
    return getPipedreamStatus();
  });

  app.put("/api/pipedream/mode", { schema: { body: pipedreamModeBody } }, async (req) => {
    await setUseCustom(req.body.useCustom);
    await resetSessions();
    emitServerEvent("accounts");
    return getPipedreamStatus();
  });

  app.delete("/api/pipedream", async () => {
    await clearConnectSettings();
    await resetSessions();
    emitServerEvent("accounts");
    return getPipedreamStatus();
  });

  app.get("/api/pipedream/accounts", async (): Promise<ConnectedAccount[]> => {
    try {
      // Force a refresh: this screen refetches right after linking an account
      // and sees it immediately (and repopulates the shared cache).
      return await listAccounts({ refresh: true });
    } catch (error) {
      throw upstreamError(errorMessage(error), error);
    }
  });

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
      emitServerEvent("accounts");
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
        // Pipedream 404s when the account is already gone: a client-facing 404, not an outage.
        if (upstreamStatusCode(error) === 404) throw notFound("account not found");
        throw upstreamError(errorMessage(error), error);
      }
      // Live agents may hold tools for the removed account.
      await resetSessions();
      invalidateDraftsCache(req.params.id);
      invalidateAccountsCache();
      emitServerEvent("accounts");
      await deleteVoiceLearnRun(req.params.id);
      return { ok: true };
    },
  );
};
