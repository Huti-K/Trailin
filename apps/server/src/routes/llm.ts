import type { FastifyInstance } from "fastify";
import {
  clearCredential,
  getModelSettings,
  listProviders,
  saveApiKey,
  setActiveModelIds,
} from "../llm/registry.js";
import {
  cancelLogin,
  getLoginStatus,
  provideLoginInput,
  provideLoginSelection,
  startLogin,
} from "../llm/loginFlow.js";
import { resetSessions } from "../agent/emailAgent.js";
import { badRequest, conflict } from "../errors.js";
import { errorMessage } from "../util.js";

export async function llmRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/llm/providers", async () => listProviders());

  app.get("/api/llm/model", async () => getModelSettings());

  app.put<{ Body: { provider: string; model: string } }>("/api/llm/model", async (req) => {
    const { provider, model } = req.body ?? {};
    if (!provider || !model) {
      throw badRequest("provider and model are required");
    }
    try {
      await setActiveModelIds(provider, model);
    } catch (error) {
      throw badRequest(errorMessage(error));
    }
    // New conversations pick up the new model; existing in-memory agents are dropped.
    await resetSessions();
    return getModelSettings();
  });

  app.get("/api/llm/login/status", async () => getLoginStatus());

  app.post<{ Body: { providerId: string } }>("/api/llm/login/start", async (req) => {
    const providerId = req.body?.providerId;
    if (!providerId) throw badRequest("providerId is required");
    try {
      return startLogin(providerId, {
        info: (m) => req.log.info(m),
        warn: (m) => req.log.warn(m),
      });
    } catch (error) {
      throw conflict(errorMessage(error));
    }
  });

  app.post<{ Body: { value: string } }>("/api/llm/login/input", async (req) => {
    const value = req.body?.value?.trim();
    if (!value) throw badRequest("value is required");
    try {
      provideLoginInput(value);
      return { ok: true };
    } catch (error) {
      throw conflict(errorMessage(error));
    }
  });

  app.post<{ Body: { optionId: string } }>("/api/llm/login/select", async (req) => {
    const optionId = req.body?.optionId;
    if (!optionId) throw badRequest("optionId is required");
    try {
      provideLoginSelection(optionId);
      return { ok: true };
    } catch (error) {
      throw conflict(errorMessage(error));
    }
  });

  app.post("/api/llm/login/cancel", async () => {
    cancelLogin();
    return { ok: true };
  });

  app.post<{ Body: { providerId: string; apiKey: string } }>(
    "/api/llm/key",
    async (req) => {
      const { providerId, apiKey } = req.body ?? {};
      if (!providerId || !apiKey?.trim()) {
        throw badRequest("providerId and apiKey are required");
      }
      // Only saveApiKey's own validation belongs to this catch — resetSessions
      // below is a separate failure mode and must not be reported as a bad
      // request too.
      try {
        await saveApiKey(providerId, apiKey.trim());
      } catch (error) {
        throw badRequest(errorMessage(error));
      }
      await resetSessions();
      return { ok: true };
    },
  );

  app.post<{ Body: { providerId: string } }>("/api/llm/logout", async (req) => {
    const providerId = req.body?.providerId;
    if (!providerId) throw badRequest("providerId is required");
    await clearCredential(providerId);
    await resetSessions();
    return { ok: true };
  });
}
