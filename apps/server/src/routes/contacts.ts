import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import {
  CONTACT_CATEGORIES,
  CONTACT_KINDS,
  type ContactCategory,
  type ContactDetail,
  type ContactKind,
} from "@trailin/shared";
import { getContact, listContacts, setContactCategory } from "../email/contacts/contactsStore.js";
import { recentThreadsForContact } from "../email/contacts/contactsThreads.js";
import { badRequest, notFound } from "../errors.js";
import { emitServerEvent } from "../events.js";

const listQuery = Type.Object({
  kind: Type.Optional(Type.String()),
  category: Type.Optional(Type.String()),
  q: Type.Optional(Type.String()),
});

const addressParams = Type.Object({ address: Type.String() });
const patchBody = Type.Object({ category: Type.String() });

function isContactKind(value: string): value is ContactKind {
  return (CONTACT_KINDS as readonly string[]).includes(value);
}

function isContactCategory(value: string): value is ContactCategory {
  return (CONTACT_CATEGORIES as readonly string[]).includes(value);
}

/**
 * The contacts core (email/contacts/): one row per correspondent address,
 * aggregated from the mailbox mirror and judged by the enrichment pipeline.
 * Read-mostly — the only write is the category override.
 */
export const contactRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get("/api/contacts", { schema: { querystring: listQuery } }, async (req) => {
    const { kind, category, q } = req.query;
    if (kind !== undefined && !isContactKind(kind)) throw badRequest(`invalid kind "${kind}"`);
    if (category !== undefined && !isContactCategory(category)) {
      throw badRequest(`invalid category "${category}"`);
    }
    return listContacts({ kind, category, q });
  });

  app.get(
    "/api/contacts/:address",
    { schema: { params: addressParams } },
    async (req): Promise<ContactDetail> => {
      const address = req.params.address.trim().toLowerCase();
      const contact = getContact(address);
      if (!contact) throw notFound("contact not found");
      const recentThreads = await recentThreadsForContact(address);
      return { ...contact, recentThreads };
    },
  );

  /** The one manual override: pins category_source to "user" so enrichment never reverts it. */
  app.patch(
    "/api/contacts/:address",
    { schema: { params: addressParams, body: patchBody } },
    async (req) => {
      const address = req.params.address.trim().toLowerCase();
      if (!isContactCategory(req.body.category)) {
        throw badRequest(`invalid category "${req.body.category}"`);
      }
      const updated = setContactCategory(address, req.body.category);
      if (!updated) throw notFound("contact not found");
      emitServerEvent("contacts");
      return updated;
    },
  );
};
