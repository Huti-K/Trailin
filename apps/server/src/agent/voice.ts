import type { AccountVoice } from "@trailin/shared";
import { getAccountVoices } from "../db/settings.js";
import { listAccounts } from "../pipedream/connect.js";

/**
 * Per-inbox signature: applied mechanically by the create-draft tool (see
 * email/gmailDrafts.ts) and, when configured, called out in the agent's
 * system prompt so it never writes one itself (see buildVoiceContext below).
 * Writing style is NOT part of AccountVoice anymore — it lives as
 * account-scoped long-term memories instead (learned from sent mail or
 * written by the user) and reaches the agent through
 * knowledgeTools.ts's buildKnowledgeContext. Kept in its own module,
 * mirroring buildKnowledgeContext, so the system-prompt section and the
 * tool-side lookup share one source of truth.
 */

/** Convenience lookup for one account's voice, or undefined if none is set. */
export async function getVoiceFor(accountId: string): Promise<AccountVoice | undefined> {
  const voices = await getAccountVoices();
  return voices.find((v) => v.accountId === accountId);
}

/**
 * The dynamic system-prompt section listing every account with a signature
 * configured. Returns "" when no account has one set.
 */
export async function buildVoiceContext(): Promise<string> {
  const voices = await getAccountVoices();
  const withSignature = voices.filter((v) => v.signature?.trim());
  if (withSignature.length === 0) return "";

  // Best-effort account names — fall back to the raw id so a Pipedream outage
  // never hides the voice instructions, it just makes them less readable.
  let names = new Map<string, string>();
  try {
    names = new Map((await listAccounts()).map((a) => [a.id, a.name]));
  } catch {
    // fall through with an empty map — accountId is used below instead
  }

  const lines = withSignature.map((v) => {
    const name = names.get(v.accountId) ?? v.accountId;
    return (
      `- ${name}: a signature is configured for this account and is appended automatically ` +
      `by the create-draft tool — never write one yourself.`
    );
  });

  return `\n\nPer-inbox signatures (set by the user in Settings):\n${lines.join("\n")}`;
}
