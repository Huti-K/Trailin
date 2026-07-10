import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import type { AccountVoice } from "@trailin/shared";
import { createMemory, deleteMemory, listMemories } from "../db/memories.js";
import { getAccountVoices, setAccountVoices } from "../db/settings.js";
import { modelRegistry, resolveActiveModel } from "../llm/registry.js";
import { moduleLogger } from "../logger.js";
import { listAccounts } from "../pipedream/connect.js";
import { loadEmailTools } from "../pipedream/mcp.js";
import { errorMessage } from "../util.js";
import { runPrompt } from "./run.js";

const log = moduleLogger("voiceLearn");

/**
 * Learns an account's writing voice from its own sent mail: a one-shot
 * ephemeral Agent (same pattern as delegate.ts / humanizer.ts) reads a sample
 * of the user's sent messages with the account's read-only tools, then calls
 * a local report_style tool (terminate: true) to hand back its findings
 * instead of replying in prose — the structured-output pattern the pi
 * framework's AgentTool is meant for. parseLearnedVoice/stripCodeFence remain
 * only as the fallback for the rare case the model never calls the tool. The
 * signature is saved on the account's AccountVoice (the same record Settings
 * edits and the create-draft tool, pipedream/mcp.ts, reads at save time); the
 * style directives are saved as account-scoped long-term memories instead
 * (db/memories.ts), with their ids recorded on AccountVoice.styleMemoryIds so
 * the next learn run knows which ones to replace.
 */

function systemPromptFor(accountName: string): string {
  return `You are a writing-style analyst for Trailin, a personal email assistant. Your only job is
to study the user's OWN sent messages in the connected account ${accountName} and report back
their writing style — nothing else.

Steps:
1. Use this account's email SEARCH tool — the one whose description says "Acts as the connected
   account: ${accountName}" — to list the most recent messages the user sent. On Gmail, the query
   "from:${accountName}" does this; on other providers, use the closest equivalent (a sent-folder
   listing, or a sender/from filter).
2. Read 8-15 of those messages across DIFFERENT threads and recipients with this account's
   thread- or message-reading tool. Use only tools that act as this account.
3. When you are done, call the report_style tool exactly once with your findings.`;
}

/** Strips a wrapping ``` fence if the model added one despite being told not to (see humanizer.ts). */
function stripCodeFence(text: string): string {
  const match = text.match(/^```[^\n]*\n([\s\S]*)\n```$/);
  return match ? match[1]!.trim() : text;
}

interface LearnedVoice {
  style: string[];
  signature: string;
}

function isLearnedVoice(value: unknown): value is LearnedVoice {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    Array.isArray(v.style) &&
    v.style.every((entry) => typeof entry === "string") &&
    typeof v.signature === "string"
  );
}

function parseLearnedVoice(raw: string): LearnedVoice {
  const stripped = stripCodeFence(raw.trim());
  try {
    const parsed: unknown = JSON.parse(stripped);
    if (isLearnedVoice(parsed)) return parsed;
  } catch {
    // fall through to the brace-extraction attempt below
  }
  const match = stripped.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed: unknown = JSON.parse(match[0]);
      if (isLearnedVoice(parsed)) return parsed;
    } catch {
      // fall through to the throw below
    }
  }
  throw new Error("could not parse the style analysis result");
}

/**
 * Runtime guard for the report_style tool's call. The JSON schema below only
 * constrains what the model is told to send, not what actually arrives —
 * this throws (the AgentTool contract: "throw on failure instead of
 * encoding errors in content") on anything malformed, so a bad call fails
 * the tool call itself before learnAccountVoice ever touches persistence.
 */
function validateReportStyleParams(value: unknown): LearnedVoice {
  if (typeof value !== "object" || value === null) {
    throw new Error("report_style: params must be an object with style and signature.");
  }
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.style) || v.style.length === 0) {
    throw new Error("report_style: style must be a non-empty array of style directives.");
  }
  const style = v.style.map((entry) => (typeof entry === "string" ? entry.trim() : ""));
  if (style.some((entry) => !entry)) {
    throw new Error("report_style: every style entry must be a non-empty string.");
  }
  if (typeof v.signature !== "string") {
    throw new Error('report_style: signature must be a string (use "" if there is none).');
  }
  return { style, signature: v.signature };
}

/**
 * The worker's structured-output tool: instead of parsing prose, it hands its
 * findings straight to `onReport` as validated params. `terminate: true`
 * tells the agent loop to stop after this tool batch rather than start
 * another turn — there is nothing left for the worker to do once it reports.
 */
function buildReportStyleTool(onReport: (report: LearnedVoice) => void): AgentTool {
  return {
    name: "report_style",
    label: "Report writing style",
    description:
      `Record the writing-style analysis for this account. Call this exactly once, after reading ` +
      `the sample messages, to finish the job.`,
    parameters: {
      type: "object",
      properties: {
        style: {
          type: "array",
          items: { type: "string" },
          description:
            `3-6 short, self-contained directives another assistant can follow when drafting as ` +
            `this account, one aspect per entry — typical greeting, typical sign-off, ` +
            `formality/tone, typical message length, language(s) used and when, and any quirks or ` +
            `audience shifts (e.g. formal with clients, casual with colleagues). Each entry is ONE ` +
            `sentence, written as an instruction ("Greets clients with 'Hallo Herr/Frau <Nachname>' ` +
            `…"), not an observation about counts, and under 280 characters.`,
        },
        signature: {
          type: "string",
          description:
            `The exact recurring signature block the user puts under their sign-off, verbatim ` +
            `including line breaks, WITHOUT the closing line itself ("Best," / "Beste Grüße," ` +
            `belongs to the body, not the signature). Use "" if there is no consistent block.`,
        },
      },
      required: ["style", "signature"],
    } as AgentTool["parameters"],
    execute: async (_id, params) => {
      const report = validateReportStyleParams(params);
      onReport(report);
      return {
        content: [{ type: "text", text: "Style report recorded." }],
        details: undefined,
        terminate: true,
      };
    },
  };
}

/**
 * Analyze one account's sent mail and persist the learned style (as
 * account-scoped memories) and signature (on AccountVoice). This runs
 * several tool round-trips against the model — expect 30-90s.
 */
export async function learnAccountVoice(accountId: string): Promise<AccountVoice> {
  const account = (await listAccounts()).find((a) => a.id === accountId);
  if (!account) throw new Error(`No connected account with id ${accountId}.`);
  if (!account.name.includes("@")) {
    throw new Error(`${account.name} is not an email account — voice learning needs sent mail.`);
  }

  const toolset = await loadEmailTools();
  let learned: LearnedVoice;
  try {
    let captured: LearnedVoice | undefined;
    const agent = new Agent({
      initialState: {
        systemPrompt: systemPromptFor(account.name),
        model: await resolveActiveModel(),
        tools: [...toolset.readTools, buildReportStyleTool((report) => (captured = report))],
      },
      streamFn: (m, c, o) => modelRegistry.streamSimple(m, c, o),
    });
    const raw = await runPrompt(
      { agent },
      `Study ${account.name}'s sent mail and report its writing style and signature as instructed.`,
    );
    // Prefer the structured report_style call; parseLearnedVoice(raw) is only
    // the fallback for the rare case the model replied in prose instead.
    learned = captured ?? parseLearnedVoice(raw);
  } finally {
    await toolset.close().catch(() => {});
  }

  const voices = await getAccountVoices();
  const existing = voices.find((v) => v.accountId === accountId);

  // Write-then-delete: create the new style memories and persist the voice
  // record pointing at them FIRST, and only then delete the previous learn
  // run's memories. Deleting first (the old order) meant a mid-run failure,
  // or a directive silently skipped below, could leave the account with
  // fewer/no style directives and styleMemoryIds pointing at nothing — an
  // orphaned old memory is recoverable by hand, a lost voice is not.
  const styleMemoryIds: string[] = [];
  for (const directive of learned.style) {
    const trimmed = directive.trim();
    if (!trimmed) continue;
    try {
      // A dedup hit returns the existing entry instead of creating a new one
      // — still worth recording its id so a future re-learn replaces it too.
      const { entry } = await createMemory(trimmed, "agent", accountId);
      styleMemoryIds.push(entry.id);
    } catch {
      // Skip directives the model produced that don't fit memory's limits
      // (e.g. over-length) rather than failing the whole learn run.
    }
  }

  const signature = learned.signature.trim();
  const next: AccountVoice = {
    accountId,
    // Keep any existing manually-set signature when nothing consistent was found.
    signature: signature || existing?.signature,
    learnedAt: new Date().toISOString(),
    styleMemoryIds,
  };
  const index = voices.findIndex((v) => v.accountId === accountId);
  const updated = index >= 0 ? voices.map((v, i) => (i === index ? next : v)) : [...voices, next];
  await setAccountVoices(updated);

  // Only now replace the previous learn run's style directives, not any
  // memory the user wrote by hand — deleteMemory is a no-op for ids already
  // gone. Skip any id a dedup hit above reused for the new voice, and don't
  // let one bad delete abort the rest: the fresh voice above is already
  // saved either way, so a failure here just orphans a memory (recoverable
  // in Settings) rather than losing the voice.
  for (const id of existing?.styleMemoryIds ?? []) {
    if (styleMemoryIds.includes(id)) continue;
    try {
      await deleteMemory(id);
    } catch (error) {
      log.warn({ err: error, accountId, memoryId: id }, "failed to delete old style memory");
    }
  }

  return next;
}

export function buildVoiceLearnTool(): AgentTool {
  return {
    name: "voice_learn",
    label: "Learn account voice",
    description:
      `Analyze an account's sent mail to learn the user's writing style and extract their ` +
      `signature, then save the style as memories scoped to that account and the signature on ` +
      `its voice (visible in Settings and used for every future draft). Use when the user asks ` +
      `to learn or mimic their style, or set up their signature from past emails.`,
    parameters: {
      type: "object",
      properties: {
        account: {
          type: "string",
          description: "The connected account's email address to learn from.",
        },
      },
      required: ["account"],
    } as AgentTool["parameters"],
    execute: async (_id, params) => {
      const { account } = params as { account: string };
      try {
        const accounts = await listAccounts();
        const trimmed = account.trim();
        const resolved =
          accounts.find((a) => a.id === trimmed) ??
          accounts.find((a) => a.name.toLowerCase() === trimmed.toLowerCase());
        if (!resolved) {
          const list =
            accounts.length > 0 ? accounts.map((a) => a.name).join(", ") : "no accounts are connected";
          return {
            content: [
              {
                type: "text",
                text: `No connected account matches "${account}". Connected accounts: ${list}.`,
              },
            ],
            details: undefined,
          };
        }
        const voice = await learnAccountVoice(resolved.id);

        // Look the saved directives back up by id so the reply can quote them
        // — learnAccountVoice only returns the voice record, not their text.
        const memories = await listMemories();
        const byId = new Map(memories.map((m) => [m.id, m.content]));
        const styleLines = (voice.styleMemoryIds ?? [])
          .map((id) => byId.get(id))
          .filter((content): content is string => !!content)
          .map((content) => `- ${content}`);
        const styleText =
          styleLines.length > 0
            ? `Learned ${resolved.name}'s writing style, saved as memories for this account ` +
              `(review or edit them on the Knowledge page):\n${styleLines.join("\n")}`
            : `No consistent writing-style pattern was found for ${resolved.name}.`;
        const signatureText = voice.signature?.trim()
          ? `\n\nSignature saved:\n\n${voice.signature.trim()}`
          : "\n\nNo consistent signature block was found.";

        return {
          content: [{ type: "text", text: `${styleText}${signatureText}` }],
          details: undefined,
        };
      } catch (error) {
        return { content: [{ type: "text", text: errorMessage(error) }], details: undefined };
      }
    },
  };
}
