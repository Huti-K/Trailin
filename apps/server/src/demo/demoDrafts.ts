import { randomUUID } from "node:crypto";
import type { ConnectedAccount, EmailDraft, EmailThreadMessage } from "@trailin/shared";
import { getDemoDraftStore, setDemoDraftStore, type DemoDraftRecord } from "../db/settings.js";
import { invalidateDraftsCache } from "../email/draftsService.js";
import { gmailDraftUrl } from "../email/webLinks.js";
import type {
  CreateDraftInput,
  CreateDraftResult,
  DraftProvider,
  UpdateDraftPatch,
} from "../email/providers.js";
import { snippetFrom } from "../email/textUtils.js";
import { emitServerEvent } from "../events.js";
import { daysAgo } from "./content.js";
import { MAILBOX, resolveThread } from "./mailbox.js";

/**
 * Demo DraftProvider: drafts live in the persisted demo draft store
 * (db/settings.ts, seeded by demo/seed.ts) and threads come from the seeded
 * MAILBOX — no live API anywhere. In demo mode
 * ../email/registerProviders.ts registers this provider over every email app
 * LAST, replacing the real gmail/outlook drivers, exactly like
 * demo/demoSync.ts's provider for SyncProvider. That registry swap is the
 * whole demo mechanism — the real provider files carry no demo branches.
 *
 * Demo accounts all present as Gmail (demo/accounts.ts), so draft deep links
 * use gmailDraftUrl.
 */

async function listDemoDrafts(account: ConnectedAccount, limit = 15): Promise<EmailDraft[]> {
  const store = await getDemoDraftStore();
  return (store[account.id] ?? [])
    .map(({ body, cc: _cc, bcc: _bcc, ...draft }) => {
      const snippet = snippetFrom(body);
      return { ...draft, ...(snippet ? { snippet } : {}) };
    })
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, limit);
}

async function getDemoDraftDetail(
  account: ConnectedAccount,
  draftId: string,
): Promise<{ body: string; cc: string; bcc: string }> {
  const store = await getDemoDraftStore();
  const record = (store[account.id] ?? []).find((d) => d.id === draftId);
  if (!record) throw new Error("draft not found");
  return { body: record.body, cc: record.cc ?? "", bcc: record.bcc ?? "" };
}

async function createDemoDraft(
  account: ConnectedAccount,
  input: CreateDraftInput,
): Promise<CreateDraftResult> {
  const messageId = randomUUID().replace(/-/g, "");
  const threadId = input.threadId ?? randomUUID().replace(/-/g, "");
  const record: DemoDraftRecord = {
    id: randomUUID(),
    messageId,
    threadId,
    subject: input.subject,
    to: input.to.join(", "),
    ...(input.cc?.length ? { cc: input.cc.join(", ") } : {}),
    ...(input.bcc?.length ? { bcc: input.bcc.join(", ") } : {}),
    date: new Date().toISOString(),
    webUrl: gmailDraftUrl(account.name, messageId),
    body: input.body,
  };
  const store = await getDemoDraftStore();
  store[account.id] = [record, ...(store[account.id] ?? [])];
  await setDemoDraftStore(store);
  invalidateDraftsCache(account.id);
  emitServerEvent("drafts");
  return { draftId: record.id, messageId, threadId, webUrl: record.webUrl };
}

async function deleteDemoDraft(account: ConnectedAccount, draftId: string): Promise<void> {
  const store = await getDemoDraftStore();
  store[account.id] = (store[account.id] ?? []).filter((d) => d.id !== draftId);
  await setDemoDraftStore(store);
  invalidateDraftsCache(account.id);
  emitServerEvent("drafts");
}

async function updateDemoDraft(
  account: ConnectedAccount,
  draftId: string,
  patch: UpdateDraftPatch,
): Promise<void> {
  const store = await getDemoDraftStore();
  const record = (store[account.id] ?? []).find((d) => d.id === draftId);
  if (!record) throw new Error("draft not found");
  if (patch.body !== undefined) record.body = patch.body;
  if (patch.subject !== undefined) record.subject = patch.subject;
  await setDemoDraftStore(store);
  invalidateDraftsCache(account.id);
  emitServerEvent("drafts");
}

/**
 * Reads the seeded MAILBOX exactly the way demo/emailTools.ts's
 * gmail-get-thread tool does (same resolveThread lookup, same oldest-first
 * message order), so a draft opened from the demo UI links to the same
 * thread content the agent would have read. A draft that starts a new
 * conversation has a threadId no mailbox thread matches — that is "no
 * history", not an error; seeded demo drafts are all of this shape.
 * excludeMessageId is irrelevant here: demo drafts never appear as messages
 * of their MAILBOX thread.
 */
async function getDemoThread(
  account: ConnectedAccount,
  threadId: string,
  _opts: { excludeMessageId?: string } = {},
): Promise<EmailThreadMessage[]> {
  const threads = MAILBOX.filter((t) => t.accountId === account.id);
  const thread = resolveThread(threads, threadId);
  if (!thread) return [];
  return thread.messages.map((message) => ({
    from: message.from,
    to: message.to,
    ...(message.cc?.length ? { cc: message.cc } : {}),
    date: daysAgo(message.daysAgo, message.hour, message.minute ?? 0).toISOString(),
    body: message.body,
  }));
}

/** This module's DraftProvider — registered (demo mode only) by ../email/registerProviders.ts. */
export const demoDraftProvider: DraftProvider = {
  listDrafts: listDemoDrafts,
  getDraftDetail: getDemoDraftDetail,
  createDraft: createDemoDraft,
  deleteDraft: deleteDemoDraft,
  updateDraft: updateDemoDraft,
  getThread: getDemoThread,
};
