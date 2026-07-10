import type { FastifyInstance } from "fastify";
import { createMemory, deleteMemory, listMemories, updateMemory } from "../db/memories.js";
import { resetSessions } from "../agent/emailAgent.js";
import { badRequest, notFound } from "../errors.js";
import { errorMessage } from "../util.js";

/**
 * Long-term memory, managed in Settings. Memory lives in the system prompt,
 * so every change drops the in-memory agent sessions — the next message (and
 * scheduled runs) see the updated memory.
 */
export async function memoryRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/memories", async () => listMemories());

  app.post<{ Body: { content?: string; accountId?: string | null } }>(
    "/api/memories",
    async (req) => {
      const { accountId } = req.body ?? {};
      if (accountId !== undefined && accountId !== null && typeof accountId !== "string") {
        throw badRequest("accountId must be a string or null");
      }
      // Only createMemory's own validation (empty/too-long content, memory
      // full) belongs to this catch — resetSessions below is a separate
      // failure mode and must not be reported as a bad request too.
      let result: Awaited<ReturnType<typeof createMemory>>;
      try {
        result = await createMemory(req.body?.content ?? "", "user", accountId ?? null);
      } catch (error) {
        throw badRequest(errorMessage(error));
      }
      // A dedup hit returns the existing entry unchanged — no need to reset sessions.
      if (result.created) await resetSessions();
      return result.entry;
    },
  );

  app.put<{ Params: { id: string }; Body: { content?: string; accountId?: string | null } }>(
    "/api/memories/:id",
    async (req) => {
      const { accountId } = req.body ?? {};
      if (accountId !== undefined && accountId !== null && typeof accountId !== "string") {
        throw badRequest("accountId must be a string or null");
      }
      let entry: Awaited<ReturnType<typeof updateMemory>>;
      try {
        // accountId undefined (omitted from the body) keeps the entry's current scope.
        entry = await updateMemory(req.params.id, req.body?.content ?? "", accountId);
      } catch (error) {
        throw badRequest(errorMessage(error));
      }
      if (!entry) throw notFound("memory not found");
      await resetSessions();
      return entry;
    },
  );

  app.delete<{ Params: { id: string } }>("/api/memories/:id", async (req) => {
    const deleted = await deleteMemory(req.params.id);
    if (!deleted) throw notFound("memory not found");
    await resetSessions();
    return { ok: true };
  });
}
