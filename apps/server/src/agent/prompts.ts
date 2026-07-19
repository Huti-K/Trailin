import { readFileSync } from "node:fs";

/**
 * LLM prompt prose, loaded eagerly from the .md files in prompts/ so a missing
 * or renamed file fails at startup, not mid-turn. The files are raw prompt text
 * (every character ships to the model), so they carry no comments. Paths
 * resolve against import.meta.url, which the desktop build copies prompts/ next to.
 */

function read(name: string): string {
  return readFileSync(new URL(`./prompts/${name}.md`, import.meta.url), "utf8").trim();
}

/**
 * The writing patterns that mark text as machine-written, spliced into both the
 * system prompt and the humanizer prompt via their {{ai-writing-tells}}
 * placeholder. Extend that file, never one prompt only.
 */
const aiWritingTells = read("ai-writing-tells");

function withTells(text: string): string {
  return text.replaceAll("{{ai-writing-tells}}", aiWritingTells);
}

export const prompts = {
  /** The base system prompt; buildSystemPrompt appends the conditional sections. */
  system: withTells(read("system")),
  humanizer: withTells(read("humanizer")),
  delegateWorker: read("delegate-worker"),
  compaction: read("compaction"),
  automationSuggest: read("automation-suggest"),
  voiceExtract: read("voice-extract"),
  voiceMatch: read("voice-match"),
} as const;
