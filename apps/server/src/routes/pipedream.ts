import type { FastifyInstance } from "fastify";
import type { PipedreamConfigInput } from "@trailin/shared";
import "../email/registerProviders.js";
import { invalidateDraftsCache } from "../email/draftsService.js";
import {
  clearConnectSettings,
  createConnectToken,
  deleteAccount,
  extractProjectId,
  getPipedreamStatus,
  getSavedClientSecret,
  getDefaultApps,
  invalidateAccountsCache,
  listAccounts,
  saveConnectSettings,
  searchApps,
  setUseCustom,
  verifyConnectConfig,
} from "../pipedream/connect.js";
import { env } from "../env.js";
import { resetSessions } from "../agent/emailAgent.js";
import { badRequest, notFound, upstreamError, upstreamStatusCode } from "../errors.js";
import { errorMessage } from "../util.js";

export async function pipedreamRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/pipedream", async () => getPipedreamStatus());

  app.put<{ Body: PipedreamConfigInput }>("/api/pipedream", async (req) => {
    const body = req.body ?? ({} as PipedreamConfigInput);
    const clientId = body.clientId?.trim();
    if (!clientId) {
      throw badRequest("clientId is required");
    }
    // The project field accepts a raw proj_… id or any URL containing one.
    const projectId = extractProjectId(body.project ?? "");
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
  app.put<{ Body: { useCustom: boolean } }>("/api/pipedream/mode", async (req) => {
    if (typeof req.body?.useCustom !== "boolean") {
      throw badRequest("useCustom must be a boolean");
    }
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

  app.get("/api/pipedream/accounts", async () => {
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
  app.get<{ Querystring: { q?: string } }>("/api/pipedream/apps", async (req) => {
    const q = req.query.q?.trim() || "";
    try {
      return q ? await searchApps(q) : await getDefaultApps();
    } catch (error) {
      throw upstreamError(errorMessage(error), error);
    }
  });

  app.post<{ Body: { app: string } }>(
    "/api/pipedream/accounts/connect-token",
    async (req) => {
      const appSlug = req.body?.app?.trim();
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

  app.delete<{ Params: { id: string } }>("/api/pipedream/accounts/:id", async (req) => {
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
    return { ok: true };
  });
}
