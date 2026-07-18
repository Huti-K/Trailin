import { Agent, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { modelRegistry, resolveActiveModel } from "../llm/registry.js";
import { runPrompt } from "./run.js";

/**
 * Routes an Agent's model calls through the registry so stored credentials
 * apply (subscription OAuth with auto-refresh, saved API keys, then env
 * vars). Shared by runOneShot below and assembly.ts's buildAgent,
 * which builds its Agent directly rather than through runOneShot.
 */
export const streamViaModelRegistry: StreamFn = (model, context, options) =>
  modelRegistry.streamSimple(model, context, options);

/**
 * Runs one prompt through a fresh, throwaway Agent and returns its final
 * text — the shape every one-shot sub-agent call in this app shares (the
 * draft humanizer, compaction's summarizer, delegate's parallel workers):
 * build an Agent scoped to one system prompt and toolset, run exactly one
 * prompt through it, and discard it. Runs on the active model — which
 * Settings can change between calls, so it's resolved per call — unless the
 * caller pins one via `model` (the nightly sweeps resolve theirs up front).
 */
export async function runOneShot(opts: {
  systemPrompt: string;
  tools?: AgentTool[];
  prompt: string;
  model?: Model<Api>;
  signal?: AbortSignal;
}): Promise<string> {
  const model = opts.model ?? (await resolveActiveModel());
  const agent = new Agent({
    initialState: { systemPrompt: opts.systemPrompt, model, tools: opts.tools ?? [] },
    streamFn: streamViaModelRegistry,
  });
  return runPrompt({ agent }, opts.prompt, { signal: opts.signal });
}

/**
 * The single report tool a runReportPrompt call exposes. `parameters` is the
 * tool's raw parameter JSON schema (a TypeBox object qualifies); `narrow`
 * distills the model's raw arguments — untrusted, so it must check rather
 * than assume the schema held — into the report value, and must not throw.
 */
export interface ReportToolSpec<T> {
  name: string;
  label: string;
  description: string;
  parameters: AgentTool["parameters"];
  narrow: (params: unknown) => T;
}

/**
 * Structured output from a one-shot run: a fresh Agent whose only tool is
 * the given report tool, marked `terminate: true` so the run ends with the
 * report rather than starting another turn. Returns the narrowed report;
 * throws when the model finishes without calling the tool at all — including
 * when `timeoutMs` lapses first — naming the tool unless the caller supplies
 * `missingReportError` (surfaced to users by some callers). Used by every
 * report-shaped LLM call: voice learning, the learning sweep's extraction and
 * tiebreak, and the automation-suggestion sweep.
 */
export async function runReportPrompt<T>(opts: {
  systemPrompt: string;
  tool: ReportToolSpec<T>;
  prompt: string;
  model?: Model<Api>;
  timeoutMs?: number;
  missingReportError?: string;
}): Promise<T> {
  // Boxed so a report legitimately narrowed to null/undefined still counts
  // as "the tool was called".
  let captured: { value: T } | undefined;
  const reportTool: AgentTool = {
    name: opts.tool.name,
    label: opts.tool.label,
    description: opts.tool.description,
    parameters: opts.tool.parameters,
    execute: async (_id, params) => {
      captured = { value: opts.tool.narrow(params) };
      return {
        content: [{ type: "text", text: "Report recorded." }],
        details: undefined,
        terminate: true,
      };
    },
  };
  await runOneShot({
    systemPrompt: opts.systemPrompt,
    tools: [reportTool],
    prompt: opts.prompt,
    model: opts.model,
    signal: opts.timeoutMs === undefined ? undefined : AbortSignal.timeout(opts.timeoutMs),
  });
  if (!captured) {
    throw new Error(opts.missingReportError ?? `model finished without calling ${opts.tool.name}`);
  }
  return captured.value;
}
