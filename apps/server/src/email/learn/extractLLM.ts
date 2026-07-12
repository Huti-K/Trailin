import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { MEMORY_MAX_LENGTH } from "@trailin/shared";
import { runPrompt } from "../../agent/run.js";
import { modelRegistry } from "../../llm/registry.js";

/**
 * The nightly extraction LLM call (extractor.ts): one account's pending
 * draft-vs-sent pairs go in, an array of GENERAL style directives comes out
 * via the report-tool pattern (email/enrich/enrichLLM.ts) — a one-shot
 * ephemeral Agent whose only tool is report_lessons with terminate: true.
 * Directives must never repeat content from any one pair (names, dates,
 * deals) — only transferable writing-style adjustments a future draft for
 * this account should follow, the same shape voiceLearn.ts's report_style
 * produces from sent mail alone.
 */

const SYSTEM_PROMPT = `You are a writing-style analyst for Trailin, a personal email assistant. You are shown
several pairs of (what the assistant drafted, what the user actually sent) for ONE account. Compare each
pair and report GENERAL style lessons the assistant should apply next time it drafts for this account —
tone, greeting/sign-off habits, typical length, phrasing preferences. Call report_lessons EXACTLY ONCE.

Never report anything specific to one email's content — no names, dates, numbers, or topics from any pair.
A lesson must read as an instruction that applies to ANY future email for this account, not a fact about
one exchange. If the pairs show no consistent, transferable pattern, report an empty list — do not invent one.`;

export interface ExtractionPair {
  draftBody: string;
  sentBody: string;
}

function buildLessonsReportTool(onReport: (directives: string[]) => void): AgentTool {
  return {
    name: "report_lessons",
    label: "Report style lessons",
    description: "Record the general style directives learned from these pairs. Call exactly once.",
    parameters: {
      type: "object",
      properties: {
        directives: {
          type: "array",
          items: { type: "string" },
          description:
            `0-6 general, content-free style directives (tone, greeting/sign-off habits, length, ` +
            `phrasing), each a single self-contained instruction another assistant could follow, ` +
            `under ${MEMORY_MAX_LENGTH} characters. Empty when no consistent pattern shows up.`,
        },
      },
      required: ["directives"],
    } as AgentTool["parameters"],
    execute: async (_id, params) => {
      const raw = (params as Record<string, unknown>).directives;
      const directives = Array.isArray(raw)
        ? raw
            .filter((entry): entry is string => typeof entry === "string")
            .map((entry) => entry.trim().slice(0, MEMORY_MAX_LENGTH))
            .filter(Boolean)
        : [];
      onReport(directives);
      return {
        content: [{ type: "text", text: "Lessons recorded." }],
        details: undefined,
        terminate: true,
      };
    },
  };
}

function renderPairs(pairs: ExtractionPair[], accountName: string): string {
  const blocks = pairs.map(
    (pair, index) =>
      `Pair ${index + 1}:\n\nDrafted:\n${pair.draftBody}\n\nActually sent:\n${pair.sentBody}`,
  );
  return [`Account: ${accountName}`, "", blocks.join("\n\n---\n\n")].join("\n");
}

/** Hard cap on one extraction call — a stuck provider can't wedge the nightly sweep. */
const EXTRACT_TIMEOUT_MS = 60_000;

/**
 * Extract style lessons from one account's pending pairs. Throws when the
 * model never produced a usable report (including on timeout) — the caller
 * (extractor.ts) leaves the pairs unstamped so they're retried the next
 * night rather than silently losing the comparison.
 */
export async function extractLessons(
  pairs: ExtractionPair[],
  accountName: string,
  model: Model<Api>,
  timeoutMs = EXTRACT_TIMEOUT_MS,
): Promise<string[]> {
  let captured: string[] | undefined;
  const agent = new Agent({
    initialState: {
      systemPrompt: SYSTEM_PROMPT,
      model,
      tools: [buildLessonsReportTool((directives) => (captured = directives))],
    },
    streamFn: (m, c, o) => modelRegistry.streamSimple(m, c, o),
  });
  await runPrompt({ agent }, renderPairs(pairs, accountName), {}, AbortSignal.timeout(timeoutMs));
  if (!captured) throw new Error("model finished without calling report_lessons");
  return captured;
}
