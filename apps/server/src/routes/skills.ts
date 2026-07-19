import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { badRequest, notFound } from "../core/errors.js";
import { errorMessage } from "../core/utils/util.js";
import { deleteSkill, listSkills, readSkill, writeSkill } from "../storage/skills/store.js";

const skillBody = Type.Object({
  description: Type.String(),
  instructions: Type.String(),
});

const nameParams = Type.Object({ name: Type.String() });

// The agent's prompt index is rebuilt from the skills folder every turn, so an
// edit reaches the next message with no session reset.
export const skillRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get("/api/skills", async () => listSkills());

  app.get("/api/skills/:name", { schema: { params: nameParams } }, async (req) => {
    const skill = await readSkill(req.params.name);
    if (!skill) throw notFound("skill not found");
    return skill;
  });

  app.put("/api/skills/:name", { schema: { params: nameParams, body: skillBody } }, async (req) => {
    try {
      return await writeSkill(req.params.name, req.body.description, req.body.instructions);
    } catch (error) {
      throw badRequest(errorMessage(error));
    }
  });

  app.delete("/api/skills/:name", { schema: { params: nameParams } }, async (req) => {
    const deleted = await deleteSkill(req.params.name);
    if (!deleted) throw notFound("skill not found");
    return { ok: true };
  });
};
