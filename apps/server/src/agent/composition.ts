import type { AccountVoice } from "@trailin/shared";
import { getAccountVoices } from "../db/settings.js";
import { moduleLogger } from "../logger.js";
import { fetchAccountNameMap } from "./accounts.js";
import { runOneShot } from "./oneShot.js";

const log = moduleLogger("composition");

/**
 * Draft composition — everything between "the model wrote a body" and "the
 * provider saves a draft" lives here: the humanizer copy-edit, the account
 * signature, and the voice/signature system-prompt section. One module so
 * every surface that saves a draft (chat, automations) composes identically,
 * and so the AI-tell list below has exactly one definition.
 */

/**
 * The writing patterns that mark text as machine-written. Interpolated into
 * both the main agent's system prompt (as guidance while writing) and the
 * humanizer's prompt (as an edit checklist) — extend it here, never in one
 * prompt only.
 */
export const AI_WRITING_TELLS = `- Filler openers and closers ("I hope this email finds you well", "I wanted to reach out",
  "I hope this helps", "Let me know if you have any questions" as a hollow closer).
- Sycophancy ("Great question", "Thanks so much for reaching out" when it isn't earned).
- LLM vocabulary: delve, leverage, utilize, foster, seamless, robust, streamline, underscore,
  testament, tapestry, navigate, boasts, vibrant, and "stands/serves as" (just say "is" or "has").
- Em and en dashes: use a comma, period, colon, or parentheses instead.
- Forced groups of three, and "not just X but Y" parallelisms.
- "-ing" tails that fake depth ("...ensuring...", "...highlighting...").
- Over-hedging ("could potentially possibly"), false ranges ("from X to Y" where X and Y aren't a
  real scale), synonym-cycling the same noun, bolded inline-header lists, and generic upbeat
  closers ("Overall...", "Exciting times ahead").`;

const HUMANIZER_PROMPT = `You are a copy editor for outgoing email drafts. Rewrite the body ONLY as
far as needed to remove AI-tell writing; if the draft already reads like a person wrote it, return
it VERBATIM.

Preserve exactly: the language it is written in (German stays German), the meaning, every fact,
name, number, date and URL, the greeting and sign-off, the paragraph structure, and roughly the
length (never pad it out).

Remove or fix:
${AI_WRITING_TELLS}

Output ONLY the rewritten body text: no commentary, no code fences, no subject line.`;

/** Strips a wrapping \`\`\` fence if the model added one despite being told not to. */
function stripCodeFence(text: string): string {
  const match = text.match(/^```[^\n]*\n([\s\S]*)\n```$/);
  return match ? (match[1] ?? "").trim() : text;
}

/**
 * Copy-edits one draft body to remove AI-tell writing, or returns it
 * unchanged if it already reads naturally. Fails open: any error, or an
 * empty model result, falls back to the original body untouched.
 */
async function humanizeDraftBody(input: {
  body: string;
  subject?: string;
}): Promise<{ body: string; changed: boolean }> {
  const original = input.body;
  const trimmedOriginal = original.trim();
  if (!trimmedOriginal) {
    return { body: original, changed: false };
  }

  try {
    const userMessage = input.subject ? `Subject: ${input.subject}\n\n${original}` : original;
    const raw = await runOneShot({ systemPrompt: HUMANIZER_PROMPT, prompt: userMessage });
    const rewritten = stripCodeFence(raw.trim());

    if (!rewritten) {
      log.warn("humanizer returned an empty result, keeping original body");
      return { body: original, changed: false };
    }

    return { body: rewritten, changed: rewritten !== trimmedOriginal };
  } catch (error) {
    log.warn({ err: error }, "humanizer failed, keeping original body");
    return { body: original, changed: false };
  }
}

export interface ComposedDraftBody {
  body: string;
  /** The humanizer pass changed the text. */
  humanized: boolean;
  /** The account's configured signature was appended. */
  signatureAppended: boolean;
  /**
   * The account's configured signature at compose time, whether or not this
   * pass appended it — stored on the draft snapshot so the learning loop can
   * strip it before diffing. Null when the account has none.
   */
  signature: string | null;
  /** Rich MIME body when the configured signature contains formatting. */
  htmlBody?: string;
}

/**
 * The full compose pipeline for a draft body: humanizer copy-edit, then the
 * account's signature — appended after the edit, and only when the (edited)
 * body doesn't already contain it (compared loosely so minor whitespace
 * differences don't cause a duplicate signature).
 */
export async function composeDraftBody(
  accountId: string,
  input: { body: string; subject?: string },
): Promise<ComposedDraftBody> {
  const humanized = await humanizeDraftBody(input);

  const voice = await getVoiceFor(accountId);
  const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
  let body = humanized.body;
  let signatureAppended = false;
  const signature = voice?.signature?.trim();
  const signatureHtml = voice?.signatureHtml?.trim();
  if (
    (signature || signatureHtml) &&
    (!signature || !normalize(body).includes(normalize(signature)))
  ) {
    body = `${body}\n\n${
      signature ??
      (signatureHtml ?? "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    }`;
    signatureAppended = true;
  }
  const htmlBody =
    signatureAppended && signatureHtml
      ? `${humanized.body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>")}<br><br>${signatureHtml}`
      : undefined;

  return {
    body,
    humanized: humanized.changed,
    signatureAppended,
    signature: signature ?? null,
    ...(htmlBody ? { htmlBody } : {}),
  };
}

/** Convenience lookup for one account's voice, or undefined if none is set. */
export async function getVoiceFor(accountId: string): Promise<AccountVoice | undefined> {
  const voices = await getAccountVoices();
  return voices.find((v) => v.accountId === accountId);
}

/**
 * The dynamic system-prompt section listing every account with a signature
 * configured. Returns "" when no account has one set. (Writing style is NOT
 * part of AccountVoice — it lives as account-scoped long-term memories and
 * reaches the agent through knowledgeTools.ts's buildKnowledgeContext.)
 */
export async function buildVoiceContext(): Promise<string> {
  const voices = await getAccountVoices();
  const withSignature = voices.filter((v) => v.signature?.trim());
  if (withSignature.length === 0) return "";

  const names = await fetchAccountNameMap();
  const lines = withSignature.map((v) => {
    const name = names.get(v.accountId) ?? v.accountId;
    return (
      `- ${name}: a signature is configured for this account and is appended automatically ` +
      `by the create-draft tool — never write one yourself.`
    );
  });

  return `\n\nPer-inbox signatures (set by the user in Settings):\n${lines.join("\n")}`;
}
