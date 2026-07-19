import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { badRequest, notFound } from "../core/errors.js";
import { errorMessage } from "../core/utils/util.js";
import {
  createMemory,
  deleteMemory,
  listMemories,
  updateMemory,
} from "../storage/memories/store.js";

const memoryBody = Type.Object({
  content: Type.String(),
  // null clears this scope axis; omitted keeps it on update, except that setting
  // one axis moves the memory there (the other clears). A memory carries
  // accountId OR contactId, never both; sending both non-null is rejected (memories/store.ts).
  accountId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  contactId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

const idParams = Type.Object({ id: Type.String() });

// Entries are injected into the system prompt, rebuilt every turn (and per
// scheduled run), so an edit reaches the next message with no session reset.
export const memoryRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get("/api/memories", async () => listMemories());

  app.post("/api/memories", { schema: { body: memoryBody } }, async (req) => {
    try {
      const result = await createMemory(
        req.body.content,
        "user",
        req.body.accountId ?? null,
        req.body.contactId ?? null,
      );
      return result.entry;
    } catch (error) {
      throw badRequest(errorMessage(error));
    }
  });

  app.put("/api/memories/:id", { schema: { params: idParams, body: memoryBody } }, async (req) => {
    let entry: Awaited<ReturnType<typeof updateMemory>>;
    try {
      entry = await updateMemory(
        req.params.id,
        req.body.content,
        req.body.accountId,
        req.body.contactId,
      );
    } catch (error) {
      throw badRequest(errorMessage(error));
    }
    if (!entry) throw notFound("memory not found");
    return entry;
  });

  app.delete("/api/memories/:id", { schema: { params: idParams } }, async (req) => {
    const deleted = await deleteMemory(req.params.id);
    if (!deleted) throw notFound("memory not found");
    return { ok: true };
  });
};
