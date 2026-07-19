import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type TProperties, Type } from "@sinclair/typebox";
import { textResult, tool } from "../../agent/toolkit.js";
import type { OnOfficeClient, OnOfficeResponse } from "./client.js";
import { resultsOf } from "./client.js";
import { getOnOfficeClient } from "./config.js";

/**
 * The onOffice CRM tool surface as Trailin AgentTools, run in-process against
 * onoffice/client.ts. Read tools stay available to unattended runs. Create
 * tools (additive records) can be opted into for unattended runs on the onOffice
 * row in Settings; modify/delete/send is interactive-only and armed by its own
 * toggle. Unattended runs never get write access: they read attacker-controllable
 * mail with no human to review a CRM write, the same gating the email write
 * tools get in agent/emailToolset.ts.
 */

const resourceIdSchema = Type.Union([Type.String(), Type.Number()]);

const filterSchema = Type.Record(
  Type.String(),
  Type.Array(
    Type.Object({
      op: Type.String({ description: "Operator: =, !=, >, <, >=, <=, between, like, in, etc." }),
      val: Type.Any({ description: "Value, or [from, to] array for 'between'." }),
    }),
  ),
  { description: 'Field-keyed filter, e.g. {"kaufpreis":[{"op":"<","val":300000}]}.' },
);

const readParams = {
  data: Type.Optional(Type.Array(Type.String(), { description: "Field names to return." })),
  filter: Type.Optional(filterSchema),
  filterid: Type.Optional(Type.Integer({ description: "ID of a pre-created enterprise filter." })),
  resourceid: Type.Optional(
    Type.Union([Type.String(), Type.Number()], {
      description: "Single record ID (overrides filter).",
    }),
  ),
  listlimit: Type.Optional(Type.Integer({ description: "Max records (default 20, max 500)." })),
  listoffset: Type.Optional(Type.Integer({ description: "Pagination offset." })),
  sortby: Type.Optional(
    Type.Record(Type.String(), Type.Union([Type.Literal("ASC"), Type.Literal("DESC")]), {
      description: 'e.g. {"kaufpreis":"ASC"}.',
    }),
  ),
  formatoutput: Type.Optional(Type.Boolean({ description: "Return formatted values with units." })),
  extra: Type.Optional(
    Type.Record(Type.String(), Type.Any(), { description: "Any additional read parameters." }),
  ),
} satisfies TProperties;

interface ReadRest {
  data?: string[];
  filter?: Record<string, unknown>;
  filterid?: number;
  listlimit?: number;
  listoffset?: number;
  sortby?: Record<string, "ASC" | "DESC">;
  formatoutput?: boolean;
  extra?: Record<string, unknown>;
}

function buildReadParameters(p: ReadRest): Record<string, unknown> {
  const params: Record<string, unknown> = { ...(p.extra ?? {}) };
  if (p.data) params.data = p.data;
  if (p.filter) params.filter = p.filter;
  if (p.filterid !== undefined) params.filterid = p.filterid;
  if (p.listlimit !== undefined) params.listlimit = p.listlimit;
  if (p.listoffset !== undefined) params.listoffset = p.listoffset;
  if (p.sortby) params.sortby = p.sortby;
  if (p.formatoutput !== undefined) params.formatoutput = p.formatoutput;
  return params;
}

const OK_TEXT_MAX_CHARS = 40_000;

function okText(resp: OnOfficeResponse): string {
  const results = resultsOf(resp);
  const json = JSON.stringify(results.length > 0 ? results : resp);
  if (json.length <= OK_TEXT_MAX_CHARS) return json;
  return (
    `${json.slice(0, OK_TEXT_MAX_CHARS)}\n\n` +
    `[Output truncated at ${OK_TEXT_MAX_CHARS} characters. Narrow the query and retry — ` +
    `lower listlimit, request fewer fields via the data parameter, or use a tighter filter.]`
  );
}

const READ_MODULES = [
  {
    name: "onoffice_read_addresses",
    resourcetype: "address",
    label: "Read addresses (leads/contacts)",
    description: "Read address records (contacts/leads) with filtering, sorting and pagination.",
  },
  {
    name: "onoffice_read_estates",
    resourcetype: "estate",
    label: "Read estates (properties)",
    description: "Read estate/property records with filtering, sorting and pagination.",
  },
  {
    name: "onoffice_read_appointments",
    resourcetype: "appointment",
    label: "Read appointments",
    description: "Read calendar appointment records with filtering, sorting and pagination.",
  },
  {
    name: "onoffice_read_tasks",
    resourcetype: "task",
    label: "Read tasks",
    description: "Read task records with filtering, sorting and pagination.",
  },
] as const;

const CREATE_MODULES = [
  {
    name: "onoffice_create_appointment",
    resourcetype: "appointment",
    label: "Create appointment",
    description:
      "Create a calendar appointment. Provide appointment fields (e.g. date, time, type, user).",
  },
  {
    name: "onoffice_create_task",
    resourcetype: "task",
    label: "Create task",
    description: "Create a task. Provide task fields (e.g. subject, responsibility, status).",
  },
  {
    name: "onoffice_create_agentslog",
    resourcetype: "agentslog",
    label: "Create agents-log entry",
    description:
      "Log an activity in the agents log (Maklerbuch), e.g. an email sent to a lead or a " +
      "follow-up step. Common fields: datetime, addressids (array), estateid, actionkind, " +
      "actiontype, note. With addressids and estateid set, the entry also appears under the " +
      "address's and estate's 'Offered till now' tabs.",
  },
] as const;

/** The read/get surface, safe for unattended runs. */
function buildReadTools(client: OnOfficeClient): AgentTool[] {
  return [
    tool({
      name: "onoffice_read",
      label: "Read records",
      description:
        "Read records of any onOffice module (resourcetype) with filtering, sorting and " +
        "pagination. Common resourcetypes: estate, address, searchcriteria, appointment, task, " +
        "relation, file, user.",
      catchToText: true,
      params: {
        resourcetype: Type.String({
          description: 'Module, e.g. "estate", "address", "appointment", "task".',
        }),
        ...readParams,
      },
      execute: async ({ resourcetype, resourceid, ...rest }, ctx) =>
        textResult(
          okText(
            await client.action(
              "read",
              resourcetype,
              { resourceid, parameters: buildReadParameters(rest) },
              ctx.signal,
            ),
          ),
        ),
    }),
    tool({
      name: "onoffice_get",
      label: "Request information (get)",
      description:
        "Run a 'get' action to query system data and configuration: search, fields, filters, " +
        "regions, users, groups, relations, email links, etc.",
      catchToText: true,
      params: {
        resourcetype: Type.String({
          description: 'e.g. "search", "fields", "filter", "regions", "users", "idsfromrelation".',
        }),
        resourceid: Type.Optional(resourceIdSchema),
        parameters: Type.Optional(
          Type.Record(Type.String(), Type.Any(), { description: "Action parameters." }),
        ),
      },
      execute: async ({ resourcetype, resourceid, parameters }, ctx) =>
        textResult(
          okText(
            await client.action(
              "get",
              resourcetype,
              { resourceid, parameters: parameters ?? {} },
              ctx.signal,
            ),
          ),
        ),
    }),
    tool({
      name: "onoffice_search",
      label: "Quicksearch",
      description: "Quicksearch across addresses, estates, or search criteria by free-text input.",
      catchToText: true,
      params: {
        type: Type.Union(
          [Type.Literal("address"), Type.Literal("estate"), Type.Literal("searchcriteria")],
          { description: "What to search." },
        ),
        input: Type.String({ description: "Search term, e.g. a name, email, or estate number." }),
      },
      execute: async ({ type, input }, ctx) =>
        textResult(
          okText(
            await client.action(
              "get",
              "search",
              { resourceid: type, parameters: { input } },
              ctx.signal,
            ),
          ),
        ),
    }),
    tool({
      name: "onoffice_get_fields",
      label: "Get field configuration",
      description:
        "Retrieve the field configuration (available fields, types, labels, select values) for " +
        "one or more modules. Use this to discover valid field names before reading/creating records.",
      catchToText: true,
      params: {
        modules: Type.Array(Type.String(), { description: 'Modules, e.g. ["estate","address"].' }),
        labels: Type.Optional(Type.Boolean({ description: "Include human-readable labels." })),
        language: Type.Optional(Type.String({ description: "Language code, e.g. ENG, GER." })),
      },
      execute: async ({ modules, labels, language }, ctx) => {
        const parameters: Record<string, unknown> = { modules };
        if (labels !== undefined) parameters.labels = labels;
        if (language) parameters.language = language;
        return textResult(okText(await client.action("get", "fields", { parameters }, ctx.signal)));
      },
    }),
    ...READ_MODULES.map((mod) =>
      tool({
        name: mod.name,
        label: mod.label,
        description: mod.description,
        catchToText: true,
        params: { ...readParams },
        execute: async ({ resourceid, ...rest }, ctx) =>
          textResult(
            okText(
              await client.action(
                "read",
                mod.resourcetype,
                { resourceid, parameters: buildReadParameters(rest) },
                ctx.signal,
              ),
            ),
          ),
      }),
    ),
  ];
}

/** The additive surface (create-only). Unattended runs get these only when
 *  armed on the onOffice row in Settings. */
function buildCreateTools(client: OnOfficeClient): AgentTool[] {
  return [
    tool({
      name: "onoffice_create_address",
      label: "Create address (lead/contact)",
      description:
        "Create a new contact/lead. Common fields: Anrede, Vorname, Name, email, phone, mobile, " +
        "Plz, Ort, Strasse, Land, Benutzer (responsible user), newsletter_aktiv. Set " +
        "checkDuplicate to avoid duplicates.",
      catchToText: true,
      params: {
        fields: Type.Record(Type.String(), Type.Any(), { description: "Address field values." }),
        checkDuplicate: Type.Optional(
          Type.Boolean({ description: "If true, deduplicate against existing addresses." }),
        ),
      },
      execute: async ({ fields, checkDuplicate }, ctx) => {
        const parameters = {
          ...fields,
          ...(checkDuplicate !== undefined ? { checkDuplicate } : {}),
        };
        return textResult(
          okText(await client.action("create", "address", { parameters }, ctx.signal)),
        );
      },
    }),
    tool({
      name: "onoffice_create_relation",
      label: "Create relation",
      description:
        "Link two records (e.g. an address to an appointment or estate). Provide the relationtype " +
        "URN plus parentid and childid.",
      catchToText: true,
      params: {
        relationtype: Type.String({
          description:
            "Relation type URN, e.g. urn:onoffice-de-ns:smart:2.5:relationTypes:estate:address:buyer.",
        }),
        parentid: resourceIdSchema,
        childid: resourceIdSchema,
      },
      execute: async ({ relationtype, parentid, childid }, ctx) =>
        textResult(
          okText(
            await client.action(
              "create",
              "relation",
              { parameters: { relationtype, parentid, childid } },
              ctx.signal,
            ),
          ),
        ),
    }),
    ...CREATE_MODULES.map((mod) =>
      tool({
        name: mod.name,
        label: mod.label,
        description: mod.description,
        catchToText: true,
        params: {
          fields: Type.Record(Type.String(), Type.Any(), {
            description: "Field values for the new record.",
          }),
        },
        execute: async ({ fields }, ctx) =>
          textResult(
            okText(
              await client.action("create", mod.resourcetype, { parameters: fields }, ctx.signal),
            ),
          ),
      }),
    ),
  ];
}

/** The destructive/sending surface: interactive sessions only, unconditionally. */
function buildWriteTools(client: OnOfficeClient): AgentTool[] {
  return [
    tool({
      name: "onoffice_create",
      label: "Create record",
      description: "Create a record in any module. Returns the new record ID.",
      catchToText: true,
      params: {
        resourcetype: Type.String({
          description: 'Module, e.g. "address", "estate", "appointment", "task".',
        }),
        parameters: Type.Record(Type.String(), Type.Any(), {
          description: "Field values for the new record.",
        }),
      },
      execute: async ({ resourcetype, parameters }, ctx) =>
        textResult(okText(await client.action("create", resourcetype, { parameters }, ctx.signal))),
    }),
    tool({
      name: "onoffice_modify",
      label: "Modify record",
      description:
        "Modify an existing record by ID in any module. DESTRUCTIVE: this overwrites live CRM " +
        "data and cannot be undone. Show the user exactly which record and fields you intend to " +
        "change and get explicit confirmation before calling.",
      catchToText: true,
      params: {
        resourcetype: Type.String({ description: "Module of the record." }),
        resourceid: Type.Union([Type.String(), Type.Number()], {
          description: "ID of the record to modify.",
        }),
        parameters: Type.Record(Type.String(), Type.Any(), {
          description: "Field values to update.",
        }),
      },
      execute: async ({ resourcetype, resourceid, parameters }, ctx) =>
        textResult(
          okText(
            await client.action("modify", resourcetype, { resourceid, parameters }, ctx.signal),
          ),
        ),
    }),
    tool({
      name: "onoffice_delete",
      label: "Delete record",
      description:
        "Delete a record. For relations, pass relationtype/parentid/childid in parameters " +
        "instead of resourceid. DESTRUCTIVE and irreversible: this permanently removes data from " +
        "the live CRM. Always describe the exact record(s) to the user and obtain explicit " +
        "confirmation before calling. Never delete speculatively.",
      catchToText: true,
      params: {
        resourcetype: Type.String({ description: "Module of the record." }),
        resourceid: Type.Optional(
          Type.Union([Type.String(), Type.Number()], {
            description: "ID of the record to delete.",
          }),
        ),
        parameters: Type.Optional(
          Type.Record(Type.String(), Type.Any(), {
            description: "Extra parameters (e.g. relation fields).",
          }),
        ),
      },
      execute: async ({ resourcetype, resourceid, parameters }, ctx) =>
        textResult(
          okText(
            await client.action(
              "delete",
              resourcetype,
              { resourceid, parameters: parameters ?? {} },
              ctx.signal,
            ),
          ),
        ),
    }),
    tool({
      name: "onoffice_do",
      label: "Perform action (do)",
      description:
        "Run a 'do' action to perform operations: sendmail, file upload, PDF expose generation, " +
        "execute webhooks, newsletter registration, appointment confirmation, etc. CAUTION: many " +
        "'do' actions have real-world side effects (sending email to clients, triggering webhooks) " +
        "that cannot be undone. Confirm the action and its parameters with the user before calling " +
        "anything with an external effect.",
      catchToText: true,
      params: {
        resourcetype: Type.String({ description: 'e.g. "sendmail", "uploadfile", "pdf".' }),
        resourceid: Type.Optional(resourceIdSchema),
        parameters: Type.Optional(
          Type.Record(Type.String(), Type.Any(), { description: "Action parameters." }),
        ),
      },
      execute: async ({ resourcetype, resourceid, parameters }, ctx) =>
        textResult(
          okText(
            await client.action(
              "do",
              resourcetype,
              { resourceid, parameters: parameters ?? {} },
              ctx.signal,
            ),
          ),
        ),
    }),
    tool({
      name: "onoffice_raw_request",
      label: "Raw request (escape hatch)",
      description:
        "Send one or more fully-custom actions in a single signed request. Use for batch " +
        "operations or any endpoint not covered by other tools. actionid accepts a shorthand " +
        "(read/create/modify/delete/get/do) or a full URN. CAUTION: this can perform " +
        "modify/delete/do actions with no extra guardrails. If the batch contains any modify, " +
        "delete, or do action, confirm with the user before calling.",
      catchToText: true,
      params: {
        actions: Type.Array(
          Type.Object({
            actionid: Type.String({
              description: "Shorthand (read/create/modify/delete/get/do) or full URN.",
            }),
            resourcetype: Type.String(),
            resourceid: Type.Optional(resourceIdSchema),
            identifier: Type.Optional(Type.String()),
            parameters: Type.Optional(Type.Record(Type.String(), Type.Any())),
          }),
          { minItems: 1 },
        ),
      },
      execute: async ({ actions }, ctx) =>
        textResult(okText(await client.call(actions, ctx.signal))),
    }),
    tool({
      name: "onoffice_send_email",
      label: "Send email",
      description:
        "Send an email via onOffice (resourcetype sendmail). Provide either body or templateid. " +
        "Receivers may be email addresses or address record IDs. CAUTION: this sends a real email " +
        "to real recipients and cannot be recalled. Show the user the recipients, subject, and " +
        "body and get explicit confirmation before calling.",
      catchToText: true,
      params: {
        emailidentity: Type.String({
          description: "Sender identity (configured onOffice email identity).",
        }),
        receiver: Type.Array(resourceIdSchema, {
          description: "Recipient emails or address IDs.",
        }),
        subject: Type.Optional(Type.String()),
        body: Type.Optional(Type.String({ description: "Email body (use with useHtml)." })),
        templateid: Type.Optional(
          Type.Integer({ description: "Email template ID (alternative to body)." }),
        ),
        cc: Type.Optional(Type.Array(resourceIdSchema)),
        bcc: Type.Optional(Type.Array(resourceIdSchema)),
        useHtml: Type.Optional(Type.Boolean()),
        estateids: Type.Optional(Type.Array(resourceIdSchema)),
        handleReceiversSeparately: Type.Optional(
          Type.Boolean({ description: "Send a personalized email per recipient." }),
        ),
        extra: Type.Optional(
          Type.Record(Type.String(), Type.Any(), {
            description: "Any additional sendmail parameters.",
          }),
        ),
      },
      execute: async ({ extra, ...rest }, ctx) => {
        const parameters: Record<string, unknown> = { ...(extra ?? {}) };
        for (const [k, v] of Object.entries(rest)) if (v !== undefined) parameters[k] = v;
        return textResult(
          okText(await client.action("do", "sendmail", { parameters }, ctx.signal)),
        );
      },
    }),
  ];
}

export interface LoadOnOfficeToolsOptions {
  /**
   * Whether the full mutating surface (create, modify/delete, send, raw
   * batches) is exposed. Defaults to true; false for unattended runs, where a
   * prompt-injected email can't change or send from the CRM, and for chat
   * until the user armed CRM write access in Settings. Implies the create tools.
   */
  allowWrites?: boolean;
  /**
   * Whether the additive create tools are exposed on their own. Set for
   * unattended runs once the user armed it in Settings.
   */
  allowCreates?: boolean;
}

/**
 * The agent's onOffice tools, or empty when no credentials are configured. One
 * client is resolved per call and closed over by every tool; saving new
 * credentials rebuilds live sessions, so no long-lived client holds stale ones.
 */
export async function loadOnOfficeTools(
  options: LoadOnOfficeToolsOptions = {},
): Promise<AgentTool[]> {
  const client = await getOnOfficeClient();
  if (!client) return [];
  const allowWrites = options.allowWrites ?? true;
  const tools = buildReadTools(client);
  if (allowWrites || options.allowCreates) tools.push(...buildCreateTools(client));
  if (allowWrites) tools.push(...buildWriteTools(client));
  return tools;
}
