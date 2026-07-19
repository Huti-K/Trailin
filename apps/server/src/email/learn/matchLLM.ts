import type { Api, Model } from "@earendil-works/pi-ai";
import { type ReportToolSpec, runReportPrompt } from "../../agent/oneShot.js";
import { prompts } from "../../agent/prompts.js";

export interface TiebreakCandidate {
  providerMessageId: string;
  body: string;
}

const reportMatchTool: ReportToolSpec<string | null> = {
  name: "report_match",
  label: "Report matched candidate",
  description: "Record which candidate (if any) is the draft as sent. Call exactly once.",
  parameters: {
    type: "object",
    properties: {
      matched_message_id: {
        type: "string",
        description:
          'The matching candidate\'s id, copied exactly, or the literal string "none" when no ' +
          "candidate is confidently the same email as the draft.",
      },
    },
    required: ["matched_message_id"],
  },
  narrow: (params) => {
    const raw = (params as Record<string, unknown>).matched_message_id;
    const matchedId = typeof raw === "string" && raw.trim() !== "none" ? raw.trim() : null;
    return matchedId || null;
  },
};

function renderPrompt(draftBody: string, candidates: TiebreakCandidate[]): string {
  const candidateBlocks = candidates.map(
    (candidate) => `Candidate id: ${candidate.providerMessageId}\n\n${candidate.body}`,
  );
  return [
    "Draft (latest version):",
    "",
    draftBody,
    "",
    "Candidates:",
    "",
    candidateBlocks.join("\n\n---\n\n"),
  ].join("\n");
}

/** Hard cap on one tiebreak call, so a stuck provider can't wedge the matcher's sweep. */
const TIEBREAK_TIMEOUT_MS = 60_000;

/** Throws when the model produced no usable report (incl. timeout); callers treat any rejection as "none" and leave the draft open. */
export async function resolveTiebreak(
  draftBody: string,
  candidates: TiebreakCandidate[],
  model: Model<Api>,
  timeoutMs = TIEBREAK_TIMEOUT_MS,
): Promise<string | null> {
  return runReportPrompt({
    systemPrompt: prompts.voiceMatch,
    tool: reportMatchTool,
    prompt: renderPrompt(draftBody, candidates),
    model,
    timeoutMs,
  });
}
