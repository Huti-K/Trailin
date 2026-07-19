import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import {
  cancelLogin,
  getLoginStatus,
  provideLoginInput,
  provideLoginSelection,
  startLogin,
} from "../agent/llm/loginFlow.js";
import {
  clearCredential,
  getModelSettings,
  listProviders,
  saveApiKey,
  setActiveModelIds,
} from "../agent/llm/registry.js";
import { resetSessions } from "../agent/sessionCache.js";
import { badRequest, conflict } from "../core/errors.js";
import { errorMessage } from "../core/utils/util.js";

const modelBody = Type.Object({ provider: Type.String(), model: Type.String() });

const providerIdBody = Type.Object({ providerId: Type.String() });

const loginInputBody = Type.Object({ value: Type.String() });

const loginSelectBody = Type.Object({ optionId: Type.String() });

const keyBody = Type.Object({ providerId: Type.String(), apiKey: Type.String() });

export const llmRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get("/api/llm/providers", async () => listProviders());

  app.get("/api/llm/model", async () => getModelSettings());

  app.put("/api/llm/model", { schema: { body: modelBody } }, async (req) => {
    try {
      await setActiveModelIds(req.body.provider, req.body.model);
    } catch (error) {
      throw badRequest(errorMessage(error));
    }
    // New conversations pick up the new model; drop existing in-memory agents.
    await resetSessions();
    return getModelSettings();
  });

  app.get("/api/llm/login/status", async () => getLoginStatus());

  app.post("/api/llm/login/start", { schema: { body: providerIdBody } }, async (req) => {
    try {
      return startLogin(req.body.providerId, {
        info: (m) => req.log.info(m),
        warn: (m) => req.log.warn(m),
      });
    } catch (error) {
      throw conflict(errorMessage(error));
    }
  });

  app.post("/api/llm/login/input", { schema: { body: loginInputBody } }, async (req) => {
    const value = req.body.value.trim();
    if (!value) throw badRequest("value is required");
    try {
      provideLoginInput(value);
      return { ok: true };
    } catch (error) {
      throw conflict(errorMessage(error));
    }
  });

  app.post("/api/llm/login/select", { schema: { body: loginSelectBody } }, async (req) => {
    try {
      provideLoginSelection(req.body.optionId);
      return { ok: true };
    } catch (error) {
      throw conflict(errorMessage(error));
    }
  });

  app.post("/api/llm/login/cancel", async () => {
    cancelLogin();
    return { ok: true };
  });

  app.post("/api/llm/key", { schema: { body: keyBody } }, async (req) => {
    const apiKey = req.body.apiKey.trim();
    if (!apiKey) {
      throw badRequest("providerId and apiKey are required");
    }
    // Only saveApiKey's validation belongs in this catch; a resetSessions
    // failure below is not reported as a 400 too.
    try {
      await saveApiKey(req.body.providerId, apiKey);
    } catch (error) {
      throw badRequest(errorMessage(error));
    }
    await resetSessions();
    return { ok: true };
  });

  app.post("/api/llm/logout", { schema: { body: providerIdBody } }, async (req) => {
    await clearCredential(req.body.providerId);
    await resetSessions();
    return { ok: true };
  });
};
