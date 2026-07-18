import { Agent } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { resolveActiveModel } from "../llm/registry.js";
import { loadOnOfficeTools } from "../onoffice/tools.js";
import { buildWhatsAppTools } from "../whatsapp/tools.js";
import { automationManageTools, automationReadTools } from "./automationTools.js";
import { composeBriefingTool } from "./briefingTool.js";
import type { SessionCapabilities } from "./capabilities.js";
import { presentChoicesTool } from "./choicesTool.js";
import { compactedMessages } from "./compaction.js";
import { buildDelegateTool } from "./delegate.js";
import { listDraftsTool } from "./draftTools.js";
import type { EmailToolset } from "./emailToolset.js";
import { buildFileTools } from "./fileTools.js";
import { buildKnowledgeReadTools, buildKnowledgeTools } from "./knowledgeTools.js";
import { leadDeleteTool, leadTools } from "./leadTools.js";
import { streamViaModelRegistry } from "./oneShot.js";
import { buildSystemPrompt } from "./prompt.js";
import { skillReadTool, skillWriteTool } from "./skillTools.js";
import { voiceLearnTool } from "./voiceLearn.js";
import { webFetchTool } from "./webFetchTool.js";
import { webSearchTool } from "./webSearchTool.js";

/**
 * Builds the wired pi Agent for one session: active model, system prompt,
 * the capability-gated toolset, and the between-turns compaction hook. Which
 * tool groups arm is decided entirely by the SessionCapabilities profile
 * (capabilities.ts), so the toolset and the system prompt's claims about it
 * derive from the same record.
 */

/** Fixed at a balanced default, not user-configurable — "medium" wherever the model can reason at all. */
function resolveThinkingLevel(model: { reasoning: boolean }): "off" | "low" | "medium" | "high" {
  return model.reasoning ? "medium" : "off";
}

export async function buildAgent(
  toolset: EmailToolset,
  history: Message[],
  caps: SessionCapabilities,
  /**
   * Forwarded to providers that support session-scoped caching or affinity
   * headers (see pi-ai's SimpleStreamOptions.sessionId). The conversation id
   * for pooled sessions; unset for throwaway automation sessions.
   */
  sessionId?: string,
): Promise<Agent> {
  // Active model comes from Settings (SQLite), falling back to .env.
  const model = await resolveActiveModel();
  // onOffice CRM tools (native, non-Pipedream): the read surface always,
  // plus whichever create/write surfaces the profile arms — the CRM
  // counterpart of the per-account permission grants. Empty when no onOffice
  // credentials are configured.
  const onOfficeTools = await loadOnOfficeTools({
    allowWrites: caps.onOffice.writes,
    allowCreates: caps.onOffice.creates,
  });
  // WhatsApp tools ride the local mirror (reads) and the live socket (send,
  // when the profile arms it). Empty while no personal account is paired.
  const whatsappTools = caps.whatsapp.linked
    ? buildWhatsAppTools({ allowSend: caps.whatsapp.sends })
    : [];
  // The file tools are interactive-only: an unattended run reads
  // attacker-controllable mail with nobody watching, so it never touches the
  // filesystem regardless of the grants. Empty while nothing is armed.
  const fileTools = caps.interactive ? await buildFileTools() : [];
  const agent = new Agent({
    initialState: {
      systemPrompt: await buildSystemPrompt(caps),
      model,
      thinkingLevel: resolveThinkingLevel(model),
      // Per-account MCP tools (live reads always; the rest per permission grant),
      // the local draft/attachment tools, web search/fetch, the memory/library
      // tools, the delegate fan-out tool (built around this session's read
      // subset so workers ride the same MCP sessions), and (interactive
      // sessions only) present_choices for disambiguating with the user
      // instead of guessing.
      tools: [
        listDraftsTool,
        ...toolset.tools,
        ...onOfficeTools,
        ...whatsappTools,
        ...fileTools,
        webSearchTool,
        webFetchTool,
        // An unattended run reads attacker-controllable mail with no human to
        // review a write, so it gets read-only knowledge tools (no memory or
        // library writes, no voice_learn): a memory or note persisted from a
        // malicious email would otherwise be injected into every later
        // session's system prompt. Same read-only surface delegate workers get.
        ...(caps.interactive ? buildKnowledgeTools() : buildKnowledgeReadTools()),
        // Automation management is interactive-only for the same reason: an
        // automation's instruction is a standing prompt executed unattended
        // on every tick, so mail content must never be able to plant or
        // alter one. Past-run reads are inert, so every session gets them.
        ...(caps.interactive ? automationManageTools : []),
        ...automationReadTools,
        // Lead rows are inert structured data (never executed), so intake and
        // updates stay available unattended — that's how mail becomes leads.
        // Deleting cascades over the lead's automations: interactive only.
        // The leads directory belongs to the real-estate workflow: without
        // CRM credentials the whole lead surface is absent.
        ...(caps.onOffice.configured ? leadTools : []),
        ...(caps.onOffice.configured && caps.interactive ? [leadDeleteTool] : []),
        buildDelegateTool(toolset.readTools),
        // Skills are read everywhere — unattended runs follow them too ("Follow
        // the skill 'x'" automations) — but written only interactively: a skill
        // is a standing instruction executed on later runs, so mail content
        // must never be able to plant or alter one.
        skillReadTool,
        ...(caps.interactive ? [skillWriteTool] : []),
        ...(caps.interactive ? [voiceLearnTool] : []),
        composeBriefingTool,
        ...(caps.interactive ? [presentChoicesTool] : []),
      ],
      messages: history,
    },
    // Route model calls through the registry so stored credentials apply
    // (subscription OAuth with auto-refresh, saved API keys, then env vars).
    streamFn: streamViaModelRegistry,
    sessionId,
  });
  // A tool-heavy run (a many-thread digest) can outgrow the context window
  // between the turns of one run, where runPrompt's pre-prompt compaction
  // can't reach. This hook runs after every turn inside a run: when the
  // loop's context nears the window, hand the loop a compacted replacement
  // and mirror it onto agent state so the durable transcript matches what
  // the model sees next. The state setter copies the array, so the loop's
  // context and the agent's transcript stay independent for later appends.
  agent.prepareNextTurnWithContext = async ({ context }, signal) => {
    const compacted = await compactedMessages(
      {
        systemPrompt: context.systemPrompt,
        model: agent.state.model,
        messages: context.messages,
      },
      undefined,
      { signal },
    );
    if (!compacted) return undefined;
    agent.state.messages = compacted;
    return { context: { ...context, messages: compacted } };
  };
  return agent;
}
