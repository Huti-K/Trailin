import { createHash } from "node:crypto";
import type { ContactCategory, ContactKind } from "@trailin/shared";
import { lazyStatement } from "../../db/index.js";
import { escapeLikeInput } from "../../util.js";
import { decodeStringArray } from "../sync/rows.js";
import { parseAddressEntry } from "./addressMatch.js";

/**
 * Read/write side of contact enrichment (the LLM judgment: kind/category/
 * gist) — mirrors email/enrich/enrichStore.ts's role for threads, but
 * against contacts' single table (aggregate and enrichment fields share one
 * row, so no join is needed). Staleness is derived, never queued: a contact
 * is a candidate whenever its aggregate has moved past its last judgment
 * (`updated_at > enriched_at`) or it has never been judged; a candidate is
 * only truly stale once its recent-message hash (computed from the exact
 * sample the LLM would see) no longer matches the stored one. A third branch
 * re-surfaces errored contacts once ERROR_BACKOFF_MS has elapsed.
 */

const ERROR_BACKOFF_MS = 10 * 60_000;

export interface StaleContact {
  address: string;
  inputHash: string;
  lastError: string | null;
  lastEnrichedAt: string | null;
}

const selectStale = lazyStatement(`
  SELECT address, input_hash AS inputHash, error AS lastError, enriched_at AS lastEnrichedAt
  FROM contacts
  WHERE enriched_at IS NULL
     OR updated_at > enriched_at
     OR (error IS NOT NULL AND enriched_at < @errorCutoff)
  ORDER BY last_contact_at DESC
  LIMIT @limit
`);

export function findStaleContacts(limit: number): StaleContact[] {
  const errorCutoff = new Date(Date.now() - ERROR_BACKOFF_MS).toISOString();
  return selectStale().all({ limit, errorCutoff }) as StaleContact[];
}

export interface ContactSampleMessage {
  subject: string;
  snippet: string;
  date: string;
  isFromMe: boolean;
  hasListUnsubscribe: boolean;
}

export interface ContactSample {
  address: string;
  displayName: string;
  /** True when the owner has personally sent this address mail (contacts.sent_count > 0). */
  hasSentTo: boolean;
  /** Hash over the sample message ids below — the staleness key stored on contacts.input_hash. */
  inputHash: string;
  /** Newest first, capped. */
  messages: ContactSampleMessage[];
}

const MAX_SAMPLE_MESSAGES = 15;
/** Rows fetched before the exact per-entry address match narrows them — bounds the scan. */
const SAMPLE_OVERFETCH = 80;

const selectContactMeta = lazyStatement(`
  SELECT display_name AS displayName, sent_count AS sentCount, message_count AS messageCount
  FROM contacts WHERE address = ?
`);

interface RawSampleRow {
  id: string;
  subject: string;
  snippet: string;
  date: string;
  isFromMe: number;
  listUnsubscribe: string | null;
  fromAddr: string;
  toAddrs: string;
}

const selectSampleRows = lazyStatement(`
  SELECT id, subject, snippet, date, is_from_me AS isFromMe,
         list_unsubscribe AS listUnsubscribe, from_addr AS fromAddr, to_addrs AS toAddrs
  FROM mail_messages
  WHERE (is_from_me = 0 AND from_addr LIKE @like ESCAPE '\\')
     OR (is_from_me = 1 AND to_addrs LIKE @like ESCAPE '\\')
  ORDER BY date DESC
  LIMIT @overfetch
`);

/**
 * The exact messages the enrichment prompt would show for one address,
 * newest first, plus the hash those message ids produce. The LIKE prefilter
 * (the address may sit anywhere inside a JSON to_addrs blob, or as a bare
 * from_addr) is confirmed per row by re-parsing the matching column with
 * parseAddressEntry, so a substring collision ("eve@x.com" inside
 * "steve@x.com") can never produce a false match. Returns null once the
 * address has no messages at all (no contacts row, or message_count is 0).
 */
export function buildContactSample(address: string): ContactSample | null {
  const meta = selectContactMeta().get(address) as
    | { displayName: string; sentCount: number; messageCount: number }
    | undefined;
  if (!meta || meta.messageCount === 0) return null;

  const like = `%${escapeLikeInput(address)}%`;
  const rows = selectSampleRows().all({ like, overfetch: SAMPLE_OVERFETCH }) as RawSampleRow[];
  const matched: RawSampleRow[] = [];
  for (const row of rows) {
    if (matched.length >= MAX_SAMPLE_MESSAGES) break;
    const isMatch =
      row.isFromMe === 1
        ? decodeStringArray(row.toAddrs).some(
            (entry) => parseAddressEntry(entry).address === address,
          )
        : parseAddressEntry(row.fromAddr).address === address;
    if (isMatch) matched.push(row);
  }

  const hash = createHash("sha256").update("contacts-v1\n");
  for (const row of matched) hash.update(row.id).update("\n");

  return {
    address,
    displayName: meta.displayName,
    hasSentTo: meta.sentCount > 0,
    inputHash: hash.digest("hex"),
    messages: matched.map((row) => ({
      subject: row.subject,
      snippet: row.snippet,
      date: row.date,
      isFromMe: row.isFromMe === 1,
      hasListUnsubscribe: row.listUnsubscribe !== null,
    })),
  };
}

export interface ContactJudgment {
  kind: ContactKind;
  category: ContactCategory;
  gist: string;
}

/**
 * category only takes the judgment's value when category_source is still
 * "auto" — a user override (set by PATCH /api/contacts/:address) is never
 * overwritten by a later judgment; kind and gist always refresh.
 */
const saveJudgmentStmt = lazyStatement(`
  UPDATE contacts SET
    kind = @kind,
    category = CASE WHEN category_source = 'user' THEN category ELSE @category END,
    gist = @gist,
    input_hash = @inputHash,
    model = @model,
    error = NULL,
    enriched_at = @enrichedAt,
    updated_at = @enrichedAt
  WHERE address = @address
`);

export function saveContactJudgment(
  address: string,
  inputHash: string,
  judgment: ContactJudgment,
  model: string,
): void {
  saveJudgmentStmt().run({
    address,
    inputHash,
    kind: judgment.kind,
    category: judgment.category,
    gist: judgment.gist,
    model,
    enrichedAt: new Date().toISOString(),
  });
}

/** Keeps any previously-judged kind/category/gist (stale beats none) but stamps error + hash/time for backoff. */
const saveErrorStmt = lazyStatement(`
  UPDATE contacts SET error = @error, input_hash = @inputHash, enriched_at = @enrichedAt, updated_at = @enrichedAt
  WHERE address = @address
`);

export function saveContactError(address: string, inputHash: string, error: string): void {
  saveErrorStmt().run({ address, inputHash, error, enrichedAt: new Date().toISOString() });
}

/** The hash matched — nothing to judge again; only refresh enriched_at so the prefilter stops flagging it. */
const touchStmt = lazyStatement(
  "UPDATE contacts SET enriched_at = @enrichedAt WHERE address = @address",
);

export function touchContactEnrichment(address: string): void {
  touchStmt().run({ address, enrichedAt: new Date().toISOString() });
}
