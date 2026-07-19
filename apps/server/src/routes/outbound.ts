import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { badRequest, notFound } from "../core/errors.js";
import { getOutboundChannel } from "../outbound/registry.js";
import { getOutboundDraft, markOutboundStatus } from "../outbound/store.js";

const idParams = Type.Object({ id: Type.String() });

export const outboundRoutes: FastifyPluginAsyncTypebox = async (app) => {
  /**
   * Human-initiated send (the card's Send button): no permission is consulted,
   * the explicit click is the authorization, and the agent has no tool over
   * this route. Armed autosend goes through the channel at draft time instead.
   */
  app.post("/api/outbound/:id/send", { schema: { params: idParams } }, async (req) => {
    const draft = await getOutboundDraft(req.params.id);
    if (!draft) throw notFound("outbound draft not found");
    if (draft.status === "sent") return { ok: true };
    const channel = getOutboundChannel(draft.channel);
    if (!channel) throw badRequest(`unknown outbound channel: ${draft.channel}`);
    const { sentRef } = await channel.send(draft);
    await markOutboundStatus(draft.id, "sent", sentRef).catch((error: unknown) =>
      req.log.warn({ err: error }, "marking outbound draft sent failed"),
    );
    return { ok: true };
  });

  app.delete("/api/outbound/:id", { schema: { params: idParams } }, async (req) => {
    if (!(await markOutboundStatus(req.params.id, "discarded"))) {
      throw notFound("outbound draft not found");
    }
    return { ok: true };
  });

  app.get("/api/outbound/:id/status", { schema: { params: idParams } }, async (req) => {
    const draft = await getOutboundDraft(req.params.id);
    if (!draft) throw notFound("outbound draft not found");
    return { status: draft.status, ...(draft.sentRef ? { sentRef: draft.sentRef } : {}) };
  });
};
