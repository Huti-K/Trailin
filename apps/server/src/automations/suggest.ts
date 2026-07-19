import type { Api, Model } from "@earendil-works/pi-ai";
import { and, desc, eq, gte } from "drizzle-orm";
import { resolveCheapModel } from "../agent/llm/registry.js";
import { type ReportToolSpec, runReportPrompt } from "../agent/oneShot.js";
import { prompts } from "../agent/prompts.js";
import { moduleLogger } from "../core/logger.js";
import { NightlyJob } from "../core/utils/jobs.js";
import {
  createSuggestion,
  listAllSuggestions,
  listPendingSuggestions,
} from "../db/automationSuggestions.js";
import { db, schema } from "../db/index.js";
import { getSetting, getTimezoneSetting, setSetting } from "../db/settings.js";
import { isValidCron } from "./scheduler.js";

const log = moduleLogger("suggest");

export interface SuggestedAutomation {
  name: string;
  instruction: string;
  schedule: string;
  rationale: string;
}

const MAX_SUGGESTIONS = 3;

function asSuggestion(entry: unknown): SuggestedAutomation | null {
  if (typeof entry !== "object" || entry === null) return null;
  const { name, instruction, schedule, rationale } = entry as Record<string, unknown>;
  if (
    typeof name !== "string" ||
    typeof instruction !== "string" ||
    typeof schedule !== "string" ||
    typeof rationale !== "string"
  ) {
    return null;
  }
  const trimmed = {
    name: name.trim(),
    instruction: instruction.trim(),
    schedule: schedule.trim(),
    rationale: rationale.trim(),
  };
  if (!trimmed.name || !trimmed.instruction || !trimmed.schedule || !trimmed.rationale) return null;
  return trimmed;
}

const reportSuggestionsTool: ReportToolSpec<SuggestedAutomation[]> = {
  name: "report_suggestions",
  label: "Report automation suggestions",
  description: "Record the proposed automations. Call exactly once.",
  parameters: {
    type: "object",
    properties: {
      suggestions: {
        type: "array",
        description: `0-${MAX_SUGGESTIONS} proposed automations. Empty when no request pattern recurs.`,
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Short display name for the automation." },
            instruction: {
              type: "string",
              description: "Complete, self-contained instruction the unattended run will execute.",
            },
            schedule: {
              type: "string",
              description: "Five-field cron expression in the user's timezone.",
            },
            rationale: {
              type: "string",
              description: "One or two sentences to the user naming the recurring pattern seen.",
            },
          },
          required: ["name", "instruction", "schedule", "rationale"],
        },
      },
    },
    required: ["suggestions"],
  },
  narrow: (params) => {
    const raw = (params as Record<string, unknown>).suggestions;
    return Array.isArray(raw)
      ? raw
          .map(asSuggestion)
          .filter((entry): entry is SuggestedAutomation => entry !== null)
          .slice(0, MAX_SUGGESTIONS)
      : [];
  },
};

/** Hard cap so a stuck provider can't wedge the nightly sweep. */
const SUGGEST_TIMEOUT_MS = 90_000;

/**
 * Throws when the model produced no usable report (including on timeout); the
 * caller then leaves the sweep unstamped so it retries rather than skipping.
 */
async function proposeAutomations(
  prompt: string,
  model: Model<Api>,
  timeoutMs = SUGGEST_TIMEOUT_MS,
): Promise<SuggestedAutomation[]> {
  return runReportPrompt({
    systemPrompt: prompts.automationSuggest,
    tool: reportSuggestionsTool,
    prompt,
    model,
    timeoutMs,
  });
}

const NIGHTLY_CRON = "30 3 * * *"; // offset from the 03:00 learning sweep
const LAST_SWEEP_KEY = "automations.suggestLastSweepAt";
const MIN_SWEEP_GAP_MS = 20 * 60 * 60 * 1000;

const WINDOW_DAYS = 14;
const MAX_MESSAGES = 300;
const MESSAGE_CHARS = 400;
/** Fewer requests than this can't hold a ≥3-ask pattern worth an LLM call. */
const MIN_MESSAGES = 6;
const MAX_PENDING = 3;

export interface SuggestSweepDeps {
  propose?: (prompt: string) => Promise<SuggestedAutomation[]>;
}

export interface SuggestSweepResult {
  ran: boolean;
  skipped?: "recent-sweep" | "pending-full";
  proposed: number;
  stored: number;
}

async function defaultPropose(prompt: string): Promise<SuggestedAutomation[]> {
  const model = await resolveCheapModel();
  return proposeAutomations(prompt, model);
}

interface UserMessage {
  content: string;
  createdAt: string;
}

async function recentUserMessages(): Promise<UserMessage[]> {
  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const rows = await db
    .select({ content: schema.messages.content, createdAt: schema.messages.createdAt })
    .from(schema.messages)
    .innerJoin(schema.conversations, eq(schema.conversations.id, schema.messages.conversationId))
    .where(
      and(
        eq(schema.conversations.type, "chat"),
        eq(schema.messages.role, "user"),
        gte(schema.messages.createdAt, since),
      ),
    )
    .orderBy(desc(schema.messages.createdAt))
    .limit(MAX_MESSAGES);
  return rows.reverse();
}

function timestampLabel(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}

function truncate(text: string, max: number): string {
  const collapsed = text.trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

async function renderPrompt(messages: UserMessage[], timezone: string): Promise<string> {
  const automations = await db.select().from(schema.automations);
  const automationLines =
    automations.length > 0
      ? automations
          .map((a) => `- "${a.name}" — ${a.schedule} — ${truncate(a.instruction, 200)}`)
          .join("\n")
      : "(none)";

  const prior = await listAllSuggestions();
  const priorLines =
    prior.length > 0
      ? prior.map((s) => `- [${s.status}] "${s.name}" — ${truncate(s.rationale, 200)}`).join("\n")
      : "(none)";

  const messageLines = messages
    .map((m) => `[${timestampLabel(m.createdAt, timezone)}] ${truncate(m.content, MESSAGE_CHARS)}`)
    .join("\n");

  return [
    `The user's timezone: ${timezone}.`,
    "",
    "Existing automations:",
    automationLines,
    "",
    "Suggestions already made (never repeat these, whatever their status):",
    priorLines,
    "",
    `The user's requests to the assistant over the last ${WINDOW_DAYS} days, oldest first:`,
    messageLines,
  ].join("\n");
}

/**
 * One sweep. Throws when the model call fails (the caller leaves LAST_SWEEP_KEY
 * unstamped so it retries); every completed sweep stamps the timestamp.
 */
export async function runSuggestSweep(deps: SuggestSweepDeps = {}): Promise<SuggestSweepResult> {
  const lastAt = await getSetting(LAST_SWEEP_KEY);
  if (lastAt && Date.now() - Date.parse(lastAt) < MIN_SWEEP_GAP_MS) {
    return { ran: false, skipped: "recent-sweep", proposed: 0, stored: 0 };
  }
  const pending = await listPendingSuggestions();
  if (pending.length >= MAX_PENDING) {
    return { ran: false, skipped: "pending-full", proposed: 0, stored: 0 };
  }

  const messages = await recentUserMessages();
  if (messages.length < MIN_MESSAGES) {
    await setSetting(LAST_SWEEP_KEY, new Date().toISOString());
    return { ran: true, proposed: 0, stored: 0 };
  }

  const timezone = (await getTimezoneSetting()) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const prompt = await renderPrompt(messages, timezone);
  const proposals = await (deps.propose ?? defaultPropose)(prompt);

  // Dedup by normalized name against everything the user has or already
  // answered: the prompt forbids repeats, but the store enforces it.
  const automations = await db.select({ name: schema.automations.name }).from(schema.automations);
  const taken = new Set(
    [...automations.map((a) => a.name), ...(await listAllSuggestions()).map((s) => s.name)].map(
      (name) => name.trim().toLowerCase(),
    ),
  );

  let stored = 0;
  for (const proposal of proposals) {
    if (pending.length + stored >= MAX_PENDING) break;
    if (!isValidCron(proposal.schedule)) {
      log.warn({ schedule: proposal.schedule }, "suggestion dropped — invalid cron");
      continue;
    }
    if (taken.has(proposal.name.trim().toLowerCase())) continue;
    await createSuggestion(proposal);
    taken.add(proposal.name.trim().toLowerCase());
    stored++;
  }

  await setSetting(LAST_SWEEP_KEY, new Date().toISOString());
  if (stored > 0) log.info({ proposed: proposals.length, stored }, "automation suggestions stored");
  return { ran: true, proposed: proposals.length, stored };
}

const nightly = new NightlyJob({
  name: "suggest",
  cron: NIGHTLY_CRON,
  run: async () => {
    await runSuggestSweep();
  },
});

export async function startNightlySuggest(): Promise<void> {
  nightly.start((await getTimezoneSetting()) ?? undefined);
}

export async function rescheduleNightlySuggest(): Promise<void> {
  nightly.reschedule((await getTimezoneSetting()) ?? undefined);
}

export function stopNightlySuggest(): void {
  nightly.stop();
}
