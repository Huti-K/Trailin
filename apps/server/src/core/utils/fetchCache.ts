/**
 * Keyed TTL cache over an async fetcher, with in-flight dedupe and a per-key
 * generation counter. The invariants consumers rely on:
 *
 * - Concurrent callers share one in-flight fetch per key.
 * - `invalidate` bumps the key's generation. A fetch dispatched under an older
 *   generation never repopulates the cache and no new caller joins it (it
 *   starts a fresh fetch). Otherwise a fetch started before a mutation could
 *   re-cache the pre-mutation value for a full TTL.
 * - A settled fetch clears only its own in-flight slot.
 * - Failed fetches never populate the cache; the rejection propagates to every
 *   caller sharing the fetch.
 * - Entries are never evicted on a timer; staleness is a read-time timestamp
 *   comparison against `ttlMs`, so a stale value stays peekable indefinitely.
 */

export interface FetchOutcome<T> {
  value: T;
  /**
   * Whether the value was written to the cache. False when an invalidate landed
   * after the fetch was dispatched: the value reflects pre-invalidation state
   * and is not current.
   */
  stored: boolean;
}

export interface FetchCache<T> {
  /** The cached value for a key regardless of age, with its freshness. */
  peek(key: string): { value: T; fresh: boolean } | undefined;
  /** Deduped live fetch; on success the cache is populated unless the key was invalidated mid-flight. */
  fetch(key: string, fetcher: () => Promise<T>): Promise<FetchOutcome<T>>;
  /** Drop a key's cached value and bump its generation, orphaning any fetch already in flight. */
  invalidate(key: string): void;
}

export function createFetchCache<T>(opts: { ttlMs: number }): FetchCache<T> {
  const { ttlMs } = opts;
  const cache = new Map<string, { value: T; fetchedAt: number }>();
  /** Each key's in-flight fetch, tagged with the generation it was dispatched under. */
  const inFlight = new Map<string, { promise: Promise<FetchOutcome<T>>; gen: number }>();
  /** Bumped by `invalidate`; see the module doc for what the counter protects. */
  const generation = new Map<string, number>();

  function currentGeneration(key: string): number {
    return generation.get(key) ?? 0;
  }

  return {
    peek(key) {
      const entry = cache.get(key);
      if (!entry) return undefined;
      return { value: entry.value, fresh: Date.now() - entry.fetchedAt < ttlMs };
    },

    fetch(key, fetcher) {
      const gen = currentGeneration(key);
      // Only join an in-flight fetch dispatched under the current generation;
      // one from before an invalidate is stale, so start a fresh fetch instead.
      const existing = inFlight.get(key);
      if (existing && existing.gen === gen) return existing.promise;

      const promise: Promise<FetchOutcome<T>> = fetcher()
        .then((value) => {
          const stored = gen === currentGeneration(key);
          if (stored) cache.set(key, { value, fetchedAt: Date.now() });
          return { value, stored };
        })
        .finally(() => {
          // Only clear our own slot; a fresh fetch dispatched after us may have
          // replaced it.
          if (inFlight.get(key)?.promise === promise) inFlight.delete(key);
        });
      inFlight.set(key, { promise, gen });
      return promise;
    },

    invalidate(key) {
      cache.delete(key);
      generation.set(key, currentGeneration(key) + 1);
    },
  };
}
