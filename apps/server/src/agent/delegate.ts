import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { mapWithConcurrency } from "../core/utils/jobs.js";
import { errorMessage } from "../core/utils/util.js";
import { automationReadTools } from "./automationTools.js";
import { buildKnowledgeContext, buildKnowledgeReadTools } from "./knowledgeTools.js";
import { runOneShot } from "./oneShot.js";
import { prompts } from "./prompts.js";
import { textResult, tool } from "./toolkit.js";
import { webFetchTool } from "./webFetchTool.js";
import { webSearchTool } from "./webSearchTool.js";

/**
 * The fan-out tool: the main agent hands off several independent read-only
 * lookups to short-lived parallel workers, then folds their reports into one
 * result. Workers get the session's live mail READ tools (shared by reference,
 * so they multiplex over the same MCP sessions) plus library, past automation
 * runs and web search/fetch, and no view of the main conversation. Never any
 * draft or write tool.
 */

/** Keeps parallel MCP and model calls modest. */
const MAX_TASKS = 8;
const CONCURRENCY = 4;

function truncateLabel(task: string, max = 80): string {
  return task.length > max ? `${task.slice(0, max - 1)}…` : task;
}

/**
 * Builds the session's delegate tool around its live mail read tools.
 * Per-session rather than a module singleton because the read tools are
 * per-account MCP wrappers owned by the session's toolset; sharing them by
 * reference lets workers ride the already-open MCP sessions.
 */
export function buildDelegateTool(readTools: AgentTool[]): AgentTool {
  return tool({
    name: "delegate",
    label: "Delegate research tasks",
    description: `Fan out independent read-only research tasks to parallel background workers. Use this when a job
needs several separate lookups (reviewing many threads for a digest, checking several senders'
histories, cross-checking multiple library documents, researching several things on the web)
instead of doing every lookup serially yourself. Each task must be fully self-contained — workers
see nothing of this conversation — so spell out exactly what to look up and what to report back,
including which account to look in. Workers can search and read email, the document library and
the web, but cannot draft, send or change anything; you act on their reports. For a single quick
lookup, call the email or web tools directly instead.`,
    params: {
      tasks: Type.Array(Type.String(), {
        description: "Self-contained task instructions, one per worker (max 8 per call).",
      }),
    },
    execute: async ({ tasks: rawTasks }, { signal, onUpdate }) => {
      const allTasks = rawTasks.map((t) => t.trim()).filter(Boolean);
      if (allTasks.length === 0) {
        return textResult("The tasks array was empty. Nothing to delegate.");
      }
      const dropped = allTasks.length - MAX_TASKS;
      const tasks = allTasks.slice(0, MAX_TASKS);

      const systemPrompt = prompts.delegateWorker + (await buildKnowledgeContext());
      const tools = [
        ...readTools,
        ...buildKnowledgeReadTools(),
        ...automationReadTools,
        webSearchTool,
        webFetchTool,
      ];

      let finished = 0;
      const reports = await mapWithConcurrency(tasks, CONCURRENCY, async (task) => {
        // The main turn was aborted (e.g. client disconnect): don't start
        // more workers; in-flight ones stop via the signal passed below.
        if (signal?.aborted) return "Cancelled before it started.";
        let report: string;
        try {
          report =
            (await runOneShot({ systemPrompt, tools, prompt: task, signal })) ||
            "(the worker returned an empty report)";
        } catch (error) {
          report = `Worker failed: ${errorMessage(error)}`;
        }
        finished += 1;
        onUpdate?.(textResult(`${finished}/${tasks.length} tasks done`));
        return report;
      });

      let text = tasks
        .map((task, i) => `### Task ${i + 1}: ${truncateLabel(task)}\n\n${reports[i]}`)
        .join("\n\n---\n\n");
      if (dropped > 0) {
        text += `\n\nNote: ${dropped} additional task(s) were dropped (max ${MAX_TASKS} per call).`;
      }

      return textResult(text);
    },
  });
}
