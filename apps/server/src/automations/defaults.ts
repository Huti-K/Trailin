import { randomUUID } from "node:crypto";
import { db, schema } from "../db/index.js";
import { getSetting, setSetting } from "../db/settings.js";

/**
 * Built-in automations a fresh install ships with. Once seeded, the user owns
 * their copies outright — edit, disable, rename or delete them like any other.
 * The text below is the verbatim source of truth; see seedDefaultAutomations
 * for when it is applied.
 */
interface DefaultAutomation {
  name: string;
  schedule: string;
  enabled: boolean;
  showInActivity: boolean;
  instruction: string;
}

const DEFAULT_AUTOMATIONS: DefaultAutomation[] = [
  {
    name: `Morning briefing`,
    schedule: "0 8 * * *",
    enabled: true,
    showInActivity: true,
    instruction: `Across all connected email accounts, review the messages received since yesterday (roughly the last 24 hours), then do two things.

SUMMARY — Produce a concise, skimmable digest. Group by account if more than one is connected. Use one line per noteworthy message: \`sender — subject — one-sentence gist\`. Flag anything urgent, time-sensitive, or awaiting my reply. Roll up low-value newsletter/promotional/receipt mail into a single count rather than listing each.

DRAFTS (only where it genuinely makes sense) — For threads that actually warrant a reply from me, ACTUALLY CREATE THE DRAFT by calling the gmail-create-draft tool so a real unsent draft is saved to my Drafts folder — do not merely write the draft text in your report. Attach it to the original thread by passing the thread's threadId from the find/search results so it threads correctly. A reply is warranted when a real person is asking me something, is awaiting my response, or the thread needs an action or acknowledgement from me. Do NOT draft for newsletters, marketing/promotions, receipts, shipping/order updates, calendar invites, automated or no-reply notifications, or threads I have already answered — when in doubt, skip it. Write each draft concisely, in my usual tone, and in the same language as the email it replies to. Never send, reply, forward, label, or delete anything — only save drafts for me to review.

REPORT — Finish with (1) the digest and (2) a list of every draft you actually created (each as \`recipient — subject — one-line summary\`), and briefly note anything borderline you chose to skip. If you created no drafts, say so.`,
  },
  {
    name: `End-of-day learnings`,
    schedule: "0 19 * * *",
    enabled: true,
    showInActivity: false,
    instruction: `Review today's outgoing email so you can learn how I actually communicate, and save durable learnings to long-term memory so future drafts match my style and decisions. This run is review-only — do not create drafts or send, label, or modify any email.

GATHER — Using Gmail search, look at (a) messages I sent today (\`in:sent newer_than:1d\`) and (b) drafts still sitting in my Drafts folder (\`in:drafts\`). Read the relevant ones.

COMPARE — Where something I sent corresponds to a draft you (Trailin) had prepared earlier, compare them. The edits I made before sending are the strongest signal — they reveal my real preferences (tone, length, greeting and sign-off, formality, what I add or cut, factual corrections). Note what changed.

EXTRACT — Pull out durable, GENERAL patterns that will apply to future emails, not one-off details about a single thread. Good learnings look like: 'Signs off to colleagues with "Beste Grüße", but "Best" in English', 'Keeps replies to 2–3 sentences', 'Prefers to propose specific times rather than ask for availability'. Skip transient facts and anything already in memory.

SAVE — Call memory_save once per learning, each a single clear, self-contained sentence. If a learning refines or contradicts an existing memory, use memory_update on that entry instead of adding a near-duplicate. Do not fill memory with trivia.

REPORT — Summarize what you reviewed, the notable draft-vs-sent differences, and exactly which memories you saved or updated.`,
  },
];

const DEFAULTS_SEEDED_KEY = "automations.defaultsSeeded";

/**
 * Seed the built-in automations on first run. Idempotent and conservative:
 *  - runs its body at most once ever, guarded by a settings flag;
 *  - only populates a brand-new (empty) automations table, so an existing
 *    install upgrading to this version is left untouched — just marked seeded
 *    so no duplicates are ever injected;
 *  - because the flag persists, deleting a default does not bring it back on
 *    the next restart.
 * Call this before startScheduler() so seeded defaults get scheduled on boot.
 */
export async function seedDefaultAutomations(): Promise<void> {
  if ((await getSetting(DEFAULTS_SEEDED_KEY)) === "true") return;

  const [existing] = await db
    .select({ id: schema.automations.id })
    .from(schema.automations)
    .limit(1);

  if (!existing) {
    const now = Date.now();
    await db.insert(schema.automations).values(
      DEFAULT_AUTOMATIONS.map((a, i) => ({
        id: randomUUID(),
        name: a.name,
        instruction: a.instruction,
        schedule: a.schedule,
        enabled: a.enabled,
        showInActivity: a.showInActivity,
        // Distinct, descending timestamps so the list order is deterministic:
        // the first entry is newest and thus leads the createdAt-desc feed.
        createdAt: new Date(now - i * 1000).toISOString(),
      })),
    );
    console.log(`[automations] seeded ${DEFAULT_AUTOMATIONS.length} default automation(s)`);
  }

  await setSetting(DEFAULTS_SEEDED_KEY, "true");
}
