import type { ConnectedAccount, EmailDraft } from "@trailin/shared";
import { env } from "../env.js";
import { emitServerEvent } from "../events.js";
import { moduleLogger } from "../logger.js";
import { getDraftProvider } from "./providers.js";

/**
 * Shared drafts cache, one entry per connected account, used by every
 * DraftProvider's `listDrafts` instead of each provider keeping its own.
 * Stale-while-revalidate: a stale entry is still returned immediately (so a
 * Home page load never blocks on a live Gmail/Outlook round-trip), and a
 * single deduped background refresh brings it back up to date, notifying the
 * web UI via the "drafts" server event only when the refreshed list actually
 * differs from what was just served.
 *
 * Entries are never evicted on a timer — staleness is just a timestamp
 * comparison against TTL_MS at read time — so a quiet account's last-known
 * drafts stay servable indefinitely if nothing ever calls listDraftsCached
 * for it again.
 */

const log = moduleLogger("drafts-cache");

const TTL_MS = 60_000;

interface CacheEntry {
  drafts: EmailDraft[];
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();

/** In-flight live fetches per account, so concurrent callers (including a background refresh) share one provider round-trip. */
const inFlight = new Map<string, Promise<EmailDraft[]>>();

/**
 * Generation each account's in-flight fetch was dispatched under, paired
 * with `generation` below. A fetch left over from before an
 * invalidateDraftsCache call is stale: dedupedFetch won't let a new caller
 * join it, and the write sites (listDraftsCached, scheduleBackgroundRefresh)
 * won't let its result overwrite the cache once it resolves — otherwise a
 * fetch started before a mutation could re-cache the pre-mutation list for a
 * full TTL after the mutation's own invalidate + emit("drafts") already ran.
 */
const inFlightGeneration = new Map<string, number>();

/** Bumped by invalidateDraftsCache; see inFlightGeneration above. */
const generation = new Map<string, number>();

function currentGeneration(accountId: string): number {
  return generation.get(accountId) ?? 0;
}

/** Accounts with a background refresh already scheduled, so a second stale hit doesn't queue a second one. */
const refreshing = new Set<string>();

function isFresh(entry: CacheEntry): boolean {
  return Date.now() - entry.fetchedAt < TTL_MS;
}

/** Order-sensitive is fine here — both sides come from the same provider-sorted (newest-first) list. */
function draftsEqual(a: EmailDraft[], b: EmailDraft[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function providerFor(account: ConnectedAccount) {
  const provider = getDraftProvider(account.app);
  if (!provider) throw new Error(`no draft provider registered for app "${account.app}"`);
  return provider;
}

/**
 * Live fetch, deduped per account: a second caller while one is already
 * running joins it instead of firing another — unless that fetch was
 * dispatched under an older generation (an invalidateDraftsCache landed
 * since), in which case it's stale and a fresh fetch is started instead.
 * Returns the generation the returned fetch was dispatched under, so the
 * caller can gate its cache.set on nothing having invalidated in the
 * meantime.
 */
function dedupedFetch(account: ConnectedAccount): { promise: Promise<EmailDraft[]>; generation: number } {
  const gen = currentGeneration(account.id);
  const existing = inFlight.get(account.id);
  if (existing && inFlightGeneration.get(account.id) === gen) return { promise: existing, generation: gen };
  const promise = providerFor(account)
    .listDrafts(account)
    .finally(() => {
      // Only clear our own entry — a fresh fetch dispatched after us (e.g.
      // because we were already stale) may have replaced it in the map.
      if (inFlight.get(account.id) === promise) {
        inFlight.delete(account.id);
        inFlightGeneration.delete(account.id);
      }
    });
  inFlight.set(account.id, promise);
  inFlightGeneration.set(account.id, gen);
  return { promise, generation: gen };
}

/**
 * Refresh one account's cache in the background, without making the caller
 * that triggered it (who already got the stale list) wait. Never throws —
 * failures are logged at warn and simply leave the stale entry in place for
 * the next reader to retry from, matching the "failed fetches never update
 * the cache" rule.
 */
function scheduleBackgroundRefresh(account: ConnectedAccount, previous: EmailDraft[]): void {
  if (refreshing.has(account.id)) return;
  refreshing.add(account.id);
  const fetch = dedupedFetch(account);
  fetch.promise
    .then((drafts) => {
      // A mutation invalidated the cache while this fetch was in flight — its
      // result reflects pre-mutation state, so it must not overwrite the
      // cache (the mutation's own invalidate + emit already covers this).
      if (fetch.generation !== currentGeneration(account.id)) return;
      cache.set(account.id, { drafts, fetchedAt: Date.now() });
      // Only notify the UI when something actually changed — an account with
      // no external activity shouldn't trigger a refetch storm every TTL.
      if (!draftsEqual(previous, drafts)) emitServerEvent("drafts");
    })
    .catch((error) => {
      log.warn({ err: error, accountId: account.id }, "background drafts refresh failed");
    })
    .finally(() => {
      refreshing.delete(account.id);
    });
}

/**
 * Cached, stale-while-revalidate drafts list for one account.
 *
 * - demo mode: always a direct live call — demo data is a cheap local read,
 *   and demo mutations (create/delete a draft) need to show up instantly, so
 *   caching it would only add a reason for it to look stale.
 * - `refresh: true`: live fetch (still deduped against any fetch already in
 *   flight for this account), cache the result, return it.
 * - fresh cache entry (< TTL_MS old): return it as-is.
 * - stale cache entry: return it immediately and kick off one background
 *   refresh (see scheduleBackgroundRefresh).
 * - cache miss: live fetch (deduped), cache, return.
 */
export async function listDraftsCached(
  account: ConnectedAccount,
  opts: { refresh?: boolean } = {},
): Promise<EmailDraft[]> {
  if (env.demoMode) return providerFor(account).listDrafts(account);

  if (opts.refresh) {
    const fetch = dedupedFetch(account);
    const drafts = await fetch.promise;
    if (fetch.generation === currentGeneration(account.id)) cache.set(account.id, { drafts, fetchedAt: Date.now() });
    return drafts;
  }

  const entry = cache.get(account.id);
  if (entry) {
    if (isFresh(entry)) return entry.drafts;
    scheduleBackgroundRefresh(account, entry.drafts);
    return entry.drafts;
  }

  const fetch = dedupedFetch(account);
  const drafts = await fetch.promise;
  if (fetch.generation === currentGeneration(account.id)) cache.set(account.id, { drafts, fetchedAt: Date.now() });
  return drafts;
}

/**
 * Drop one account's cached drafts list and bump its generation. Call this
 * before emitting "drafts" from any mutation path (create/update/delete
 * draft, any app) so the SSE-driven refetch it triggers doesn't race the
 * cache write and see the old list — the generation bump is what stops a
 * fetch already in flight when this runs from re-caching its (now stale)
 * result afterwards; see inFlightGeneration above.
 */
export function invalidateDraftsCache(accountId: string): void {
  cache.delete(accountId);
  generation.set(accountId, currentGeneration(accountId) + 1);
}
