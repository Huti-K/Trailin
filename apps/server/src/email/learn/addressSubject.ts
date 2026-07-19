function normalizeAddress(raw: string): string {
  const match = raw.match(/<([^>]+)>\s*$/);
  const address = match ? (match[1] ?? "") : raw;
  return address.trim().toLowerCase();
}

export function normalizeAddressSet(addresses: readonly string[]): Set<string> {
  return new Set(addresses.map(normalizeAddress).filter(Boolean));
}

/** Set equality both directions, not size-only, so a same-size but different set never passes. */
export function sameAddressSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}

/** Leading Re:/Fwd:/Fw:/AW: (repeated by nested reply chains), any case. */
const REPLY_PREFIX_RE = /^(re|fwd?|aw)\s*:\s*/i;

export function normalizeSubject(subject: string): string {
  let current = subject.trim();
  let previous: string;
  do {
    previous = current;
    current = current.replace(REPLY_PREFIX_RE, "").trim();
  } while (current !== previous);
  return current.replace(/\s+/g, " ").toLowerCase();
}
