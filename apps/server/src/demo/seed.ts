import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgentCard, MessageCard } from "@trailin/shared";
import { toCardAccount } from "../agent/cards.js";
import { seedDefaultAutomations } from "../automations/defaults.js";
import { db, schema } from "../db/index.js";
import { moduleLogger } from "../logger.js";
import {
  getSetting,
  LIBRARY_FOLDER_SETTING_KEY,
  setAccountColors,
  setAccountVoices,
  setDemoDraftStore,
  setSetting,
  type DemoDraftRecord,
  type DemoDraftStore,
} from "../db/settings.js";
import { gmailDraftUrl } from "../email/webLinks.js";
import { DEMO_PERSONAL_ACCOUNT_ID, DEMO_UNI_ACCOUNT_ID, DEMO_WORK_ACCOUNT_ID, getDemoAccounts } from "./accounts.js";
import {
  buildEveningResult,
  buildMorningResult,
  CHATS,
  DAY_PLAN,
  daysAgo,
  DRAFTS,
  EVENING_ERROR_TEXT,
  LIBRARY_DOCS,
  MEMORIES,
  MORNING_ERROR_TEXT,
} from "./content.js";

/**
 * Populates the demo database with 20 days of realistic history — automation
 * runs, drafts, chats, memories, library docs — so demo mode has volume to
 * stress-test the UI with, without ever touching a real mailbox. Idempotent:
 * runs at most once per demo.db (deleting demo.db forces a fresh reseed).
 */

const log = moduleLogger("demo");

const DEMO_SEEDED_KEY = "demo.seeded";
const MORNING_NAME = "Morning briefing";
const EVENING_NAME = "End-of-day learnings";

/**
 * Writes one automation_runs row plus its mirrored conversation + user/
 * assistant messages — the same shape automations/scheduler.ts's
 * runAutomation() writes for a live run (kept as a local helper rather than
 * an export from scheduler.ts to avoid touching that actively-changing file
 * for a dev-only seeding path).
 */
async function insertRun(opts: {
  automationId: string;
  automationName: string;
  instruction: string;
  startedAt: Date;
  finishedAt: Date;
  status: "success" | "error";
  result: string;
}): Promise<void> {
  const runId = randomUUID();
  await db.insert(schema.automationRuns).values({
    id: runId,
    automationId: opts.automationId,
    status: opts.status,
    result: opts.result,
    startedAt: opts.startedAt.toISOString(),
    finishedAt: opts.finishedAt.toISOString(),
  });
  await db.insert(schema.conversations).values({
    id: runId,
    title: `Run: ${opts.automationName}`,
    type: "automation",
    createdAt: opts.startedAt.toISOString(),
  });
  const instructionMessage = `Scheduled automation "${opts.automationName}". Execute this instruction now and report the outcome:\n\n${opts.instruction}`;
  await db.insert(schema.messages).values([
    {
      id: randomUUID(),
      conversationId: runId,
      role: "user",
      content: instructionMessage,
      createdAt: opts.startedAt.toISOString(),
    },
    {
      id: randomUUID(),
      conversationId: runId,
      role: "assistant",
      content: opts.result,
      createdAt: opts.finishedAt.toISOString(),
    },
  ]);
}

/** ~40 runs across the last 20 days, per the DAY_PLAN schedule in content.ts. */
async function seedRuns(): Promise<void> {
  const automations = await db.select().from(schema.automations);
  const morning = automations.find((a) => a.name === MORNING_NAME);
  const evening = automations.find((a) => a.name === EVENING_NAME);
  if (!morning || !evening) {
    log.warn("default automations not found — skipping seeded run history");
    return;
  }

  for (const plan of DAY_PLAN) {
    if (plan.morning !== "skip") {
      const success = plan.morning === "success";
      const startedAt = daysAgo(plan.daysAgo, 8, 5);
      const finishedAt = new Date(startedAt.getTime() + (success ? 95_000 : 28_000));
      await insertRun({
        automationId: morning.id,
        automationName: morning.name,
        instruction: morning.instruction,
        startedAt,
        finishedAt,
        status: success ? "success" : "error",
        result: success ? buildMorningResult(plan.daysAgo) : MORNING_ERROR_TEXT[plan.daysAgo]!,
      });
    }
    if (plan.evening !== "skip") {
      const success = plan.evening === "success";
      const startedAt = daysAgo(plan.daysAgo, 19, 10);
      const finishedAt = new Date(startedAt.getTime() + (success ? 60_000 : 18_000));
      await insertRun({
        automationId: evening.id,
        automationName: evening.name,
        instruction: evening.instruction,
        startedAt,
        finishedAt,
        status: success ? "success" : "error",
        result: success ? buildEveningResult(plan.daysAgo) : EVENING_ERROR_TEXT[plan.daysAgo]!,
      });
    }
  }
}

/** A seeded draft a chat can claim as its own (via ChatSeed.draftLinkKey). */
interface SeededDraft {
  record: DemoDraftRecord;
  accountId: string;
}

/**
 * Drafts spread across the 3 fake accounts, written straight into the demo
 * draft store. Returns the records with a linkKey, so seedChats() can link
 * them to the conversation that "wrote" them.
 */
async function seedDrafts(): Promise<Map<string, SeededDraft>> {
  const accountsById = new Map(getDemoAccounts().map((a) => [a.id, a]));
  const store: DemoDraftStore = {};
  const byLinkKey = new Map<string, SeededDraft>();

  for (const draft of DRAFTS) {
    const account = accountsById.get(draft.accountId);
    if (!account) continue;
    const messageId = randomUUID().replace(/-/g, "");
    const record: DemoDraftRecord = {
      id: randomUUID(),
      messageId,
      threadId: draft.threadId ?? randomUUID().replace(/-/g, ""),
      subject: draft.subject,
      to: draft.to,
      cc: draft.cc,
      date: daysAgo(draft.daysAgo, draft.hour, (draft.daysAgo * 11) % 60).toISOString(),
      webUrl: gmailDraftUrl(account.name, messageId),
      body: draft.body,
    };
    const list = store[draft.accountId] ?? [];
    list.push(record);
    store[draft.accountId] = list;
    if (draft.linkKey) byLinkKey.set(draft.linkKey, { record, accountId: draft.accountId });
  }

  await setDemoDraftStore(store);
  return byLinkKey;
}

/**
 * ~18 chat conversations with realistic multi-turn exchanges. A chat with a
 * draftLinkKey gets what a live create-draft turn produces: the draft's card
 * on its last assistant turn, and a draft_links row back to the conversation.
 */
async function seedChats(drafts: Map<string, SeededDraft>): Promise<void> {
  const accountsById = new Map(getDemoAccounts().map((a) => [a.id, a]));

  for (const chat of CHATS) {
    const conversationId = randomUUID();
    const startedAt = daysAgo(chat.daysAgo, chat.hour);

    let cardsJson: string | null = null;
    const linked = chat.draftLinkKey ? drafts.get(chat.draftLinkKey) : undefined;
    const linkedAccount = linked ? accountsById.get(linked.accountId) : undefined;
    if (linked && linkedAccount) {
      const card: AgentCard = {
        kind: "email_draft",
        account: toCardAccount(linkedAccount),
        draft: {
          draftId: linked.record.id,
          threadId: linked.record.threadId,
          subject: linked.record.subject,
          to: linked.record.to.split(", "),
          ...(linked.record.cc ? { cc: linked.record.cc.split(", ") } : {}),
          body: linked.record.body,
          webUrl: linked.record.webUrl,
        },
      };
      const cards: MessageCard[] = [{ toolCallId: `seed-${chat.draftLinkKey}`, card }];
      cardsJson = JSON.stringify(cards);

      await db.insert(schema.draftLinks).values({
        draftId: linked.record.id,
        accountId: linked.accountId,
        conversationId,
        createdAt: startedAt.toISOString(),
      });
    }

    await db.insert(schema.conversations).values({
      id: conversationId,
      title: chat.title,
      type: "chat",
      createdAt: startedAt.toISOString(),
    });
    const lastAssistantIndex = chat.turns.reduce(
      (last, turn, i) => (turn.role === "assistant" ? i : last),
      -1,
    );
    await db.insert(schema.messages).values(
      chat.turns.map((turn, i) => ({
        id: randomUUID(),
        conversationId,
        role: turn.role,
        content: turn.content,
        cards: i === lastAssistantIndex ? cardsJson : null,
        // A few seconds apart per turn, so the conversation reads chronologically.
        createdAt: new Date(startedAt.getTime() + i * 45_000).toISOString(),
      })),
    );
  }
}

// The 3 memories the user states directly (in a chat, see content.ts's CHATS)
// happen at that chat's time of day; the 9 the agent saves during an
// End-of-day learnings run happen shortly after that run finishes.
const MEMORY_HOUR_BY_DAYS_AGO: Record<number, number> = { 17: 9, 14: 11, 9: 15 };

/**
 * 15 long-term memories: 9 agent-saved (evening runs), 3 user-stated (chats),
 * plus 3 agent-saved work-account style directives (a past voice-learn run).
 */
async function seedMemories(): Promise<void> {
  const rows = MEMORIES.map((m) => {
    const hour = MEMORY_HOUR_BY_DAYS_AGO[m.daysAgo] ?? 19;
    const minute = MEMORY_HOUR_BY_DAYS_AGO[m.daysAgo] ? 5 : 40;
    const createdAt = daysAgo(m.daysAgo, hour, minute).toISOString();
    return {
      id: randomUUID(),
      content: m.content,
      source: m.source,
      accountId: m.accountId ?? null,
      createdAt,
      updatedAt: createdAt,
    };
  });
  await db.insert(schema.memories).values(rows);
}

/** ~12 library documents, written to a demo-only drop folder the real ingest pipeline indexes. */
async function seedLibrary(): Promise<void> {
  const dir = resolve(process.cwd(), "data/demo-library");
  await mkdir(dir, { recursive: true });
  await Promise.all(
    LIBRARY_DOCS.map((doc) => writeFile(resolve(dir, doc.filename), doc.content, "utf8")),
  );
  // Points the real library folder setting at the demo folder; startLibrary()
  // (called right after seedDemoData() in index.ts) picks this up and indexes
  // it through the normal extract/chunk/FTS pipeline — nothing demo-specific.
  await setSetting(LIBRARY_FOLDER_SETTING_KEY, dir);
}

/**
 * Signatures for the 3 demo accounts (per-inbox voice feature). The work
 * account's writing style lives as account-scoped memories instead — see
 * seedMemories() / MEMORIES in content.ts.
 */
async function seedVoices(): Promise<void> {
  await setAccountVoices([
    {
      accountId: DEMO_PERSONAL_ACCOUNT_ID,
      signature: "Liebe Grüße\nSelin",
    },
    {
      accountId: DEMO_WORK_ACCOUNT_ID,
      signature:
        "Beste Grüße\nSelin Kaya\nNordwind Studio — Design & Branding\nnordwind-studio.de",
    },
    {
      accountId: DEMO_UNI_ACCOUNT_ID,
      signature: "Viele Grüße\nSelin Kaya\nMatrikel-Nr. 402318, TU Berlin",
    },
  ]);
}

/** Account colors (memory dots, filter chips) for the 3 demo accounts. */
async function seedColors(): Promise<void> {
  await setAccountColors([
    { accountId: DEMO_WORK_ACCOUNT_ID, hex: "#059669" },
    { accountId: DEMO_PERSONAL_ACCOUNT_ID, hex: "#2563eb" },
    { accountId: DEMO_UNI_ACCOUNT_ID, hex: "#7c3aed" },
  ]);
}

export async function seedDemoData(): Promise<void> {
  if ((await getSetting(DEMO_SEEDED_KEY)) === "true") return;

  // Reuse the normal defaults seeder so the two automations (and their
  // instruction text) are identical to a real install's.
  await seedDefaultAutomations();

  await seedRuns();
  const linkableDrafts = await seedDrafts();
  await seedChats(linkableDrafts);
  await seedMemories();
  await seedLibrary();
  await seedVoices();
  await seedColors();

  await setSetting(DEMO_SEEDED_KEY, "true");
  log.info(
    "seeded demo data: automation runs, drafts, chats, memories, library documents, voices, colors",
  );
}
