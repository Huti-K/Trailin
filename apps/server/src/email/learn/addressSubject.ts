/**
 * Pure text-normalization helpers for the deterministic side of draft-vs-sent
 * matching (matcher.ts): recipient-set equality and subject equality must
 * both ignore the cosmetic differences a provider round-trip introduces
 * (display names, reply-prefix chains, whitespace/case) without needing an
 * LLM call.
 */

/** "Name <addr>" or a bare address → the bare, lowercased address. */
function normalizeAddress(raw: string): string {
  const match = raw.match(/<([^>]+)>\s*$/);
  const address = match ? (match[1] ?? "") : raw;
  return address.trim().toLowerCase();
}

/** A To-header's addresses as a set, ignoring display name, case, and order. */
export function normalizeAddressSet(addresses: readonly string[]): Set<string> {
  return new Set(addresses.map(normalizeAddress).filter(Boolean));
}

/** Set equality (both directions) — used instead of size-only comparison so a same-size but different set never passes. */
export function sameAddressSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}

/** Leading Re:/Fwd:/Fw:/AW: (possibly repeated by nested reply chains), any case. */
const REPLY_PREFIX_RE = /^(re|fwd?|aw)\s*:\s*/i;

/** Subject with every reply/forward prefix stripped, case-folded, whitespace collapsed. */
export function normalizeSubject(subject: string): string {
  let current = subject.trim();
  let previous: string;
  do {
    previous = current;
    current = current.replace(REPLY_PREFIX_RE, "").trim();
  } while (current !== previous);
  return current.replace(/\s+/g, " ").toLowerCase();
}
