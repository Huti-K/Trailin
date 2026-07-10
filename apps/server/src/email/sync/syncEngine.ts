import type { ConnectedAccount } from "@trailin/shared";
import { emitServerEvent } from "../../events.js";
import { env } from "../../env.js";
import { logger } from "../../logger.js";
import { errorMessage } from "../../util.js";
import { listAccounts } from "../../pipedream/connect.js";
import { applySyncPage, getSyncState, markSyncStatus, setSyncCursor } from "./mailStore.js";
import {
  getSyncProvider,
  SyncCursorExpiredError,
  type SyncOptions,
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

const inFlight = new Map<string, Promise<void>>();
let timer: NodeJS.Timeout | null = null;

function syncOptions(): SyncOptions {
  return { backfillDays: env.sync.backfillDays, pageSize: env.sync.pageSize };
}

async function runSync(account: ConnectedAccount): Promise<void> {
  const provider = getSyncProvider(account.app);
  if (!provider) return;

  markSyncStatus(account.id, "syncing");
  let cursor = getSyncState(account.id)?.cursor ?? null;
  let changed = 0;
  try {
    for (let pages = 0; pages < MAX_PAGES_PER_SWEEP; pages++) {
      let page;
      try {
        page = await provider.fetchChanges(account, cursor, syncOptions());
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
    markSyncStatus(account.id, "idle");
  } catch (error) {
    markSyncStatus(account.id, "error", errorMessage(error));
    logger.warn({ err: error, account: account.id, app: account.app }, "mail sync failed");
  } finally {
    if (changed > 0) emitServerEvent("mail");
  }
}

/** Sync one account now; concurrent calls for the same account join the run in flight. */
export function syncAccount(account: ConnectedAccount): Promise<void> {
  const running = inFlight.get(account.id);
  if (running) return running;
  const run = runSync(account).finally(() => {
    inFlight.delete(account.id);
  });
  inFlight.set(account.id, run);
  return run;
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
  await Promise.all(accounts.map((account) => syncAccount(account)));
}

/**
 * Kick off an immediate sweep and keep polling. Works in demo mode too — the
 * demo SyncProvider feeds the same tables from the seeded mailbox, so every
 * downstream consumer behaves identically in both modes.
 */
export function startSyncEngine(): void {
  if (timer) return;
  void sweep();
  timer = setInterval(() => void sweep(), env.sync.intervalMs);
  // Polling must not keep the process alive during shutdown.
  timer.unref();
}
