import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  CONTACT_CATEGORIES,
  CONTACT_KINDS,
  type ContactCategory,
  type ContactKind,
} from "@trailin/shared";
import { runPrompt } from "../../agent/run.js";
import { env } from "../../env.js";
import { getActiveModelIds, modelRegistry, resolveActiveModel } from "../../llm/registry.js";
import type { ContactJudgment, ContactSample } from "./contactsEnrichStore.js";

/**
 * The one LLM call of the contacts pipeline (mirrors email/enrich/enrichLLM.ts's
 * thread-triage call): one address's recent message sample in, one
 * structured judgment out, via a terminating report tool on a one-shot
 * ephemeral Agent. Runs on the same cheap-tier model search as thread
 * enrichment — this fires for every changed contact, so cost discipline
 * matters more than eloquence.
 */

const CHEAP_MODEL_CANDIDATES = ["claude-haiku-4-5", "claude-haiku-4-5-20251001"];

export async function resolveContactsModel(): Promise<Model<Api>> {
  const { provider } = await getActiveModelIds();
  const candidates = env.contacts.model
    ? [env.contacts.model, ...CHEAP_MODEL_CANDIDATES]
    : CHEAP_MODEL_CANDIDATES;
  for (const id of candidates) {
    const model = modelRegistry.getModel(provider, id);
    if (model) return model;
  }
  return resolveActiveModel();
}

const SYSTEM_PROMPT = `You are the contacts engine of Trailin, a personal email assistant. You read a
sample of recent messages between the owner and ONE email address and report your judgment by
calling the report_contact tool EXACTLY ONCE. Never reply in prose.

kind: "person" when this is a real correspondent — an individual or a specific business contact
the owner exchanges mail with. "bulk" when the address is a newsletter, notification, receipt, or
no-reply sender nobody replies to. Your judgment is authoritative, not a regex: an address that
doesn't look like "no-reply@..." can still be bulk (a marketing list sent from a normal-looking
address), and one that does can still be a person (a small business that only has a no-reply-looking
address but genuinely corresponds one-to-one). A List-Unsubscribe header is a hint the message is
bulk mail, not proof by itself. An address the owner has personally sent mail TO is almost always a
person — treat that as strong evidence, and only call it bulk if the sent messages are themselves
clearly auto-generated.

category: only meaningful when kind is "person" — pick the closest of colleague, client_business,
personal, service_vendor, other. For kind "bulk", still pick a value (other, unless the content
clearly says otherwise).

gist: ONE line, e.g. "your accountant; handles the quarterly filings; formal tone" — who they are
and, when it's distinctive, the tone. Write it in the language the messages are written in. Never
leave it empty — write a short best guess even for a thin sample.`;

function buildReportTool(onReport: (result: ContactJudgment) => void): AgentTool {
  return {
    name: "report_contact",
    label: "Report contact judgment",
    description: "Record the judgment for this address. Call exactly once.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: [...CONTACT_KINDS] },
        category: { type: "string", enum: [...CONTACT_CATEGORIES] },
        gist: {
          type: "string",
          description:
            'ONE line: who this is / the relationship, e.g. "your accountant; handles the ' +
            'quarterly filings; formal tone". Never empty.',
        },
      },
      required: ["kind", "category", "gist"],
    } as AgentTool["parameters"],
    execute: async (_id, params) => {
      onReport(sanitizeReport(params as Record<string, unknown>));
      return {
        content: [{ type: "text", text: "Contact judgment recorded." }],
        details: undefined,
        terminate: true,
      };
    },
  };
}

/** Coerce whatever the model reported into a valid ContactJudgment. */
function sanitizeReport(params: Record<string, unknown>): ContactJudgment {
  const kind = (CONTACT_KINDS as readonly string[]).includes(params.kind as string)
    ? (params.kind as ContactKind)
    : "person";
  const category = (CONTACT_CATEGORIES as readonly string[]).includes(params.category as string)
    ? (params.category as ContactCategory)
    : "other";
  const gist = typeof params.gist === "string" ? params.gist.trim().slice(0, 300) : "";
  return { kind, category, gist };
}

const MAX_SNIPPET_CHARS = 300;

function renderSample(sample: ContactSample): string {
  const lines = sample.messages.map((message) => {
    const marker = message.isFromMe ? " [me → them]" : " [them → me]";
    const unsubscribe = message.hasListUnsubscribe ? " (List-Unsubscribe present)" : "";
    const snippet =
      message.snippet.length > MAX_SNIPPET_CHARS
        ? `${message.snippet.slice(0, MAX_SNIPPET_CHARS)}…`
        : message.snippet;
    return `${message.date}${marker}${unsubscribe}\nSubject: ${message.subject}\n${snippet}`;
  });
  return [
    `Address: ${sample.address}`,
    `Display name seen on their mail: ${sample.displayName || "(none)"}`,
    `The owner has personally sent this address mail: ${sample.hasSentTo ? "yes" : "no"}`,
    `Today: ${new Date().toISOString().slice(0, 10)}`,
    "",
    lines.join("\n\n---\n\n"),
  ].join("\n");
}

/** Hard cap on one contact's model call — a stuck provider can't wedge the whole batch. */
const JUDGE_TIMEOUT_MS = 60_000;

/**
 * Judge one contact. Throws when the model never produced a usable report,
 * including on timeout — the caller (contactsService.ts) routes any
 * rejection through saveContactError, so a timeout lands there like any
 * other failed attempt rather than crashing the batch.
 */
export async function judgeContact(
  sample: ContactSample,
  model: Model<Api>,
  timeoutMs = JUDGE_TIMEOUT_MS,
): Promise<ContactJudgment> {
  let captured: ContactJudgment | undefined;
  const agent = new Agent({
    initialState: {
      systemPrompt: SYSTEM_PROMPT,
      model,
      tools: [buildReportTool((result) => (captured = result))],
    },
    streamFn: (m, c, o) => modelRegistry.streamSimple(m, c, o),
  });
  await runPrompt({ agent }, renderSample(sample), {}, AbortSignal.timeout(timeoutMs));
  if (!captured) throw new Error("model finished without calling report_contact");
  return captured;
}
