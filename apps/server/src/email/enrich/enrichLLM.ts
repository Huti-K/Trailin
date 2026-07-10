import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { THREAD_TRIAGES, THREAD_URGENCIES, type ThreadTriage, type ThreadUrgency } from "@trailin/shared";
import { runPrompt } from "../../agent/run.js";
import { env } from "../../env.js";
import { getActiveModelIds, modelRegistry, resolveActiveModel } from "../../llm/registry.js";
import type { EnrichmentResult, ThreadSnapshot } from "./enrichStore.js";

/**
 * The one LLM call of the enrichment pipeline: one thread in, one structured
 * report out, via the report-tool pattern (voiceLearn.ts) — a one-shot
 * ephemeral Agent whose only tool is report_thread_state with terminate:true.
 *
 * Runs on a cheaper model tier than chat/drafting when one is available:
 * this fires for every changed thread in the mailbox, so cost discipline
 * matters more than eloquence. Only same-provider candidates are tried —
 * a different provider would need its own credentials — falling back to the
 * active model otherwise.
 */

/** Cheap-tier candidates tried against the ACTIVE provider, in order. */
const CHEAP_MODEL_CANDIDATES = ["claude-haiku-4-5", "claude-haiku-4-5-20251001"];

export async function resolveEnrichModel(): Promise<Model<Api>> {
  const { provider } = await getActiveModelIds();
  const candidates = env.enrich.model
    ? [env.enrich.model, ...CHEAP_MODEL_CANDIDATES]
    : CHEAP_MODEL_CANDIDATES;
  for (const id of candidates) {
    const model = modelRegistry.getModel(provider, id);
    if (model) return model;
  }
  return resolveActiveModel();
}

const SYSTEM_PROMPT = `You are the triage engine of Trailin, a personal email assistant. You read
ONE email thread from the user's mailbox and report its state by calling the report_thread_state
tool EXACTLY ONCE. Never reply in prose.

Judge from the OWNER's perspective — messages marked [me] were sent by the owner. Write gist,
summary and action items in the language the thread itself is written in.

Triage (who the ball is with):
- needs_reply: the latest substantive message is addressed to the owner and expects an ANSWER
  or decision from them that hasn't been given yet.
- needs_action: the owner owes something beyond a reply — send documents, pay, book, deliver
  on a promise they already made. Applies even when they already answered in words.
- waiting_on: the owner's side is complete; they are waiting on someone else to reply or act.
- fyi: informational — newsletters, notifications, receipts, broadcasts; nobody expects the
  owner to respond.
- done: the exchange is concluded; nothing is expected from anyone.

Urgency (how hot it is): high = explicit deadline soon, someone is blocked, or clearly
time-sensitive; low = can comfortably wait a week or more; normal = everything else.`;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** Coerce whatever the model reported into a valid EnrichmentResult. */
function sanitizeReport(params: Record<string, unknown>): EnrichmentResult {
  const triage = THREAD_TRIAGES.includes(params.triage as ThreadTriage)
    ? (params.triage as ThreadTriage)
    : "fyi";
  const urgency = THREAD_URGENCIES.includes(params.urgency as ThreadUrgency)
    ? (params.urgency as ThreadUrgency)
    : "normal";
  const actionItems = isStringArray(params.action_items)
    ? params.action_items.map((item) => item.trim().slice(0, 200)).filter(Boolean).slice(0, 5)
    : [];
  const deadline = typeof params.deadline === "string" ? params.deadline.trim() : "";
  return {
    gist: typeof params.gist === "string" ? params.gist.trim().slice(0, 300) : "",
    summary: typeof params.summary === "string" ? params.summary.trim().slice(0, 2000) : "",
    actionItems,
    triage,
    urgency,
    ...(deadline ? { deadline } : {}),
  };
}

function buildReportTool(onReport: (result: EnrichmentResult) => void): AgentTool {
  return {
    name: "report_thread_state",
    label: "Report thread state",
    description: "Record the triage report for this thread. Call exactly once.",
    parameters: {
      type: "object",
      properties: {
        gist: {
          type: "string",
          description:
            "ONE sentence, max ~160 characters: what the thread says and what it wants from " +
            "the owner. No lead-in like 'This email...' — go straight to the content.",
        },
        summary: {
          type: "string",
          description:
            "2-4 sentences covering the state of the exchange: who wants what, what has been " +
            "agreed, what is still open.",
        },
        action_items: {
          type: "array",
          items: { type: "string" },
          description:
            "0-5 OPEN action items for the owner, each one short imperative sentence. Empty " +
            "when nothing is expected of them.",
        },
        triage: { type: "string", enum: [...THREAD_TRIAGES] },
        urgency: { type: "string", enum: [...THREAD_URGENCIES] },
        deadline: {
          type: "string",
          description:
            "Only when the thread names one: when this must be answered by, in the sender's " +
            "own terms (\"Friday 17:00\", \"bis Ende der Woche\"). Omit otherwise.",
        },
      },
      required: ["gist", "summary", "action_items", "triage", "urgency"],
    } as AgentTool["parameters"],
    execute: async (_id, params) => {
      onReport(sanitizeReport(params as Record<string, unknown>));
      return {
        content: [{ type: "text", text: "Thread state recorded." }],
        details: undefined,
        terminate: true,
      };
    },
  };
}

/** Newest messages win the budget — the old ones are context, not the point. */
const MAX_MESSAGES = 12;
const MAX_BODY_CHARS = 1200;

function renderSnapshot(snapshot: ThreadSnapshot, accountName: string): string {
  const omitted = snapshot.messages.length - MAX_MESSAGES;
  const shown = omitted > 0 ? snapshot.messages.slice(omitted) : snapshot.messages;
  const lines = shown.map((message) => {
    const body =
      message.bodyText.length > MAX_BODY_CHARS
        ? `${message.bodyText.slice(0, MAX_BODY_CHARS)}…`
        : message.bodyText;
    const marker = message.isFromMe ? " [me]" : "";
    return `From: ${message.from}${marker}\nTo: ${message.to.join(", ")}\nDate: ${message.date}\n\n${body}`;
  });
  return [
    `Owner of this mailbox: ${accountName}`,
    `Today: ${new Date().toISOString().slice(0, 10)}`,
    `Subject: ${snapshot.subject}`,
    omitted > 0 ? `(${omitted} earlier message${omitted === 1 ? "" : "s"} omitted)` : null,
    "",
    lines.join("\n\n---\n\n"),
  ]
    .filter((part): part is string => part !== null)
    .join("\n");
}

/** Enrich one thread. Throws when the model never produced a usable report. */
export async function enrichThread(
  snapshot: ThreadSnapshot,
  accountName: string,
  model: Model<Api>,
): Promise<EnrichmentResult> {
  let captured: EnrichmentResult | undefined;
  const agent = new Agent({
    initialState: {
      systemPrompt: SYSTEM_PROMPT,
      model,
      tools: [buildReportTool((result) => (captured = result))],
    },
    streamFn: (m, c, o) => modelRegistry.streamSimple(m, c, o),
  });
  await runPrompt({ agent }, renderSnapshot(snapshot, accountName));
  if (!captured) throw new Error("model finished without calling report_thread_state");
  return captured;
}
