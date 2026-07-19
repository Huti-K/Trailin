import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { LearnStatus, VoiceLearnRun } from "@trailin/shared";
import { listLearnRuns } from "../db/learnRuns.js";
import { listVoiceLearnRuns } from "../db/voiceRuns.js";
import { nextLearnRunAt } from "../email/learn/service.js";

export const learnRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get("/api/learn/status", async (): Promise<LearnStatus> => {
    return { runs: await listLearnRuns(), nextRunAt: nextLearnRunAt() };
  });

  app.get("/api/learn/voice-runs", async (): Promise<VoiceLearnRun[]> => listVoiceLearnRuns());
};
