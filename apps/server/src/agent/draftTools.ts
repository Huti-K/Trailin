import type { AgentTool } from "@earendil-works/pi-agent-core";
import { errorMessage } from "../core/utils/util.js";
import { listDraftsCached } from "../email/draftsCache.js";
import { getDraftProvider } from "../email/providers.js";
import { numberedList, textResult, tool } from "./toolkit.js";

/** Live from each account's provider (draftsCache.ts), not a local store. In every session: listing drafts never dispatches mail. */

export const listDraftsTool: AgentTool = tool({
  name: "list_drafts",
  label: "List drafts",
  description:
    `List the unsent drafts currently sitting in each connected account's Drafts folder ` +
    `(live from the provider, briefly cached) — subject, recipients, date, snippet, and the ` +
    `draft's threadId when it replies to a conversation. Use it to review what is drafted ` +
    `but not sent; the user sends drafts themselves from their mail client or from Home.`,
  account: "optional",
  accountDescription: "Optional: list only this connected account (email address or id).",
  params: {},
  execute: async (_params, { account, accounts }) => {
    const targets = (account ? [account] : accounts).filter(
      (a) => getDraftProvider(a.app) !== null,
    );
    if (targets.length === 0) {
      return textResult(
        account
          ? `${account.name} has no drafts support.`
          : "No connected account supports drafts.",
      );
    }

    const sections = await Promise.all(
      targets.map(async (a) => {
        try {
          const drafts = await listDraftsCached(a);
          if (drafts.length === 0) return `${a.name}: no drafts.`;
          const lines = numberedList(
            drafts.map((d) => ({
              head: `${d.subject || "(no subject)"} — to ${d.to || "(no recipients)"}, ${d.date}`,
              body: [
                d.snippet ?? "",
                `draftId: ${d.id}${d.threadId ? ` | threadId: ${d.threadId}` : ""}`,
              ],
            })),
          );
          return `${a.name}:\n${lines}`;
        } catch (error) {
          return `${a.name}: listing drafts failed (${errorMessage(error)}).`;
        }
      }),
    );
    return textResult(sections.join("\n\n"));
  },
});
