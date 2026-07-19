import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { and, desc, eq, gte } from "drizzle-orm";
import { createAutomation, deleteAutomation, updateAutomation } from "../automations/manage.js";
import { getNextRunAt } from "../automations/scheduler.js";
import { db, schema } from "../db/index.js";
import { likeContains, likePattern } from "../db/like.js";
import { collapseWhitespace } from "../search/snippets.js";
import { clampLimit, textResult, tool } from "./toolkit.js";

/**
 * Two bundles. automationManageTools (list, create, update, delete) are
 * interactive-only: an automation's instruction is a standing prompt run on
 * every future tick, so attacker-controllable mail in an unattended run can't
 * plant or alter one. automationReadTools are inert reads, available in
 * every session.
 */

const INSTRUCTION_PREVIEW_CHARS = 200;

const SCHEDULE_DESCRIPTION =
  `Five-field cron expression (minute hour day-of-month month day-of-week), interpreted in the ` +
  `user's timezone — "0 8 * * *" is daily at 08:00, "0 9 * * 1" is Mondays at 09:00. A fixed ` +
  `day-of-month AND month with day-of-week "*" (e.g. "0 9 15 3 *") is treated as one-time: it ` +
  `runs once at the next occurrence and then disables itself. Pass "" for a manual-only ` +
  `automation that never fires on its own — the user runs it on demand with its "Run now" ` +
  `button on the Automations page.`;

const RUN_ON_NEW_MAIL_DESCRIPTION =
  "Also run immediately whenever new inbound mail is detected in any connected account, in " +
  "addition to the cron schedule.";

const NOTIFY_ON_COMPLETION_DESCRIPTION =
  "Show a desktop notification when a run of this automation finishes.";

function instructionPreview(instruction: string): string {
  const collapsed = collapseWhitespace(instruction);
  if (collapsed.length <= INSTRUCTION_PREVIEW_CHARS) return collapsed;
  return `${collapsed.slice(0, INSTRUCTION_PREVIEW_CHARS)}…`;
}

function scheduleSummary(automation: { id: string; schedule: string; enabled: boolean }): string {
  if (!automation.schedule) {
    return `manual-only, runs via its "Run now" button${automation.enabled ? "" : ", paused"}`;
  }
  if (!automation.enabled) return `schedule ${automation.schedule}, paused`;
  const next = getNextRunAt(automation.id);
  return `schedule ${automation.schedule}${next ? `, next run ${next}` : ""}`;
}

const automationList: AgentTool = tool({
  name: "automation_list",
  label: "List automations",
  description:
    `The user's scheduled automations — each one's id, cron schedule, enabled state, next run ` +
    `time and a short preview of its instruction. Use it to answer "what runs when", and to find ` +
    `the id for automation_update or automation_delete. Pass fullInstructions to get complete ` +
    `instruction texts — always read the current text before editing one.`,
  params: {
    fullInstructions: Type.Optional(
      Type.Boolean({
        description: "Include each automation's complete instruction text instead of a preview.",
      }),
    ),
  },
  execute: async ({ fullInstructions }) => {
    const rows = await db
      .select()
      .from(schema.automations)
      .orderBy(desc(schema.automations.createdAt));
    if (rows.length === 0) {
      return textResult("No automations exist yet — create one with automation_create.");
    }
    const lines = rows.map((a) => {
      const status = !a.enabled
        ? "paused"
        : a.schedule
          ? `next run ${getNextRunAt(a.id) ?? "unscheduled"}`
          : "runs on demand";
      const instruction = fullInstructions
        ? `\n  instruction: ${a.instruction.replaceAll("\n", "\n  ")}`
        : `\n  ${instructionPreview(a.instruction)}`;
      return `- [${a.id}] "${a.name}" — ${a.schedule || "manual"} — ${status}${instruction}`;
    });
    return textResult(lines.join("\n"));
  },
});

const automationCreate: AgentTool = tool({
  name: "automation_create",
  label: "Create automation",
  description:
    `Schedule recurring (or one-time future) work as an automation: every cron firing runs the ` +
    `instruction as a fresh unattended agent run whose result lands in the Home activity feed. ` +
    `Use it whenever the user wants something done on a schedule ("every morning…", "each ` +
    `Friday…", "on the 15th…") rather than doing it once and letting it drop. Without a ` +
    `schedule it becomes a one-click button instead: the user triggers it on demand from the ` +
    `Automations page — when they ask for "a button" for a recurring task, save the procedure ` +
    `as a skill (skill_write) and create a manual-only automation whose instruction is ` +
    `"Follow the skill '<name>'". Write the instruction fully self-contained — the run sees ` +
    `nothing of this conversation, so spell out what to do, over which accounts, and what to ` +
    `report. Unattended runs read mail and create drafts but can never send, reply, forward, ` +
    `label or delete — phrase the instruction accordingly. After creating, confirm to the user ` +
    `what you set up; they can review and edit every automation in the web app.`,
  params: {
    name: Type.String({ description: 'Short display name, e.g. "Weekly invoice sweep".' }),
    instruction: Type.String({
      description: "The complete, self-contained instruction the unattended run will execute.",
    }),
    schedule: Type.Optional(Type.String({ description: SCHEDULE_DESCRIPTION })),
    runOnNewMail: Type.Optional(Type.Boolean({ description: RUN_ON_NEW_MAIL_DESCRIPTION })),
    notifyOnCompletion: Type.Optional(
      Type.Boolean({ description: NOTIFY_ON_COMPLETION_DESCRIPTION }),
    ),
    leadId: Type.Optional(
      Type.String({
        description:
          "Attach the automation to this lead (from lead_list): it shows up with the lead and " +
          "is deleted with it. Only for follow-ups about that specific lead.",
      }),
    ),
  },
  catchToText: true,
  execute: async ({ name, instruction, schedule, runOnNewMail, notifyOnCompletion, leadId }) => {
    const automation = await createAutomation({
      name,
      instruction,
      schedule,
      runOnNewMail,
      notifyOnCompletion,
      leadId,
    });
    return textResult(
      `Created automation "${automation.name}" [${automation.id}] — ${scheduleSummary(automation)}.`,
    );
  },
});

const automationUpdate: AgentTool = tool({
  name: "automation_update",
  label: "Update automation",
  description:
    `Change an existing automation — pass its id (from automation_list) and only the fields to ` +
    `change. enabled: false pauses it without losing anything; enabled: true resumes it. A new ` +
    `instruction replaces the old one entirely, so read the current text first (automation_list ` +
    `with fullInstructions) and pass the complete edited version.`,
  params: {
    id: Type.String({ description: "The automation id (from automation_list)." }),
    name: Type.Optional(Type.String({ description: "New display name." })),
    instruction: Type.Optional(
      Type.String({ description: "Complete replacement instruction (not a diff)." }),
    ),
    schedule: Type.Optional(Type.String({ description: SCHEDULE_DESCRIPTION })),
    enabled: Type.Optional(
      Type.Boolean({ description: "false pauses the automation; true resumes it." }),
    ),
    runOnNewMail: Type.Optional(Type.Boolean({ description: RUN_ON_NEW_MAIL_DESCRIPTION })),
    notifyOnCompletion: Type.Optional(
      Type.Boolean({ description: NOTIFY_ON_COMPLETION_DESCRIPTION }),
    ),
  },
  catchToText: true,
  execute: async ({
    id,
    name,
    instruction,
    schedule,
    enabled,
    runOnNewMail,
    notifyOnCompletion,
  }) => {
    const automation = await updateAutomation(id, {
      name,
      instruction,
      schedule,
      enabled,
      runOnNewMail,
      notifyOnCompletion,
    });
    return textResult(
      `Updated automation "${automation.name}" [${automation.id}] — ${scheduleSummary(automation)}.`,
    );
  },
});

const automationDelete: AgentTool = tool({
  name: "automation_delete",
  label: "Delete automation",
  description:
    `Permanently delete an automation AND its entire run history — past results disappear from ` +
    `the activity feed and automation_history. Only when the user explicitly asks to delete or ` +
    `remove it; when they just want it to stop running, pause it instead with automation_update ` +
    `(enabled: false).`,
  params: {
    id: Type.String({ description: "The automation id (from automation_list)." }),
  },
  catchToText: true,
  execute: async ({ id }) => {
    const deleted = await deleteAutomation(id);
    return textResult(
      deleted
        ? "Automation deleted, along with its run history."
        : `No automation with id ${id} — check automation_list.`,
    );
  },
});

export const automationManageTools: AgentTool[] = [
  automationList,
  automationCreate,
  automationUpdate,
  automationDelete,
];

const HISTORY_DEFAULT_DAYS = 14;
const HISTORY_DEFAULT_LIMIT = 20;
const HISTORY_MAX_LIMIT = 50;
const HISTORY_PREVIEW_CHARS = 200;

const automationHistory: AgentTool = tool({
  name: "automation_history",
  label: "Automation run history",
  description:
    `Past scheduled-automation runs (morning briefings, etc.) — use ` +
    `when the user references "your briefing", "you flagged X", or asks what an automation ` +
    `found or did on some day. Lists recent runs newest first with a short preview of each ` +
    `result; call automation_run_read with a run's id for the full text.`,
  params: {
    automationName: Type.Optional(
      Type.String({
        description:
          'Only runs of the automation whose name contains this (partial match), e.g. "Morgenbriefing".',
      }),
    ),
    days: Type.Optional(
      Type.Number({ description: `How many days back to look (default ${HISTORY_DEFAULT_DAYS}).` }),
    ),
    limit: Type.Optional(
      Type.Number({
        description: `Max runs to return, 1–${HISTORY_MAX_LIMIT} (default ${HISTORY_DEFAULT_LIMIT}).`,
      }),
    ),
  },
  execute: async ({ automationName, days, limit: limitRaw }) => {
    const windowDays = Math.max(1, Math.round(days ?? HISTORY_DEFAULT_DAYS));
    const limit = clampLimit(limitRaw, HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT);
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

    const conditions = [gte(schema.automationRuns.startedAt, since)];
    const name = automationName?.trim();
    if (name) conditions.push(likePattern(schema.automations.name, likeContains(name)));

    const rows = await db
      .select({
        id: schema.automationRuns.id,
        name: schema.automations.name,
        status: schema.automationRuns.status,
        result: schema.automationRuns.result,
        startedAt: schema.automationRuns.startedAt,
      })
      .from(schema.automationRuns)
      .leftJoin(schema.automations, eq(schema.automations.id, schema.automationRuns.automationId))
      .where(and(...conditions))
      .orderBy(desc(schema.automationRuns.startedAt))
      .limit(limit);

    if (rows.length === 0) {
      return textResult(
        name
          ? `No automation runs matching "${name}" in the last ${windowDays} day(s).`
          : `No automation runs in the last ${windowDays} day(s).`,
      );
    }

    const lines = rows.map((r) => {
      const collapsed = collapseWhitespace(r.result);
      const preview = collapsed.slice(0, HISTORY_PREVIEW_CHARS);
      const suffix = collapsed.length > HISTORY_PREVIEW_CHARS ? "…" : "";
      return (
        `- [${r.id}] ${r.name ?? "(deleted automation)"} — ${r.status} — ${r.startedAt}` +
        (preview ? ` — ${preview}${suffix}` : "")
      );
    });
    return textResult(lines.join("\n"));
  },
});

const automationRunRead: AgentTool = tool({
  name: "automation_run_read",
  label: "Read automation run",
  description:
    `Read one past automation run in full — its complete result text plus the automation ` +
    `name, status, and timestamps. Use the run id shown in brackets by automation_history.`,
  params: {
    runId: Type.String({ description: "The run id (from automation_history)." }),
  },
  execute: async ({ runId }) => {
    const [row] = await db
      .select({
        name: schema.automations.name,
        status: schema.automationRuns.status,
        result: schema.automationRuns.result,
        startedAt: schema.automationRuns.startedAt,
        finishedAt: schema.automationRuns.finishedAt,
      })
      .from(schema.automationRuns)
      .leftJoin(schema.automations, eq(schema.automations.id, schema.automationRuns.automationId))
      .where(eq(schema.automationRuns.id, runId));

    if (!row) {
      return textResult(
        `No automation run found for id ${runId} — use automation_history to look up run ids.`,
      );
    }

    const header =
      `${row.name ?? "(deleted automation)"} — ${row.status} — started ${row.startedAt}` +
      (row.finishedAt ? `, finished ${row.finishedAt}` : "");
    return textResult(`${header}\n\n${row.result || "(empty result)"}`);
  },
});

export const automationReadTools: AgentTool[] = [automationHistory, automationRunRead];
