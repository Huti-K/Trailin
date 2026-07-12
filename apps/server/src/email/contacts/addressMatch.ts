/**
 * Address parsing shared by every contacts module. mail_messages'
 * from_addr/to_addrs/cc_addrs and mail_threads.participants all store
 * entries in the form email/textUtils.ts's splitAddressList produces —
 * `"Name <addr>"` or a bare address — so this is the one place that turns
 * that display form back into an identity (contacts.address: lowercased,
 * bare) plus whatever name was attached to this particular occurrence.
 */

export interface ParsedAddress {
  /** Lowercased bare address — the contacts core's identity key. */
  address: string;
  /** Display name as written on this occurrence; "" when the entry was bare. */
  name: string;
}

const ANGLE_ADDRESS = /^(.*)<([^<>]+)>\s*$/;

/** Parse one "Name <addr>" or bare-address entry. Never throws. */
export function parseAddressEntry(raw: string): ParsedAddress {
  const trimmed = raw.trim();
  const match = trimmed.match(ANGLE_ADDRESS);
  if (!match) return { address: trimmed.toLowerCase(), name: "" };
  const [, namePart, addressPart] = match;
  const name = (namePart ?? "")
    .trim()
    .replace(/^"(.*)"$/, "$1")
    .trim();
  return { address: (addressPart ?? "").trim().toLowerCase(), name };
}

/**
 * True when `address` (already lowercased by parseAddressEntry) is worth
 * treating as a contact identity — guards against empty/malformed entries a
 * provider occasionally leaves in a header (a blank To, an unparseable
 * group) rather than turning them into a bogus contacts row.
 */
export function isEmailLike(address: string): boolean {
  return address.length > 0 && address.includes("@") && !address.includes(" ");
}
