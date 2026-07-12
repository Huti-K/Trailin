import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ConnectedAccount, UnsubscribeInfo } from "@trailin/shared";
import { defineTool, textResult } from "../../agent/toolResult.js";
import { errorMessage } from "../../util.js";
import { executeAndMarkUnsubscribe, resolveAccountUnsubscribe } from "./resolve.js";

/**
 * "Unsubscribe from sender" agent tool: one per write-armed connected
 * account. Registered in pipedream/mcp.ts's loadEmailTools loop behind the
 * same `writeAccess.has(account.id)` gate as every MCP write tool, so an
 * unattended automation run (providerWrites: false empties writeAccess
 * entirely) can never reach it — this fires a real HTTP request to a third
 * party, the same bar as send/reply/delete.
 *
 * One-click only: a mailto-only or browse-only sender is reported back as
 * not automatable rather than attempted, since neither is safe to fire
 * without a human actually reading the link. Uses the exact same
 * resolveAccountUnsubscribe / executeOneClickUnsubscribe pair as
 * POST /api/newsletters/unsubscribe (routes/newsletters.ts) — one
 * implementation of the lookup and the RFC 8058 POST, not two.
 */
export function buildUnsubscribeTool(account: ConnectedAccount, name: string): AgentTool {
  return defineTool({
    name,
    label: "Unsubscribe from sender",
    description:
      `Unsubscribe this account from a bulk/newsletter sender's mailing list, when the sender ` +
      `supports RFC 8058 one-click unsubscribe. Pass the sender's email address (e.g. from ` +
      `search_mail results). Senders that only offer a browse link or a mailto address are ` +
      `refused — those need the user's own click, not the agent's.\n\n` +
      `Acts as the connected account: ${account.name}.`,
    parameters: {
      type: "object",
      properties: {
        address: {
          type: "string",
          description: "The sender's email address to unsubscribe from.",
        },
      },
      required: ["address"],
    },
    execute: async (_toolCallId, params) => {
      const { address } = params as { address?: string };
      const trimmed = address?.trim();
      if (!trimmed) return textResult("A sender address is required.");

      let resolved: { info: UnsubscribeInfo; oneClickUrl?: string };
      try {
        resolved = await resolveAccountUnsubscribe(trimmed, account);
      } catch (error) {
        return textResult(
          `Could not look up unsubscribe options for ${trimmed}: ${errorMessage(error)}`,
        );
      }

      if (resolved.info.state !== "one_click" || !resolved.oneClickUrl) {
        return textResult(describeNotPossible(trimmed, resolved.info));
      }

      const result = await executeAndMarkUnsubscribe(trimmed, resolved.oneClickUrl);
      return textResult(
        result.ok
          ? `Unsubscribe requested for ${trimmed} on ${account.name}.`
          : `Unsubscribe request for ${trimmed} failed: ${result.error ?? "unknown error"}.`,
      );
    },
  });
}

function describeNotPossible(address: string, info: UnsubscribeInfo): string {
  switch (info.state) {
    case "browse":
      return `${address} has no one-click unsubscribe — only a browse link (${info.browseUrl}), which needs a human to open it.`;
    case "mailto_only":
      return `${address} only supports unsubscribing by sending an email — this cannot be automated.`;
    case "unknown":
      return `Unsubscribe information for ${address} could not be determined.`;
    default:
      return `No unsubscribe link is known for ${address}.`;
  }
}
