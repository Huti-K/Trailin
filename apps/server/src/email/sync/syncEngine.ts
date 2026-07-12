import type { ConnectedAccount } from "@trailin/shared";
import { getSyncBackfillDaysSetting } from "../../db/settings.js";
import { env } from "../../env.js";
import { emitServerEvent } from "../../events.js";
import { JobLoop, KeyedJobs, mapWithConcurrency } from "../../jobs.js";
import { logger } from "../../logger.js";
import { listAccounts } from "../../pipedream/connect.js";
import { errorMessage } from "../../util.js";
import { applySyncPage, getSyncState, markSyncStatus, setSyncCursor } from "./mailStore.js";
import {
  getSyncProvider,
  SyncCursorExpiredError,
  type SyncOptions,
  type SyncPage,
} from "./syncProviders.js";
// Side-effect import: populates the SyncProvider registry.
import "./registerSyncProviders.js";

/**
 * The sync engine: polls every connected account's SyncProvider on an
 * interval and streams the resulting pages into the mailbox mirror
 * (mailStore.ts). Fully provider-neutral — it never looks inside a cursor,
 * never names an app, and skips accounts whose app has no sync driver, the
 * same way routes skip accounts without a DraftProvider.
 *
 * Each page is applied and its cursor persisted before the next page is
 * fetched, so a crash or restart resumes mid-backfill instead of starting
 * over. An expired cursor (provider change-feed aged out) resets that one
 * account to a fresh bounded backfill; already-mirrored mail is simply
 * re-upserted. Deletions that happened during the gap are missed until the
 * messages fall out of the backfill window — acceptable for a mirror whose
 * consumers care about recent mail.
 */

/** Hard bound per account per sweep — a runaway provider can't loop forever. */
const MAX_PAGES_PER_SWEEP = 500;

/** How many accounts sync at once — a sweep over many accounts stays bounded. */
const ACCOUNT_CONCURRENCY = 4;

/** Ceiling on the per-account failure backoff, however many times it has failed in a row. */
const MAX_BACKOFF_MS = 60 * 60_000;

const accountJobs = new KeyedJobs();

/**
 * Per-account failure backoff, keyed by account id. Module-scope and
 * in-memory (single process, no persistence needed): a sweep skips an
 * account until `retryAt`, and a success clears its entry so the next
 * failure starts the backoff over from the first step. Only sweep()
 * consults this — a direct syncAccount() call (manual refresh, waiting.ts)
 * always attempts the sync regardless of backoff state.
 */
interface AccountBackoff {
  failures: number;
  retryAt: number;
}
const backoffByAccount = new Map<string, AccountBackoff>();

function recordSyncFailure(accountId: string): AccountBackoff {
  const failures = (backoffByAccount.get(accountId)?.failures ?? 0) + 1;
  const delayMs = Math.min(env.sync.intervalMs * 2 ** failures, MAX_BACKOFF_MS);
  const state: AccountBackoff = { failures, retryAt: Date.now() + delayMs };
  backoffByAccount.set(accountId, state);
  return state;
}

function recordSyncSuccess(accountId: string): void {
  backoffByAccount.delete(accountId);
}

/** Resolved once per run, so every page of one sync sees the same window. */
async function syncOptions(): Promise<SyncOptions> {
  return { backfillDays: await getSyncBackfillDaysSetting(), pageSize: env.sync.pageSize };
}

async function runSync(account: ConnectedAccount): Promise<void> {
  const provider = getSyncProvider(account.app);
  if (!provider) return;

  const options = await syncOptions();
  markSyncStatus(account.id, "syncing");
  let cursor = getSyncState(account.id)?.cursor ?? null;
  let changed = 0;
  // Set once the loop exits by exhausting MAX_PAGES_PER_SWEEP rather than by
  // a page reporting hasMore: false — i.e. there's more backfill waiting.
  let hitPageCap = false;
  try {
    let pages = 0;
    for (; pages < MAX_PAGES_PER_SWEEP; pages++) {
      let page: SyncPage;
      try {
        page = await provider.fetchChanges(account, cursor, options);
      } catch (error) {
        if (error instanceof SyncCursorExpiredError && cursor !== null) {
          logger.info({ account: account.id }, "sync cursor expired — restarting backfill");
          cursor = null;
          setSyncCursor(account.id, null);
          continue;
        }
        throw error;
      }
      changed += applySyncPage(account.id, page);
      cursor = page.cursor;
      setSyncCursor(account.id, cursor);
      if (!page.hasMore) break;
    }
    hitPageCap = pages === MAX_PAGES_PER_SWEEP;
    markSyncStatus(account.id, "idle");
    recordSyncSuccess(account.id);
  } catch (error) {
    markSyncStatus(account.id, "error", errorMessage(error));
    const backoff = recordSyncFailure(account.id);
    logger.warn(
      { err: error, account: account.id, app: account.app, failures: backoff.failures },
      "mail sync failed",
    );
  } finally {
    if (changed > 0) emitServerEvent("mail");
    // More backfill is waiting for this account — run the next sweep now
    // instead of idling until the next interval tick.
    if (hitPageCap) loop.trigger();
  }
}

/**
 * Sync one account now; concurrent calls for the same account join the run
 * in flight. Bypasses backoff — an explicit request always attempts.
 */
export function syncAccount(account: ConnectedAccount): Promise<void> {
  return accountJobs.join(account.id, () => runSync(account));
}

async function sweep(): Promise<void> {
  let accounts: ConnectedAccount[];
  try {
    accounts = await listAccounts();
  } catch (error) {
    // Pipedream not configured yet (or unreachable) — nothing to mirror this
    // round; the next interval retries without spamming the log.
    logger.debug({ err: error }, "sync sweep skipped: no account list");
    return;
  }
  const now = Date.now();
  const due = accounts.filter((account) => {
    const backoff = backoffByAccount.get(account.id);
    if (!backoff || backoff.retryAt <= now) return true;
    logger.debug(
      { account: account.id, failures: backoff.failures, retryInMs: backoff.retryAt - now },
      "sync sweep skipped account: backing off after repeated failures",
    );
    return false;
  });
  await mapWithConcurrency(due, ACCOUNT_CONCURRENCY, (account) => syncAccount(account));
}

const loop = new JobLoop({ name: "mail-sync", run: sweep, intervalMs: env.sync.intervalMs });

/**
 * Drop every account's sync cursor and kick a sweep, so each account re-runs
 * its bounded backfill under the current window setting. Already-mirrored
 * mail is re-upserted, never lost. An account whose sync is mid-flight keeps
 * persisting its own cursor and only adopts the new window on its next fresh
 * backfill (cursor expiry or reconnect).
 */
export async function restartBackfill(): Promise<void> {
  let accounts: ConnectedAccount[];
  try {
    accounts = await listAccounts();
  } catch (error) {
    logger.debug({ err: error }, "backfill restart skipped: no account list");
    return;
  }
  for (const account of accounts) setSyncCursor(account.id, null);
  loop.trigger();
}

/** Kick off an immediate sweep and keep polling. */
export function startSyncEngine(): void {
  loop.start();
}

/** Stop polling; a sweep already in flight finishes on its own. */
export function stopSyncEngine(): void {
  loop.stop();
}
