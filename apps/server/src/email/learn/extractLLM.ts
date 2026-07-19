import type { Api, Model } from "@earendil-works/pi-ai";
import { MEMORY_MAX_LENGTH } from "@trailin/shared";
import { type ReportToolSpec, runReportPrompt } from "../../agent/oneShot.js";
import { prompts } from "../../agent/prompts.js";

export interface ExtractionPair {
  draftBody: string;
  sentBody: string;
}

const reportLessonsTool: ReportToolSpec<string[]> = {
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
  },
  narrow: (params) => {
    const raw = (params as Record<string, unknown>).directives;
    return Array.isArray(raw)
      ? raw
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => entry.trim().slice(0, MEMORY_MAX_LENGTH))
          .filter(Boolean)
      : [];
  },
};

function renderPairs(pairs: ExtractionPair[], accountName: string): string {
  const blocks = pairs.map(
    (pair, index) =>
      `Pair ${index + 1}:\n\nDrafted:\n${pair.draftBody}\n\nActually sent:\n${pair.sentBody}`,
  );
  return [`Account: ${accountName}`, "", blocks.join("\n\n---\n\n")].join("\n");
}

/** Hard cap on one extraction call, so a stuck provider can't wedge the nightly sweep. */
const EXTRACT_TIMEOUT_MS = 60_000;

/** Throws when the model produced no usable report (incl. timeout); the caller leaves the pairs unstamped to retry next night. */
export async function extractLessons(
  pairs: ExtractionPair[],
  accountName: string,
  model: Model<Api>,
  timeoutMs = EXTRACT_TIMEOUT_MS,
): Promise<string[]> {
  return runReportPrompt({
    systemPrompt: prompts.voiceExtract,
    tool: reportLessonsTool,
    prompt: renderPairs(pairs, accountName),
    model,
    timeoutMs,
  });
}
