import { lazyStatement } from "../../db/index.js";
import { escapeLikeInput } from "../../util.js";
import { decodeStringArray } from "../sync/rows.js";

/**
 * DB access for newsletter unsubscribe: contacts rows with kind="bulk"
 * (email/contacts/* owns that table; the ONE column this module writes there
 * is unsubscribe_requested_at, stamped by markUnsubscribeRequested below)
 * and the two List-Unsubscribe columns on mail_messages, which this module
 * IS the sole writer of past initial sync.
 *
 * The two List-Unsubscribe columns have three states: a raw header value, ''
 * (checked, confirmed absent — written by persistMessageHeaders so a message
 * is never lazily re-fetched), and NULL ("not yet known": Outlook's delta
 * feed can't carry headers at all, and Gmail rows mirrored before header
 * capture existed were never evaluated; Gmail rows synced since carry the
 * value or NULL-meaning-absent, which one lazy fetch settles to '' at most
 * once per sender). Both providers expose SyncProvider.fetchMessageHeaders
 * for the NULL case; ./resolve.ts decides when to spend those fetches.
 */

export interface BulkSenderRow {
  address: string;
  displayName: string;
  messageCount: number;
  lastContactAt: string;
  /** Connected-account ids this sender corresponds on. */
  accounts: string[];
  /** Set once a one-click request succeeded for this sender; never cleared. */
  unsubscribeRequestedAt: string | null;
}

const listBulkStmt = lazyStatement(`
  SELECT address, display_name AS displayName, message_count AS messageCount,
         last_contact_at AS lastContactAt, accounts,
         unsubscribe_requested_at AS unsubscribeRequestedAt
  FROM contacts
  WHERE kind = 'bulk'
  ORDER BY last_contact_at DESC
`);

/** Every bulk/newsletter sender contacts has recorded. */
export function listBulkSenders(): BulkSenderRow[] {
  const rows = listBulkStmt().all() as Array<{
    address: string;
    displayName: string;
    messageCount: number;
    lastContactAt: string;
    accounts: string;
    unsubscribeRequestedAt: string | null;
  }>;
  return rows.map((row) => ({ ...row, accounts: decodeStringArray(row.accounts) }));
}

const markRequestedStmt = lazyStatement(`
  UPDATE contacts
  SET unsubscribe_requested_at = @requestedAt, updated_at = @requestedAt
  WHERE address = @address
`);

/**
 * Stamp a successful one-click request on the sender's contact row — the one
 * contacts column this module owns. A sender with no contacts row (possible
 * when the derivation job hasn't seen it yet) is a silent no-op; the request
 * itself already went out.
 */
export function markUnsubscribeRequested(address: string): void {
  markRequestedStmt().run({
    address: address.trim().toLowerCase(),
    requestedAt: new Date().toISOString(),
  });
}

export interface SenderMessageRow {
  accountId: string;
  providerMessageId: string;
  /** Raw List-Unsubscribe header value; null = not yet known, '' = known absent (see module doc comment). */
  listUnsubscribe: string | null;
  /** 1/0 once list_unsubscribe is known; null alongside a null list_unsubscribe. */
  listUnsubscribePost: number | null;
}

const MESSAGE_COLUMNS = `
  account_id AS accountId,
  provider_message_id AS providerMessageId,
  list_unsubscribe AS listUnsubscribe,
  list_unsubscribe_post AS listUnsubscribePost
`;

// from_addr is stored "Name <addr>" or a bare address (SyncMessage.from —
// ../sync/syncProviders.ts), so a contact's normalized bare address is
// matched either way: an exact bare match, or an angle-bracket suffix match
// anchored on the closing '>' so "bob@x.com" can never match "notbob@x.com".
// The address is lower-cased and LIKE-escaped (escapeLikeInput) before
// binding so a literal '%' or '_' in an address can't widen the match.
//
// Row preference, not plain recency: a sender's newest message can be a
// transactional one without headers while its newsletters carry one-click —
// so prefer the newest message that actually HAS a header, then the newest
// not-yet-known row (worth a lazy fetch), and only then checked-absent rows.
const SENDER_ROW_ORDER = `
  ORDER BY (list_unsubscribe IS NOT NULL AND list_unsubscribe != '') DESC,
           (list_unsubscribe IS NULL) DESC,
           date DESC
  LIMIT 1
`;

const newestForSenderStmt = lazyStatement(`
  SELECT ${MESSAGE_COLUMNS}
  FROM mail_messages
  WHERE LOWER(from_addr) = @address
     OR LOWER(from_addr) LIKE '%<' || @likePattern || '>' ESCAPE '\\'
  ${SENDER_ROW_ORDER}
`);

const newestForSenderInAccountStmt = lazyStatement(`
  SELECT ${MESSAGE_COLUMNS}
  FROM mail_messages
  WHERE account_id = @accountId
    AND (LOWER(from_addr) = @address
         OR LOWER(from_addr) LIKE '%<' || @likePattern || '>' ESCAPE '\\')
  ${SENDER_ROW_ORDER}
`);

function addressBinding(address: string): { address: string; likePattern: string } {
  const lower = address.trim().toLowerCase();
  return { address: lower, likePattern: escapeLikeInput(lower) };
}

/** The sender's newest mirrored message across every connected account. */
export function newestMessageFromSender(address: string): SenderMessageRow | null {
  const row = newestForSenderStmt().get(addressBinding(address)) as SenderMessageRow | undefined;
  return row ?? null;
}

/** The sender's newest mirrored message within one connected account. */
export function newestMessageFromSenderInAccount(
  address: string,
  accountId: string,
): SenderMessageRow | null {
  const row = newestForSenderInAccountStmt().get({
    ...addressBinding(address),
    accountId,
  }) as SenderMessageRow | undefined;
  return row ?? null;
}

const persistHeadersStmt = lazyStatement(`
  UPDATE mail_messages
  SET list_unsubscribe = @listUnsubscribe, list_unsubscribe_post = @listUnsubscribePost
  WHERE account_id = @accountId AND provider_message_id = @providerMessageId
`);

/**
 * Write back a lazily-fetched SyncProvider.fetchMessageHeaders result onto
 * its message row. `headers.listUnsubscribe` absent means the provider
 * checked and found no header — persisted as '' (not null) so this message
 * is never re-fetched; see the module doc comment.
 */
export function persistMessageHeaders(
  accountId: string,
  providerMessageId: string,
  headers: { listUnsubscribe?: string; listUnsubscribePost?: boolean },
): void {
  persistHeadersStmt().run({
    accountId,
    providerMessageId,
    listUnsubscribe: headers.listUnsubscribe ?? "",
    listUnsubscribePost: headers.listUnsubscribe ? (headers.listUnsubscribePost ? 1 : 0) : 0,
  });
}
