import type { Contact, ContactCategory, ContactKind } from "@trailin/shared";
import { lazyStatement, sqlite } from "../../db/index.js";
import { upsertSql } from "../../db/sql.js";
import { escapeLikeInput } from "../../util.js";
import { decodeStringArray } from "../sync/rows.js";
import { isEmailLike, parseAddressEntry } from "./addressMatch.js";

/**
 * Aggregation (deterministic, re-derivable) and CRUD side of the contacts
 * core: one row per correspondent address, built from the mailbox mirror.
 * deriveContacts() only ever writes display_name/accounts/message_count/
 * sent_count/last_contact_at/updated_at — kind/category/category_source/
 * gist/input_hash/model/error/enriched_at are owned by contactsEnrichStore.ts
 * and never touched here. A contact whose messages later disappear (a
 * deleted sync page) keeps its row rather than being pruned, so an
 * enrichment or a user's category override is never silently lost.
 */

interface RawMessageRow {
  accountId: string;
  fromAddr: string;
  toAddrs: string;
  date: string;
  isFromMe: number;
}

const selectAllMessages = lazyStatement(`
  SELECT account_id AS accountId, from_addr AS fromAddr, to_addrs AS toAddrs, date, is_from_me AS isFromMe
  FROM mail_messages
`);

interface ContactAggregate {
  displayName: string;
  displayNameLen: number;
  accounts: Set<string>;
  messageCount: number;
  sentCount: number;
  lastContactAt: string;
}

/** Longer beats shorter — the fullest name seen for an address wins. */
function considerName(agg: ContactAggregate, name: string): void {
  if (name.length > agg.displayNameLen) {
    agg.displayName = name;
    agg.displayNameLen = name.length;
  }
}

/**
 * Full recompute of every contact from the mirror. Candidates are exactly
 * the two forms the task defines: the sender of an inbound message, and
 * every recipient of an outbound (from-me) message. The account's own
 * address(es) are told apart from a genuine contact by the from_addr column
 * alone (never to_addrs, which is where a candidate itself comes from — a
 * check built from the same column a candidate is drawn from could never
 * fire): an address that is from_addr on some from-me row AND NEVER
 * from_addr on an inbound row is presumed to be the owner's own identity,
 * excluded even if it also turns up as a to_addrs recipient (a self-cc, or a
 * second connected account the owner emailed). An address that DOES appear
 * as from_addr on an inbound row (someone genuinely mailed the owner from
 * it) is a real correspondent regardless of any from-me row sharing it.
 * Returns how many addresses' aggregates actually changed.
 */
export function deriveContacts(): number {
  const rows = selectAllMessages().all() as RawMessageRow[];

  const ownFromMe = new Set<string>();
  const inboundSenders = new Set<string>();
  for (const row of rows) {
    const { address } = parseAddressEntry(row.fromAddr);
    if (!isEmailLike(address)) continue;
    if (row.isFromMe === 1) ownFromMe.add(address);
    else inboundSenders.add(address);
  }
  const ownAddresses = new Set([...ownFromMe].filter((address) => !inboundSenders.has(address)));

  const agg = new Map<string, ContactAggregate>();
  const touch = (
    address: string,
    name: string,
    accountId: string,
    date: string,
    isSent: boolean,
  ): void => {
    if (!isEmailLike(address) || ownAddresses.has(address)) return;
    let entry = agg.get(address);
    if (!entry) {
      entry = {
        displayName: "",
        displayNameLen: 0,
        accounts: new Set(),
        messageCount: 0,
        sentCount: 0,
        lastContactAt: "",
      };
      agg.set(address, entry);
    }
    considerName(entry, name);
    entry.accounts.add(accountId);
    entry.messageCount++;
    if (isSent) entry.sentCount++;
    if (date > entry.lastContactAt) entry.lastContactAt = date;
  };

  for (const row of rows) {
    if (row.isFromMe === 1) {
      for (const raw of decodeStringArray(row.toAddrs)) {
        const { address, name } = parseAddressEntry(raw);
        touch(address, name, row.accountId, row.date, true);
      }
    } else {
      const { address, name } = parseAddressEntry(row.fromAddr);
      touch(address, name, row.accountId, row.date, false);
    }
  }

  return writeContactAggregates(agg);
}

interface ExistingAggregateRow {
  address: string;
  displayName: string;
  accounts: string;
  messageCount: number;
  sentCount: number;
  lastContactAt: string;
}

const selectExistingAggregates = lazyStatement(`
  SELECT address, display_name AS displayName, accounts, message_count AS messageCount,
         sent_count AS sentCount, last_contact_at AS lastContactAt
  FROM contacts
`);

const upsertAggregate = lazyStatement(
  upsertSql({
    table: "contacts",
    conflict: ["address"],
    insertOnly: ["created_at"],
    update: [
      "display_name",
      "accounts",
      "message_count",
      "sent_count",
      "last_contact_at",
      "updated_at",
    ],
  }),
);

/**
 * Writes only the addresses whose aggregate actually changed, so an
 * unaffected contact's `updated_at` never moves — that keeps the enrichment
 * staleness prefilter (contactsEnrichStore.ts: `updated_at > enriched_at`)
 * meaningful instead of tripping on every derivation cycle.
 */
function writeContactAggregates(agg: Map<string, ContactAggregate>): number {
  const existing = new Map(
    (selectExistingAggregates().all() as ExistingAggregateRow[]).map((row) => [row.address, row]),
  );
  const nowIso = new Date().toISOString();
  let touched = 0;
  const txn = sqlite.transaction(() => {
    for (const [address, entry] of agg) {
      const accountsJson = JSON.stringify([...entry.accounts].sort());
      const prior = existing.get(address);
      const unchanged =
        prior !== undefined &&
        prior.displayName === entry.displayName &&
        prior.accounts === accountsJson &&
        prior.messageCount === entry.messageCount &&
        prior.sentCount === entry.sentCount &&
        prior.lastContactAt === entry.lastContactAt;
      if (unchanged) continue;
      upsertAggregate().run({
        address,
        createdAt: nowIso,
        displayName: entry.displayName,
        accounts: accountsJson,
        messageCount: entry.messageCount,
        sentCount: entry.sentCount,
        lastContactAt: entry.lastContactAt,
        updatedAt: nowIso,
      });
      touched++;
    }
  });
  txn();
  return touched;
}

interface ContactRow {
  address: string;
  displayName: string;
  kind: ContactKind;
  category: ContactCategory;
  categorySource: "auto" | "user";
  gist: string;
  accounts: string;
  messageCount: number;
  sentCount: number;
  lastContactAt: string;
  model: string | null;
  error: string | null;
  enrichedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const CONTACT_COLUMNS = `
  address, display_name AS displayName, kind, category, category_source AS categorySource,
  gist, accounts, message_count AS messageCount, sent_count AS sentCount,
  last_contact_at AS lastContactAt, model, error, enriched_at AS enrichedAt,
  created_at AS createdAt, updated_at AS updatedAt
`;

function toContact(row: ContactRow): Contact {
  return { ...row, accounts: decodeStringArray(row.accounts) };
}

const selectByAddress = lazyStatement(`SELECT ${CONTACT_COLUMNS} FROM contacts WHERE address = ?`);

export function getContact(address: string): Contact | null {
  const row = selectByAddress().get(address) as ContactRow | undefined;
  return row ? toContact(row) : null;
}

export interface ListContactsFilter {
  kind?: ContactKind;
  category?: ContactCategory;
  q?: string;
}

/** GET /api/contacts: every filter is optional and ANDed; newest contact first. */
export function listContacts(filter: ListContactsFilter): Contact[] {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  if (filter.kind) {
    clauses.push("kind = @kind");
    params.kind = filter.kind;
  }
  if (filter.category) {
    clauses.push("category = @category");
    params.category = filter.category;
  }
  if (filter.q) {
    clauses.push("(display_name LIKE @q ESCAPE '\\' OR address LIKE @q ESCAPE '\\')");
    params.q = `%${escapeLikeInput(filter.q)}%`;
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = sqlite
    .prepare(`SELECT ${CONTACT_COLUMNS} FROM contacts ${where} ORDER BY last_contact_at DESC`)
    .all(params) as ContactRow[];
  return rows.map(toContact);
}

const overrideCategoryStmt = lazyStatement(`
  UPDATE contacts SET category = @category, category_source = 'user', updated_at = @updatedAt
  WHERE address = @address
`);

/**
 * PATCH /api/contacts/:address's one write: pins category_source to "user"
 * so future enrichment judgments never overwrite it again. Returns null
 * (route 404s) when the address has no contact row.
 */
export function setContactCategory(address: string, category: ContactCategory): Contact | null {
  const result = overrideCategoryStmt().run({
    address,
    category,
    updatedAt: new Date().toISOString(),
  });
  if (result.changes === 0) return null;
  return getContact(address);
}
