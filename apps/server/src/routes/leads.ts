import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { Automation, Lead } from "@trailin/shared";
import { desc, eq } from "drizzle-orm";
import { getNextRunAt } from "../automations/scheduler.js";
import { notFound } from "../core/errors.js";
import { db, schema } from "../db/index.js";
import { getLead, type LeadPatch, listLeads, updateLead } from "../db/leads.js";
import { recordLead, removeLead } from "../leads/manage.js";

const idParams = Type.Object({ id: Type.String() });

const statusValue = Type.Union([
  Type.Literal("new"),
  Type.Literal("contacted"),
  Type.Literal("engaged"),
  Type.Literal("qualified"),
  Type.Literal("won"),
  Type.Literal("lost"),
]);

const listQuery = Type.Object({ status: Type.Optional(statusValue) });

const priorityValue = Type.Union([
  Type.Literal("A"),
  Type.Literal("B"),
  Type.Literal("C"),
  Type.Literal(""),
]);

const recordBody = Type.Object({
  email: Type.String(),
  name: Type.Optional(Type.String()),
  phone: Type.Optional(Type.String()),
  accountId: Type.Optional(Type.String()),
  source: Type.Optional(
    Type.Union([Type.Literal("email"), Type.Literal("manual"), Type.Literal("onoffice")]),
  ),
  onofficeAddressId: Type.Optional(Type.String()),
  interest: Type.Optional(Type.String()),
  persona: Type.Optional(Type.String()),
  priority: Type.Optional(priorityValue),
  language: Type.Optional(Type.String()),
  notes: Type.Optional(Type.String()),
});

const patchBody = Type.Object({
  name: Type.Optional(Type.String()),
  phone: Type.Optional(Type.String()),
  accountId: Type.Optional(Type.String()),
  onofficeAddressId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  status: Type.Optional(statusValue),
  interest: Type.Optional(Type.String()),
  persona: Type.Optional(Type.String()),
  priority: Type.Optional(priorityValue),
  language: Type.Optional(Type.String()),
  notes: Type.Optional(Type.String()),
  lastInboundAt: Type.Optional(Type.String()),
  lastOutboundAt: Type.Optional(Type.String()),
});

export const leadsRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get("/api/leads", { schema: { querystring: listQuery } }, async (req): Promise<Lead[]> => {
    return listLeads({ status: req.query.status });
  });

  app.post(
    "/api/leads",
    { schema: { body: recordBody } },
    async (req): Promise<{ lead: Lead; created: boolean }> => {
      return recordLead({ ...req.body, source: req.body.source ?? "manual" });
    },
  );

  app.patch(
    "/api/leads/:id",
    { schema: { params: idParams, body: patchBody } },
    async (req): Promise<Lead> => {
      const lead = await updateLead(req.params.id, req.body as LeadPatch);
      if (!lead) throw notFound("no lead with this id");
      return lead;
    },
  );

  app.delete("/api/leads/:id", { schema: { params: idParams } }, async (req) => {
    const deleted = await removeLead(req.params.id);
    if (!deleted) throw notFound("no lead with this id");
    return { ok: true };
  });

  app.get(
    "/api/leads/:id/automations",
    { schema: { params: idParams } },
    async (req): Promise<Automation[]> => {
      if (!(await getLead(req.params.id))) throw notFound("no lead with this id");
      const rows = await db
        .select()
        .from(schema.automations)
        .where(eq(schema.automations.leadId, req.params.id))
        .orderBy(desc(schema.automations.createdAt));
      return rows.map((row) => ({ ...row, nextRunAt: getNextRunAt(row.id) }));
    },
  );
};
