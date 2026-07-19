import { Agent } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { moduleLogger } from "../core/logger.js";
import { loadOnOfficeTools } from "../integrations/onoffice/tools.js";
import { buildWhatsAppTools } from "../integrations/whatsapp/tools.js";
import { automationManageTools, automationReadTools } from "./automationTools.js";
import { composeBriefingTool } from "./briefingTool.js";
import type { SessionCapabilities } from "./capabilities.js";
import { presentChoicesTool } from "./choicesTool.js";
import { compactedMessages } from "./compaction.js";
import { buildDelegateTool } from "./delegate.js";
import { listDraftsTool } from "./draftTools.js";
import type { EmailToolset } from "./emailToolset.js";
import { buildFileTools } from "./fileTools.js";
import { recordCompactionMarker } from "./history.js";
import { buildKnowledgeReadTools, buildKnowledgeTools } from "./knowledgeTools.js";
import { leadDeleteTool, leadTools } from "./leadTools.js";
import { resolveActiveModel } from "./llm/registry.js";
import { streamViaModelRegistry } from "./oneShot.js";
import { buildSystemPrompt } from "./prompt.js";
import { skillReadTool, skillWriteTool } from "./skillTools.js";
import { buildTodoTools } from "./todoTools.js";
import { voiceLearnTool } from "./voiceLearn.js";
import { webFetchTool } from "./webFetchTool.js";
import { webSearchTool } from "./webSearchTool.js";

const log = moduleLogger("assembly");

/** Balanced default, deliberately not user-configurable. */
function resolveThinkingLevel(model: { reasoning: boolean }): "off" | "low" | "medium" | "high" {
  return model.reasoning ? "medium" : "off";
}

export async function buildAgent(
  toolset: EmailToolset,
  history: Message[],
  caps: SessionCapabilities,
  /**
   * The session's conversation id (a run id for automation sessions).
   * Forwarded to providers for session-scoped caching/affinity, and the
   * address the between-turns compaction hook persists its marker under.
   */
  sessionId?: string,
): Promise<Agent> {
  const model = await resolveActiveModel();
  // onOffice CRM tools (native, non-Pipedream): reads always, plus whichever
  // create/write surfaces the profile arms. Empty without onOffice credentials.
  const onOfficeTools = await loadOnOfficeTools({
    allowWrites: caps.onOffice.writes,
    allowCreates: caps.onOffice.creates,
  });
  // WhatsApp tools: local-mirror reads plus a draft-first send tool (autosend
  // gated at call time by the Settings grant). Empty while no account is paired.
  const whatsappTools = caps.whatsapp.linked ? buildWhatsAppTools() : [];
  // SECURITY: every session gets the agent-home-confined file tools, but an
  // unattended run reads attacker-controllable mail with nobody watching, so
  // it gets the read-only set and the whole-filesystem grants are never
  // consulted (fileTools.ts owns both rules).
  const fileTools = await buildFileTools(caps.interactive);
  const agent = new Agent({
    initialState: {
      systemPrompt: await buildSystemPrompt(caps),
      model,
      thinkingLevel: resolveThinkingLevel(model),
      tools: [
        listDraftsTool,
        ...toolset.tools,
        ...onOfficeTools,
        ...whatsappTools,
        ...fileTools,
        webSearchTool,
        webFetchTool,
        // SECURITY: an unattended run reads attacker-controllable mail with no
        // human to review a write, so it gets read-only knowledge tools. A
        // memory persisted from a malicious email would otherwise be injected
        // into every later session's system prompt. Same surface delegate
        // workers get.
        ...(caps.interactive ? buildKnowledgeTools() : buildKnowledgeReadTools()),
        // SECURITY: automation management is interactive-only. An automation's
        // instruction is a standing prompt executed unattended every tick, so
        // mail content can't plant or alter one. Past-run reads are inert.
        ...(caps.interactive ? automationManageTools : []),
        ...automationReadTools,
        // Lead rows are inert structured data, so intake and updates stay
        // available unattended (that's how mail becomes leads). Deleting
        // cascades over the lead's automations, so it's interactive-only.
        // Without CRM credentials the whole lead surface is absent.
        ...(caps.onOffice.configured ? leadTools : []),
        ...(caps.onOffice.configured && caps.interactive ? [leadDeleteTool] : []),
        // Todos are inert data like leads, so create/list/update stay available
        // unattended: that is how a run that hits a decision it can't make files
        // one for the user. create_todo links back to this session's conversation.
        ...buildTodoTools(sessionId),
        buildDelegateTool(toolset.readTools),
        // SECURITY: skills are read everywhere (unattended runs follow them),
        // but written only interactively: a skill is a standing instruction
        // executed on later runs, so mail content can't plant or alter one.
        skillReadTool,
        ...(caps.interactive ? [skillWriteTool] : []),
        ...(caps.interactive ? [voiceLearnTool] : []),
        composeBriefingTool,
        ...(caps.interactive ? [presentChoicesTool] : []),
      ],
      messages: history,
    },
    // Route model calls through the registry so stored credentials apply
    // (subscription OAuth, saved API keys, then env vars).
    streamFn: streamViaModelRegistry,
    sessionId,
  });
  // A tool-heavy run can outgrow the context window between the turns of one
  // run, where runPrompt's pre-prompt compaction can't reach. This hook trims
  // mid-run: hand the loop a compacted replacement and mirror it onto agent
  // state so the durable transcript matches what the model sees next. The
  // state setter copies the array, so loop context and agent transcript stay
  // independent for later appends.
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
    if (sessionId) {
      await recordCompactionMarker(sessionId, compacted).catch((err: unknown) => {
        log.warn({ err, conversationId: sessionId }, "persisting the compaction marker failed");
      });
    }
    return { context: { ...context, messages: compacted } };
  };
  return agent;
}
