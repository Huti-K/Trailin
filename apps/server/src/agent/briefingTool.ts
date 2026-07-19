import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { BriefingItem, BriefingRollup, CardAccount, ConnectedAccount } from "@trailin/shared";
import { errorMessage, isNonEmptyString, isRecord } from "../core/utils/util.js";
import { threadWebUrl } from "../email/webLinks.js";
import { listAccounts } from "../integrations/pipedream/connect.js";
import { findAccount } from "./accounts.js";
import {
  buildBriefingCard,
  cardNote,
  coerceBriefingItem,
  coerceBriefingRollup,
  toCardAccount,
} from "./cards.js";
import { textResult, tool } from "./toolkit.js";

const BRIEFING_CARD_NOTE = cardNote(
  "this briefing",
  "Do not repeat the items in prose — close with exactly one line naming what needs them " +
    'first, or "Quiet otherwise — nothing urgent" if nothing does.',
);

const PRIORITY_DESCRIPTION =
  '"urgent" when it is time-sensitive, a deadline could pass, or the user is blocked on it. ' +
  '"reply" when a real person is waiting on a reply but nothing is on fire. "action" when it ' +
  'needs a decision or task from the user and nobody is waiting. "fyi" when it is worth ' +
  "knowing and needs nothing.";

/**
 * Shared by the tier `items` and each rollup group's `items`. Every field is
 * optional and unknown-valued on purpose: coerceBriefingItem is the real
 * validator (dropping entries missing required fields), so the schema only
 * describes the shape to the model rather than rejecting the whole call over
 * one bad entry.
 */
const briefingItemParam = Type.Object({
  threadId: Type.Optional(
    Type.Unknown({
      description:
        "The thread id from the search results, so the card's row actions (open thread, etc.) work.",
    }),
  ),
  messageId: Type.Optional(Type.Unknown({ description: "The specific message's id, if known." })),
  account: Type.Optional(
    Type.Unknown({
      description: "The connected account this arrived in — its email address or account id.",
    }),
  ),
  sender: Type.Optional(
    Type.Unknown({ description: 'Display name of the sender, e.g. "Ayşe Kaya".' }),
  ),
  senderEmail: Type.Optional(
    Type.Unknown({ description: "The sender's email address, if known." }),
  ),
  subject: Type.Optional(Type.Unknown({ description: "The message subject." })),
  gist: Type.Optional(
    Type.Unknown({
      description:
        'One line, never a sentence: "topic: key fact → action" when it needs the ' +
        'user (urgent/reply/action) — e.g. "contract: signs Fri, wants payment terms ' +
        'fixed → reply" — or just "event" for fyi — e.g. "Hosting invoice paid ' +
        '(€12,40)". State the fact and the action tersely; no explanation prose (never ' +
        '"Anna replied regarding the contract, mentioning that she plans to sign on ' +
        'Friday but wants the payment terms adjusted first").',
    }),
  ),
  priority: Type.Optional(Type.Unknown({ description: PRIORITY_DESCRIPTION })),
  deadline: Type.Optional(
    Type.Unknown({
      description: 'When it must be answered by, in the sender\'s own terms, e.g. "Friday 17:00".',
    }),
  ),
  receivedAt: Type.Optional(Type.Unknown({ description: "When the message was received." })),
  draftId: Type.Optional(
    Type.Unknown({ description: "Set when this run saved a reply draft for the thread." }),
  ),
});

export const composeBriefingTool: AgentTool = tool({
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
  params: {
    headline: Type.Optional(
      Type.Unknown({
        description: 'One line on where the user stands, e.g. "Two things need you today".',
      }),
    ),
    periodLabel: Type.Optional(
      Type.Unknown({
        description: 'The window reviewed, in plain words, e.g. "since yesterday morning".',
      }),
    ),
    scanned: Type.Optional(
      Type.Unknown({ description: "Total messages reviewed, including the ones rolled up." }),
    ),
    items: Type.Array(briefingItemParam, {
      description: "Every noteworthy message, flat across accounts — the UI groups by priority.",
    }),
    rollups: Type.Optional(
      Type.Array(
        Type.Object({
          label: Type.Optional(
            Type.Unknown({
              description:
                'The kind of mail in this group, e.g. "Newsletters", "Receipts", ' +
                '"Promotions", "Notifications".',
            }),
          ),
          items: Type.Array(briefingItemParam, {
            description:
              "Every message in this group, listed individually — same shape as a tier item " +
              "(real threadId, account, sender, subject, one-line gist), so each renders as its " +
              "own actionable row under the group heading. Draw the gist from the list_threads " +
              "line; don't full-read these just to roll them up.",
          }),
        }),
        {
          description:
            "Low-value mail (newsletters, receipts, shipping updates, notifications) grouped by " +
            "kind but still listed message by message, not collapsed to a count.",
        },
      ),
    ),
  },
  execute: async ({
    headline: rawHeadline,
    periodLabel: rawPeriodLabel,
    scanned: rawScanned,
    items: rawItems,
    rollups: rawRollups = [],
  }) => {
    try {
      const accounts = await listAccounts();

      const resolveAccount = (value: unknown): ConnectedAccount | undefined => {
        if (!isNonEmptyString(value)) return undefined;
        return findAccount(accounts, value);
      };

      // The account and webmail deep link are server-resolved, never a
      // model-supplied URL.
      const resolveItem = (raw: unknown): BriefingItem | undefined => {
        if (!isRecord(raw)) return undefined;
        const account = resolveAccount(raw.account);
        const webUrl =
          account && isNonEmptyString(raw.threadId)
            ? threadWebUrl(account, raw.threadId) || undefined
            : undefined;
        return coerceBriefingItem(raw, account?.id, webUrl);
      };

      const items: BriefingItem[] = [];
      for (const raw of rawItems) {
        const item = resolveItem(raw);
        if (item) items.push(item);
      }

      const rollups: BriefingRollup[] = [];
      for (const raw of rawRollups) {
        if (!isRecord(raw)) continue;
        const rollupItems: BriefingItem[] = [];
        for (const rawItem of Array.isArray(raw.items) ? raw.items : []) {
          const item = resolveItem(rawItem);
          if (item) rollupItems.push(item);
        }
        const rollup = coerceBriefingRollup(raw, rollupItems);
        if (rollup) rollups.push(rollup);
      }

      const accountLookup = new Map<string, ConnectedAccount>(accounts.map((a) => [a.id, a]));
      const allItems = [...items, ...rollups.flatMap((r) => r.items)];
      const seenAccountIds = new Set(allItems.flatMap((i) => (i.accountId ? [i.accountId] : [])));
      const cardAccounts: CardAccount[] = [...seenAccountIds]
        .map((id) => accountLookup.get(id))
        .filter((a): a is ConnectedAccount => a !== undefined)
        .map(toCardAccount);

      const headline = isNonEmptyString(rawHeadline) ? rawHeadline : undefined;
      const periodLabel = isNonEmptyString(rawPeriodLabel) ? rawPeriodLabel : undefined;
      const scanned =
        typeof rawScanned === "number" && Number.isFinite(rawScanned) ? rawScanned : undefined;

      const card = buildBriefingCard({
        headline,
        periodLabel,
        accounts: cardAccounts,
        items,
        rollups,
        scanned,
      });

      const urgentCount = items.filter((i) => i.priority === "urgent").length;
      const awaitingReplyCount = items.filter((i) => i.priority === "reply").length;
      const rolledUpCount = rollups.reduce((sum, r) => sum + r.items.length, 0);
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
      if (rolledUpCount > 0)
        summaryParts.push(`${rolledUpCount} message${rolledUpCount === 1 ? "" : "s"} rolled up`);
      if (draftedCount > 0)
        summaryParts.push(`${draftedCount} draft${draftedCount === 1 ? "" : "s"} linked`);

      // Tell the model what got dropped: a missing threadId is what breaks the row actions.
      const dropped = rawItems.length - items.length;
      if (dropped > 0) {
        summaryParts.push(
          `${dropped} item${dropped === 1 ? "" : "s"} dropped for a missing threadId, sender, ` +
            `subject or gist`,
        );
      }

      return textResult(`${summaryParts.join(", ")}.${BRIEFING_CARD_NOTE}`, card);
    } catch (error) {
      return textResult(`Could not compose the briefing: ${errorMessage(error)}`);
    }
  },
});
