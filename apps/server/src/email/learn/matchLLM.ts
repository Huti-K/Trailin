import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { runPrompt } from "../../agent/run.js";
import { modelRegistry } from "../../llm/registry.js";

/**
 * The tiebreak LLM call for ambiguous standalone-draft matches (matcher.ts):
 * more than one sent message shares the draft's recipients and subject, so
 * the model reads the draft's latest body against each candidate's body and
 * reports which one (if any) is confidently the same email, via the
 * report-tool pattern (email/enrich/enrichLLM.ts) — a one-shot ephemeral
 * Agent whose only tool is report_match with terminate: true.
 */

const SYSTEM_PROMPT = `You are comparing ONE drafted email against several candidate sent emails to find which
candidate IS that draft, actually sent (possibly lightly edited by the user before sending). Call
report_match EXACTLY ONCE with the id of the one matching candidate, or the literal string "none" if you
are not confident any candidate is the same email. A different email to the same people on the same
subject does not count as a match — you need the same message, not just the same conversation.`;

export interface TiebreakCandidate {
  providerMessageId: string;
  body: string;
}

function buildMatchReportTool(onReport: (matchedId: string | null) => void): AgentTool {
  return {
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
    } as AgentTool["parameters"],
    execute: async (_id, params) => {
      const raw = (params as Record<string, unknown>).matched_message_id;
      const matchedId = typeof raw === "string" && raw.trim() !== "none" ? raw.trim() : null;
      onReport(matchedId || null);
      return {
        content: [{ type: "text", text: "Match recorded." }],
        details: undefined,
        terminate: true,
      };
    },
  };
}

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

/** Hard cap on one tiebreak call — a stuck provider can't wedge the matcher's sweep. */
const TIEBREAK_TIMEOUT_MS = 60_000;

/**
 * Resolve one ambiguous match. Throws when the model never produced a usable
 * report (including on timeout) — callers treat any rejection the same as an
 * explicit "none": leave the draft open rather than risk a wrong pair.
 */
export async function resolveTiebreak(
  draftBody: string,
  candidates: TiebreakCandidate[],
  model: Model<Api>,
  timeoutMs = TIEBREAK_TIMEOUT_MS,
): Promise<string | null> {
  let captured: string | null | undefined;
  const agent = new Agent({
    initialState: {
      systemPrompt: SYSTEM_PROMPT,
      model,
      tools: [buildMatchReportTool((matchedId) => (captured = matchedId))],
    },
    streamFn: (m, c, o) => modelRegistry.streamSimple(m, c, o),
  });
  await runPrompt(
    { agent },
    renderPrompt(draftBody, candidates),
    {},
    AbortSignal.timeout(timeoutMs),
  );
  if (captured === undefined) throw new Error("model finished without calling report_match");
  return captured;
}
