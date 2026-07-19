import type { ConnectedAccount } from "@trailin/shared";
import { and, eq } from "drizzle-orm";
import { moduleLogger } from "../../core/logger.js";
import { JobLoop } from "../../core/utils/jobs.js";
import { db, schema } from "../../db/index.js";
import { getSetting, setSetting } from "../../db/settings.js";
import { getMailReadProvider, type MailReadProvider } from "../../email/read/readProviders.js";
import { listAccounts } from "../../integrations/pipedream/connect.js";
import type { RunTrigger } from "./runRecorder.js";
import { requestRun } from "./scheduler.js";

const log = moduleLogger("mailProbe");

/** Poll cadence. Tunable: each tick costs 1–2 proxied calls per connected account. */
const PROBE_INTERVAL_MS = 5 * 60_000;

const CURSORS_SETTING_KEY = "mailProbe.cursors";

type ProbeCursors = Record<string, { id: string; date: string }>;

async function loadCursors(): Promise<ProbeCursors> {
  const raw = await getSetting(CURSORS_SETTING_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as ProbeCursors;
  } catch {
    return {};
  }
}

export interface MailProbeDeps {
  readerFor?: (app: string) => MailReadProvider | null;
  listAccounts?: () => Promise<ConnectedAccount[]>;
  requestRun?: (automationId: string, trigger?: RunTrigger) => Promise<void>;
}

/**
 * One probe pass. A first-seen account (no stored cursor) seeds silently, so a
 * fresh boot or newly connected account never fires a run storm over mail
 * already there. A changed newest-id is new mail only when its date is strictly
 * newer: archiving or deleting the newest message also changes the id, but
 * backwards in time.
 */
export async function probeOnce(deps: MailProbeDeps = {}): Promise<void> {
  const flagged = await db
    .select({ id: schema.automations.id })
    .from(schema.automations)
    .where(and(eq(schema.automations.runOnNewMail, true), eq(schema.automations.enabled, true)));
  if (flagged.length === 0) return;

  const readerFor = deps.readerFor ?? getMailReadProvider;
  const accounts = await (deps.listAccounts ?? listAccounts)();
  const cursors = await loadCursors();
  const next: ProbeCursors = {};
  const newMailAccounts: string[] = [];

  for (const account of accounts) {
    const provider = readerFor(account.app);
    if (!provider) continue;
    const cursor = cursors[account.id];

    let observed: { id: string; date: string | null } | null;
    try {
      observed = await provider.newestInbound(account, { knownId: cursor?.id });
    } catch (error) {
      log.warn(
        { err: error, accountId: account.id, app: account.app },
        "inbox probe failed — keeping this account's cursor until the next tick",
      );
      if (cursor) next[account.id] = cursor;
      continue;
    }

    if (!observed) {
      if (cursor) next[account.id] = cursor;
      continue;
    }
    if (!cursor) {
      next[account.id] = { id: observed.id, date: observed.date ?? new Date().toISOString() };
      continue;
    }
    if (observed.id === cursor.id) {
      next[account.id] = cursor;
      continue;
    }
    if (observed.date !== null && observed.date > cursor.date) newMailAccounts.push(account.name);
    next[account.id] = { id: observed.id, date: observed.date ?? cursor.date };
  }

  await setSetting(CURSORS_SETTING_KEY, JSON.stringify(next));

  if (newMailAccounts.length === 0) return;
  const run = deps.requestRun ?? requestRun;
  for (const automation of flagged) {
    // One request per automation per burst; requestRun coalesces the rest.
    run(automation.id, { kind: "mail", accountNames: newMailAccounts }).catch((error: unknown) =>
      log.error({ err: error, automationId: automation.id }, "new-mail run failed"),
    );
  }
}

const loop = new JobLoop({
  name: "mail-probe",
  run: () => probeOnce(),
  intervalMs: PROBE_INTERVAL_MS,
});

export function startMailProbe(): void {
  loop.start();
}

export function stopMailProbe(): void {
  loop.stop();
}
