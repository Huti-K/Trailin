import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { ChoiceOption, ConnectedAccount, EmailRef } from "@trailin/shared";
import { isNonEmptyString } from "../core/utils/util.js";
import { listAccounts } from "../integrations/pipedream/connect.js";
import { findAccount } from "./accounts.js";
import { buildChoicesCard, cardNote, coerceChoiceOption } from "./cards.js";
import { textResult, tool } from "./toolkit.js";

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 6;

const CHOICES_CARD_NOTE = cardNote(
  "these choices",
  "End your turn with a short question restating what you need — the user's pick arrives as " +
    "their next message. Do not act until then.",
);

function buildRef(
  threadId: string | undefined,
  resolvedAccount: ConnectedAccount | undefined,
): EmailRef | undefined {
  if (!threadId || !resolvedAccount) return undefined;
  return { threadId, accountId: resolvedAccount.id, accountName: resolvedAccount.name };
}

export const presentChoicesTool: AgentTool = tool({
  name: "present_choices",
  label: "Ask the user to choose",
  description:
    `Use when more than one email, account or draft plausibly matches an action the user asked ` +
    `for (drafting, sending, labeling, deleting) and their message doesn't settle which one. ` +
    `Renders clickable buttons; the user's pick arrives as their next message in this same ` +
    `conversation. After calling this, end your turn with a short question restating what you ` +
    `need — do not act until the user replies. Do NOT use this when only one match is clear, or ` +
    `for pure read/summarize questions.`,
  params: {
    question: Type.String({
      description: 'What you need the user to decide, e.g. "Which email do you mean?".',
    }),
    // Validated by hand below (label presence, count bounds) not via schema
    // constraints, so a bad option reaches that logic instead of bouncing as
    // "Invalid parameters".
    options: Type.Array(
      Type.Object({
        label: Type.Optional(
          Type.Unknown({
            description: 'Short button text, e.g. an account address or "Ayşe — Friday deadline".',
          }),
        ),
        detail: Type.Optional(
          Type.Unknown({ description: "One-line supporting detail (subject, date, account)." }),
        ),
        reply: Type.Optional(
          Type.Unknown({
            description: "Full-sentence reply sent when this option is picked; defaults to label.",
          }),
        ),
        threadId: Type.Optional(
          Type.Unknown({
            description: "Provider thread id this option refers to, if it names one.",
          }),
        ),
        account: Type.Optional(
          Type.Unknown({
            description: "The connected account this option refers to — email address or id.",
          }),
        ),
      }),
      {
        description: `Between ${MIN_OPTIONS} and ${MAX_OPTIONS} choices for the user to pick from.`,
      },
    ),
  },
  execute: async ({ question, options: rawOptions }) => {
    if (!isNonEmptyString(question)) {
      return textResult("present_choices needs a non-empty question.");
    }
    if (!Array.isArray(rawOptions) || rawOptions.length < MIN_OPTIONS) {
      return textResult(`present_choices needs at least ${MIN_OPTIONS} options.`);
    }
    if (rawOptions.length > MAX_OPTIONS) {
      return textResult(`present_choices takes at most ${MAX_OPTIONS} options.`);
    }
    const withLabels = rawOptions.filter((o) => isNonEmptyString(o.label));
    if (withLabels.length < MIN_OPTIONS) {
      return textResult(`present_choices needs at least ${MIN_OPTIONS} options with a label.`);
    }

    const accounts = await listAccounts();
    const options = withLabels
      .map((raw) => {
        const resolvedAccount = isNonEmptyString(raw.account)
          ? findAccount(accounts, raw.account)
          : undefined;
        const threadId = isNonEmptyString(raw.threadId) ? raw.threadId : undefined;
        const ref = buildRef(threadId, resolvedAccount);
        return coerceChoiceOption(raw, ref);
      })
      .filter((o): o is ChoiceOption => o !== undefined);

    const card = buildChoicesCard(question, options);
    const labels = options.map((o) => o.label).join(", ");
    return textResult(
      `Presented ${options.length} choices to the user: ${labels}.${CHOICES_CARD_NOTE}`,
      card,
    );
  },
});
