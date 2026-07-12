import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type ConnectedAccount, EMAIL_APPS } from "@trailin/shared";
import { accountSupportsWaiting, listWaitingOnOthers } from "../email/waiting.js";
import { errorMessage } from "../util.js";
import { resolveAccountParam } from "./accounts.js";
import { defineTool, textResult } from "./toolResult.js";

/**
 * Agent tool over email/waiting.ts's "waiting on others" threads (same data
 * the Home page's "Open conversations" section uses, routes/waiting.ts) —
 * computed from the local mailbox mirror, so it covers every connected
 * account whose app has a SyncProvider instead of hardcoding any one of
 * them. Whether a reply is genuinely still expected is enrichment's call
 * (mail_thread_state.awaiting_reply), not a fixed age floor.
 */

/** Whole days elapsed since `iso`, floored, min 1 — for the "waiting N day(s)" display line. */
function daysSince(iso: string): number {
  return Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / (24 * 60 * 60 * 1000)));
}

export const listWaitingThreadsTool: AgentTool = defineTool({
  name: "list_waiting_threads",
  label: "List threads awaiting replies",
  description:
    `Threads where the user sent the last message and enrichment judged a reply is still ` +
    `expected — per connected account with mailbox sync, most-overdue first, up to 10 per ` +
    `account, within the last 14 days. Use this for follow-up checks, briefings, or when the ` +
    `user asks what they're still waiting on. Read a thread with the account's get-thread ` +
    `tool using the listed threadId, and consider offering a nudge draft for long-overdue ones.`,
  parameters: {
    type: "object",
    properties: {
      account: {
        type: "string",
        description:
          "Only check this account (email address or account id); omit to check every " +
          "connected account with waiting-thread tracking.",
      },
    },
  },
  execute: async (_id, params) => {
    const { account } = params as { account?: string };
    const resolved = await resolveAccountParam(account);
    if (resolved.error) return textResult(resolved.error);

    let targets: ConnectedAccount[];
    if (resolved.account) {
      if (!accountSupportsWaiting(resolved.account.app)) {
        return textResult(
          `${resolved.account.name} (${resolved.account.app}) isn't covered by waiting-thread ` +
            `tracking yet (no mailbox sync for this app).`,
        );
      }
      targets = [resolved.account];
    } else {
      targets = resolved.accounts.filter((a) => accountSupportsWaiting(a.app));
    }

    if (targets.length === 0) {
      return textResult("No connected accounts support waiting-thread tracking yet.");
    }

    const sections: string[] = [];
    let anyWaiting = false;
    let anyFailed = false;
    for (const acc of targets) {
      try {
        const items = await listWaitingOnOthers(acc);
        if (items.length === 0) {
          sections.push(`${acc.name}: nothing waiting.`);
          continue;
        }
        anyWaiting = true;
        const lines = items.map(
          (t) =>
            `- ${t.counterpart} — "${t.subject}" — waiting ${daysSince(t.lastSentAt)} day(s), ` +
            `since ${t.lastSentAt.slice(0, 10)} — threadId: ${t.threadId}`,
        );
        sections.push(`${acc.name}:\n${lines.join("\n")}`);
      } catch (error) {
        anyFailed = true;
        sections.push(`${acc.name}: lookup failed (${errorMessage(error)})`);
      }
    }

    // Collapse to one line only when every account came back clean and empty —
    // a failure is worth surfacing even if nothing else is waiting.
    if (!anyWaiting && !anyFailed)
      return textResult("No threads are waiting on a reply right now.");

    if (!resolved.account) {
      const uncovered = resolved.accounts.filter(
        (a) => !accountSupportsWaiting(a.app) && (EMAIL_APPS as readonly string[]).includes(a.app),
      );
      if (uncovered.length > 0) {
        sections.push(
          `Not covered by waiting-thread tracking yet: ${uncovered.map((a) => a.name).join(", ")}.`,
        );
      }
    }

    return textResult(sections.join("\n\n"));
  },
});
