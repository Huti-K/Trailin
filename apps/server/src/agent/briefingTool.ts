import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  type AgentCard,
  BRIEFING_PRIORITIES,
  type BriefingItem,
  type BriefingRollup,
  type CardAccount,
  type ConnectedAccount,
} from "@trailin/shared";
import { threadWebUrl } from "../email/webLinks.js";
import { listAccounts } from "../pipedream/connect.js";
import { errorMessage, isNonEmptyString, isRecord } from "../util.js";
import { findAccount } from "./accounts.js";
import { coerceBriefingItem, coerceBriefingRollup, toCardAccount } from "./cards.js";
import { defineTool, textResult } from "./toolResult.js";

/**
 * Agent tool that publishes the structured "briefing" AgentCard — a triaged,
 * cross-account inbox digest grouped by how urgently each message needs the
 * user, with per-thread actions (see BriefingItem/BriefingRollup in
 * @trailin/shared for the card contract). The model only knows accounts by
 * email address, not our internal Pipedream account ids, so this tool
 * resolves `account` strings itself and drops what it can't resolve rather
 * than failing the call. Nothing here throws — a malformed argument yields a
 * text error result instead of an unhandled rejection.
 */

const PRIORITY_DESCRIPTION =
  '"urgent" when it is time-sensitive, a deadline could pass, or the user is blocked on it. ' +
  '"reply" when a real person is waiting on a reply but nothing is on fire. "action" when it ' +
  'needs a decision or task from the user and nobody is waiting. "fyi" when it is worth ' +
  "knowing and needs nothing.";

export const composeBriefingTool: AgentTool = defineTool({
  name: "compose_briefing",
  label: "Compose the briefing",
  description:
    `Publish a structured, interactive briefing card for a multi-message inbox digest — ` +
    `grouped by how urgently each message needs the user, with per-thread actions. Call this ` +
    `once, at the end, after triaging every noteworthy message across the accounts reviewed ` +
    `and drafting the replies that are warranted. Give every item its real threadId from the ` +
    `search results so the card's row actions work, and keep every item's gist to one line — ` +
    `see the gist field for the exact shape. The card IS the report: once you call this, don't ` +
    `re-list the items in prose in your final answer.`,
  parameters: {
    type: "object",
    properties: {
      headline: {
        type: "string",
        description: 'One line on where the user stands, e.g. "Two things need you today".',
      },
      periodLabel: {
        type: "string",
        description: 'The window reviewed, in plain words, e.g. "since yesterday morning".',
      },
      scanned: {
        type: "number",
        description: "Total messages reviewed, including the ones rolled up.",
      },
      items: {
        type: "array",
        description: "Every noteworthy message, flat across accounts — the UI groups by priority.",
        items: {
          type: "object",
          properties: {
            threadId: {
              type: "string",
              description:
                "The thread id from the search results, so the card's row actions (open thread, etc.) work.",
            },
            messageId: { type: "string", description: "The specific message's id, if known." },
            account: {
              type: "string",
              description:
                "The connected account this arrived in — its email address or account id.",
            },
            sender: {
              type: "string",
              description: 'Display name of the sender, e.g. "Ayşe Kaya".',
            },
            senderEmail: { type: "string", description: "The sender's email address, if known." },
            subject: { type: "string", description: "The message subject." },
            gist: {
              type: "string",
              description:
                'One line, never a sentence: "topic: key fact → action" when it needs the ' +
                'user (urgent/reply/action) — e.g. "contract: signs Fri, wants payment terms ' +
                'fixed → reply" — or just "event" for fyi — e.g. "Hosting invoice paid ' +
                '(€12,40)". State the fact and the action tersely; no explanation prose (never ' +
                '"Anna replied regarding the contract, mentioning that she plans to sign on ' +
                'Friday but wants the payment terms adjusted first").',
            },
            priority: {
              type: "string",
              enum: [...BRIEFING_PRIORITIES],
              description: PRIORITY_DESCRIPTION,
            },
            deadline: {
              type: "string",
              description:
                'When it must be answered by, in the sender\'s own terms, e.g. "Friday 17:00".',
            },
            receivedAt: { type: "string", description: "When the message was received." },
            draftId: {
              type: "string",
              description: "Set when this run saved a reply draft for the thread.",
            },
          },
          required: ["threadId", "sender", "subject", "gist", "priority"],
        },
      },
      rollups: {
        type: "array",
        description:
          "Low-value mail collapsed to a count instead of listed, e.g. newsletters or receipts.",
        items: {
          type: "object",
          properties: {
            account: {
              type: "string",
              description:
                "The connected account this rollup covers — email address or account id.",
            },
            label: { type: "string", description: 'e.g. "Newsletters", "Receipts", "Promotions".' },
            count: { type: "number", description: "How many messages this rollup covers." },
            examples: {
              type: "array",
              items: { type: "string" },
              description: "A few sender names, to show what was folded away.",
            },
          },
          required: ["label", "count"],
        },
      },
    },
    required: ["items"],
  },
  execute: async (_id, params) => {
    try {
      const input = isRecord(params) ? params : {};
      const accounts = await listAccounts();

      const resolveAccount = (value: unknown): ConnectedAccount | undefined => {
        if (!isNonEmptyString(value)) return undefined;
        return findAccount(accounts, value);
      };
      const resolveAccountId = (value: unknown): string | undefined => resolveAccount(value)?.id;

      // Drop anything coerceBriefingItem/coerceBriefingRollup reject (missing
      // required fields) rather than failing the whole call over one bad
      // entry — the counts below tell the model what it lost.
      const rawItems = Array.isArray(input.items) ? input.items : [];
      const items: BriefingItem[] = [];
      for (const raw of rawItems) {
        if (!isRecord(raw)) continue;
        // Same helper the search sources use (search/sources.ts) to build a
        // hit's webmail deep link — never a model-supplied URL, and "" (an
        // app with no known web UI) normalizes to undefined like there too.
        const account = resolveAccount(raw.account);
        const webUrl =
          account && isNonEmptyString(raw.threadId)
            ? threadWebUrl(account, raw.threadId) || undefined
            : undefined;
        const item = coerceBriefingItem(raw, account?.id, webUrl);
        if (item) items.push(item);
      }

      const rawRollups = Array.isArray(input.rollups) ? input.rollups : [];
      const rollups: BriefingRollup[] = [];
      for (const raw of rawRollups) {
        if (!isRecord(raw)) continue;
        const rollup = coerceBriefingRollup(raw, resolveAccountId(raw.account));
        if (rollup) rollups.push(rollup);
      }

      // The card's `accounts` list credits every connected account that
      // actually appears in the (resolved) items, not every account checked.
      const accountLookup = new Map<string, ConnectedAccount>(accounts.map((a) => [a.id, a]));
      const seenAccountIds = new Set(items.flatMap((i) => (i.accountId ? [i.accountId] : [])));
      const cardAccounts: CardAccount[] = [...seenAccountIds]
        .map((id) => accountLookup.get(id))
        .filter((a): a is ConnectedAccount => a !== undefined)
        .map(toCardAccount);

      const headline = isNonEmptyString(input.headline) ? input.headline : undefined;
      const periodLabel = isNonEmptyString(input.periodLabel) ? input.periodLabel : undefined;
      const scanned =
        typeof input.scanned === "number" && Number.isFinite(input.scanned)
          ? input.scanned
          : undefined;

      const card: AgentCard = {
        kind: "briefing",
        ...(headline ? { headline } : {}),
        ...(periodLabel ? { periodLabel } : {}),
        ...(cardAccounts.length > 0 ? { accounts: cardAccounts } : {}),
        items,
        ...(rollups.length > 0 ? { rollups } : {}),
        ...(scanned !== undefined ? { scanned } : {}),
      };

      const urgentCount = items.filter((i) => i.priority === "urgent").length;
      const awaitingReplyCount = items.filter((i) => i.priority === "reply").length;
      const rolledUpCount = rollups.reduce((sum, r) => sum + r.count, 0);
      const draftedCount = items.filter((i) => i.draftId).length;

      const summaryParts: string[] = [];
      if (items.length === 0) {
        summaryParts.push("Briefing published: no noteworthy items");
      } else {
        const tally = [
          urgentCount > 0 ? `${urgentCount} urgent` : undefined,
          awaitingReplyCount > 0 ? `${awaitingReplyCount} awaiting reply` : undefined,
        ].filter((s): s is string => Boolean(s));
        summaryParts.push(
          `Briefing published: ${items.length} item${items.length === 1 ? "" : "s"}` +
            (tally.length > 0 ? ` (${tally.join(", ")})` : ""),
        );
      }
      if (rolledUpCount > 0) summaryParts.push(`${rolledUpCount} messages rolled up`);
      if (draftedCount > 0)
        summaryParts.push(`${draftedCount} draft${draftedCount === 1 ? "" : "s"} linked`);

      // Items are dropped silently above so one bad entry can't sink the call,
      // but the model still needs to know it sent something unusable — most
      // often a missing threadId, which is exactly what breaks the row actions.
      const dropped = rawItems.length - items.length;
      if (dropped > 0) {
        summaryParts.push(
          `${dropped} item${dropped === 1 ? "" : "s"} dropped for a missing threadId, sender, ` +
            `subject or gist`,
        );
      }

      const confirmation =
        `${summaryParts.join(", ")}. The user is now looking at this card. Do not repeat the ` +
        `items in prose — close with exactly one line naming what needs them first, or "Quiet ` +
        `otherwise — nothing urgent" if nothing does.`;

      return textResult(confirmation, card);
    } catch (error) {
      return textResult(`Could not compose the briefing: ${errorMessage(error)}`);
    }
  },
});
