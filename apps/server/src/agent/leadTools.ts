import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { Lead } from "@trailin/shared";
import { getLead, listLeads, updateLead } from "../db/leads.js";
import { recordLead, removeLead } from "../leads/manage.js";
import { textResult, tool } from "./toolkit.js";

/**
 * Record/read/update stay available to unattended runs: a lead row is inert
 * data (never executed like an automation instruction), so the worst a
 * prompt-injected email can do is file itself as a lead. Deletion is
 * interactive-only: it cascades over the lead's automations, and destroying
 * pipeline state is a human call.
 */

const STATUS_DESCRIPTION =
  `Lifecycle status: "new" (recorded, no outreach yet), "contacted" (we wrote to them, awaiting ` +
  `reply), "engaged" (they replied, conversation ongoing), "qualified" (serious prospect), ` +
  `"won" or "lost" (closed).`;

const prioritySchema = Type.Union([Type.Literal("A"), Type.Literal("B"), Type.Literal("C")], {
  description:
    "Priority tier from purchase likelihood: A hot (concrete budget, time pressure, or a " +
    "viewing wish for a specific unit), B warm (a clear search profile without urgency), " +
    "C cold (a vague first inquiry).",
});

const languageSchema = Type.String({
  description: 'Language of the inquiry as a BCP-47 primary subtag, e.g. "de", "en", "tr".',
});

function leadLine(lead: Lead): string {
  const who = lead.name ? `${lead.name} <${lead.email}>` : lead.email;
  const details = [
    lead.interest && `interest: ${lead.interest}`,
    lead.persona && `persona: ${lead.persona}`,
    lead.priority && `priority ${lead.priority}`,
    lead.language && `lang ${lead.language}`,
    lead.phone && `phone ${lead.phone}`,
    lead.accountId && `via account ${lead.accountId}`,
    lead.onofficeAddressId && `onOffice address ${lead.onofficeAddressId}`,
    `last inbound ${lead.lastInboundAt ?? "never"}`,
    `last outbound ${lead.lastOutboundAt ?? "never"}`,
    lead.notes && `notes: ${lead.notes}`,
  ].filter(Boolean);
  return `- [${lead.id}] ${who} — ${lead.status}\n  ${details.join("; ")}`;
}

const leadRecord: AgentTool = tool({
  name: "lead_record",
  label: "Record lead",
  description:
    `Record a prospect in the leads directory — whenever an email (or conversation) shows ` +
    `someone interested in a property, a viewing, or the user's services, file them here. One ` +
    `row per email address: recording a known address merges (fills missing fields, advances ` +
    `the last-message timestamps) instead of duplicating, so it is always safe to call. When ` +
    `recording from an email, pass the message date as inboundAt and the mailbox as accountId. ` +
    `Use lead_update to change status or rewrite fields.`,
  params: {
    email: Type.String({ description: "The prospect's email address — the lead's identity." }),
    name: Type.Optional(Type.String({ description: "Display name, when known." })),
    phone: Type.Optional(Type.String()),
    accountId: Type.Optional(
      Type.String({ description: "Connected account the correspondence runs through." }),
    ),
    interest: Type.Optional(
      Type.String({ description: "What they're after: property, budget, area, timeframe…" }),
    ),
    persona: Type.Optional(
      Type.String({
        description: 'Buyer type in a few words, e.g. "Kapitalanleger", "junge Familie".',
      }),
    ),
    priority: Type.Optional(prioritySchema),
    language: Type.Optional(languageSchema),
    notes: Type.Optional(Type.String({ description: "Anything else worth keeping." })),
    inboundAt: Type.Optional(
      Type.String({ description: "ISO date of the email this came from, e.g. its Date header." }),
    ),
  },
  catchToText: true,
  execute: async ({ inboundAt, ...rest }) => {
    const { lead, created } = await recordLead({
      ...rest,
      source: "email",
      lastInboundAt: inboundAt ?? null,
    });
    return textResult(
      created
        ? `Recorded new lead:\n${leadLine(lead)}`
        : `Lead already known — merged the new details:\n${leadLine(lead)}`,
    );
  },
});

const leadList: AgentTool = tool({
  name: "lead_list",
  label: "List leads",
  description:
    `The leads directory — every recorded prospect with id, status, interest and the last ` +
    `message in each direction ("who owes whom a reply"). Filter by status to find e.g. all ` +
    `"contacted" leads whose reply you should check for. Use the id with lead_update or ` +
    `lead_delete, and the email address to search the mailbox for their messages.`,
  params: {
    status: Type.Optional(
      Type.Union(
        [
          Type.Literal("new"),
          Type.Literal("contacted"),
          Type.Literal("engaged"),
          Type.Literal("qualified"),
          Type.Literal("won"),
          Type.Literal("lost"),
        ],
        { description: STATUS_DESCRIPTION },
      ),
    ),
  },
  execute: async ({ status }) => {
    const leads = await listLeads({ status });
    if (leads.length === 0) {
      return textResult(
        status
          ? `No leads with status "${status}".`
          : "The leads directory is empty — record prospects with lead_record.",
      );
    }
    return textResult(leads.map(leadLine).join("\n"));
  },
});

const leadUpdate: AgentTool = tool({
  name: "lead_update",
  label: "Update lead",
  description:
    `Update a lead — pass its id (from lead_list) and only the fields to change. Move status ` +
    `along the pipeline as the correspondence develops: after sending them an email set ` +
    `"contacted" and outboundAt; when they replied set "engaged" and inboundAt; close with ` +
    `"won" or "lost". Text fields replace the stored value entirely, so extend existing notes ` +
    `rather than dropping them.`,
  params: {
    id: Type.String({ description: "The lead id (from lead_list)." }),
    name: Type.Optional(Type.String()),
    phone: Type.Optional(Type.String()),
    accountId: Type.Optional(Type.String()),
    onofficeAddressId: Type.Optional(
      Type.String({ description: "onOffice address record id, once created/found in the CRM." }),
    ),
    status: Type.Optional(
      Type.Union(
        [
          Type.Literal("new"),
          Type.Literal("contacted"),
          Type.Literal("engaged"),
          Type.Literal("qualified"),
          Type.Literal("won"),
          Type.Literal("lost"),
        ],
        { description: STATUS_DESCRIPTION },
      ),
    ),
    interest: Type.Optional(Type.String({ description: "Complete replacement text." })),
    persona: Type.Optional(
      Type.String({ description: 'Buyer type in a few words, e.g. "Kapitalanleger".' }),
    ),
    priority: Type.Optional(prioritySchema),
    language: Type.Optional(languageSchema),
    notes: Type.Optional(Type.String({ description: "Complete replacement text." })),
    inboundAt: Type.Optional(
      Type.String({ description: "ISO date of the latest email received from the lead." }),
    ),
    outboundAt: Type.Optional(
      Type.String({ description: "ISO date of the latest email sent to the lead." }),
    ),
  },
  catchToText: true,
  execute: async ({ id, inboundAt, outboundAt, ...rest }) => {
    const lead = await updateLead(id, {
      ...rest,
      lastInboundAt: inboundAt,
      lastOutboundAt: outboundAt,
    });
    if (!lead) return textResult(`No lead with id ${id} — check lead_list.`);
    return textResult(`Updated lead:\n${leadLine(lead)}`);
  },
});

const leadDelete: AgentTool = tool({
  name: "lead_delete",
  label: "Delete lead",
  description:
    `Permanently delete a lead AND every automation attached to it. Only when the user ` +
    `explicitly asks — a dead prospect is normally closed with lead_update (status "lost"), ` +
    `which keeps the history.`,
  params: {
    id: Type.String({ description: "The lead id (from lead_list)." }),
  },
  catchToText: true,
  execute: async ({ id }) => {
    const lead = await getLead(id);
    if (!lead) return textResult(`No lead with id ${id} — check lead_list.`);
    await removeLead(id);
    return textResult(`Deleted lead ${lead.email} and its attached automations.`);
  },
});

export const leadTools: AgentTool[] = [leadRecord, leadList, leadUpdate];

/** Interactive-only: deletion cascades over the lead's automations. */
export const leadDeleteTool: AgentTool = leadDelete;
