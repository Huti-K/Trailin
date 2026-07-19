import type { Lead } from "@trailin/shared";
import { eq } from "drizzle-orm";
import { deleteAutomation } from "../automations/manage.js";
import { badRequest } from "../core/errors.js";
import { db, schema } from "../db/index.js";
import {
  createLead,
  deleteLead,
  findLeadByEmail,
  type LeadInput,
  normalizeLeadEmail,
  updateLead,
} from "../db/leads.js";

/**
 * Lead intake and removal, shared by the HTTP routes and the agent's lead tools
 * so both get identical validation, email-keyed dedup, and the cascade over a
 * lead's automations. Validation failures throw AppErrors, surfaced as steering
 * text to the agent.
 */

const EMAILISH = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Create the lead, or merge into the row already keyed by this address. Merging
 * is deliberately conservative: repeat intake never regresses what's known,
 * so it only fills empty fields, leaves status untouched, and advances the two
 * last-message timestamps monotonically.
 */
export async function recordLead(input: LeadInput): Promise<{ lead: Lead; created: boolean }> {
  const email = normalizeLeadEmail(input.email);
  if (!EMAILISH.test(email)) throw badRequest(`not an email address: ${input.email}`);

  const existing = await findLeadByEmail(email);
  if (!existing) {
    return { lead: await createLead({ ...input, email }), created: true };
  }

  const lead = await updateLead(existing.id, {
    name: fillEmpty(existing.name, input.name),
    phone: fillEmpty(existing.phone, input.phone),
    accountId: fillEmpty(existing.accountId, input.accountId),
    interest: fillEmpty(existing.interest, input.interest),
    persona: fillEmpty(existing.persona, input.persona),
    priority: existing.priority === "" ? input.priority : undefined,
    language: fillEmpty(existing.language, input.language),
    notes: fillEmpty(existing.notes, input.notes),
    onofficeAddressId: existing.onofficeAddressId ?? input.onofficeAddressId,
    lastInboundAt: latest(existing.lastInboundAt, input.lastInboundAt),
    lastOutboundAt: latest(existing.lastOutboundAt, input.lastOutboundAt),
  });
  if (!lead) throw new Error(`lead ${existing.id} vanished during merge`);
  return { lead, created: false };
}

export async function removeLead(id: string): Promise<boolean> {
  const attached = await db
    .select({ id: schema.automations.id })
    .from(schema.automations)
    .where(eq(schema.automations.leadId, id));
  for (const automation of attached) await deleteAutomation(automation.id);
  return deleteLead(id);
}

function fillEmpty(current: string, incoming: string | undefined): string | undefined {
  if (current !== "") return undefined;
  return incoming;
}

/** ISO timestamps compare correctly as strings; undefined/null never win. */
function latest(current: string | null, incoming: string | null | undefined): string | undefined {
  if (!incoming) return undefined;
  if (current && current >= incoming) return undefined;
  return incoming;
}
