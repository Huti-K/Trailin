import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { db, lazyTransaction, schema } from "./index.js";

/**
 * Snapshot store for agent-written drafts. The provider stays source of truth;
 * these rows preserve what the agent composed so the learning loop can diff
 * against it after the provider draft is edited/sent/deleted. Only agent
 * create-draft rows exist here: a lookup miss means "not agent-written", which
 * every writer below treats as a silent no-op, never an error, so snapshot
 * bookkeeping never fails the provider action it rides on.
 *
 * Rows are keyed by uuid but addressed by callers as (accountId,
 * providerDraftId). Version rows are append-only; fields a patch omits carry
 * forward from the latest version.
 */

export type DraftVersionAuthor = "agent" | "user";
export type DraftStatus = "open" | "sent" | "discarded";

export interface DraftSnapshotInput {
  accountId: string;
  providerDraftId: string;
  providerMessageId?: string;
  threadId?: string;
  subject: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  /** The body exactly as written to the provider (post-humanize). */
  body: string;
}

async function findByProviderId(accountId: string, providerDraftId: string) {
  const rows = await db
    .select()
    .from(schema.agentDrafts)
    .where(
      and(
        eq(schema.agentDrafts.accountId, accountId),
        eq(schema.agentDrafts.providerDraftId, providerDraftId),
      ),
    )
    .limit(1);
  return rows[0];
}

// One transaction for the snapshot row and its version 1, so a failure between
// the inserts can't leave a draft without any version row.
const insertSnapshotRows = lazyTransaction((input: DraftSnapshotInput): void => {
  const now = new Date().toISOString();
  const id = randomUUID();
  db.insert(schema.agentDrafts)
    .values({
      id,
      accountId: input.accountId,
      providerDraftId: input.providerDraftId,
      providerMessageId: input.providerMessageId ?? null,
      threadId: input.threadId ?? null,
      subject: input.subject,
      toAddrs: JSON.stringify(input.to),
      ccAddrs: JSON.stringify(input.cc ?? []),
      bccAddrs: JSON.stringify(input.bcc ?? []),
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(schema.agentDraftVersions)
    .values({
      draftId: id,
      version: 1,
      author: "agent",
      subject: input.subject,
      body: input.body,
      createdAt: now,
    })
    .run();
});

export async function createDraftSnapshot(input: DraftSnapshotInput): Promise<void> {
  insertSnapshotRows(input);
}

// One transaction per appended version: the latest row is read and the next
// version computed inside it, so concurrent appends can't collide on the
// (draft_id, version) key or lose the carry-forward baseline.
const insertVersionRow = lazyTransaction(
  (
    draftId: string,
    fallbackSubject: string,
    author: DraftVersionAuthor,
    patch: { body?: string; subject?: string },
  ): void => {
    const current = db
      .select()
      .from(schema.agentDraftVersions)
      .where(eq(schema.agentDraftVersions.draftId, draftId))
      .orderBy(desc(schema.agentDraftVersions.version))
      .limit(1)
      .get();

    const now = new Date().toISOString();
    db.insert(schema.agentDraftVersions)
      .values({
        draftId,
        version: (current?.version ?? 0) + 1,
        author,
        subject: patch.subject ?? current?.subject ?? fallbackSubject,
        body: patch.body ?? current?.body ?? "",
        createdAt: now,
      })
      .run();
    db.update(schema.agentDrafts)
      .set({ updatedAt: now })
      .where(eq(schema.agentDrafts.id, draftId))
      .run();
  },
);

/** Append a version row for an in-app write. Returns false when the draft has no snapshot. */
export async function appendDraftVersion(
  accountId: string,
  providerDraftId: string,
  author: DraftVersionAuthor,
  patch: { body?: string; subject?: string },
): Promise<boolean> {
  const row = await findByProviderId(accountId, providerDraftId);
  if (!row) return false;
  insertVersionRow(row.id, row.subject, author, patch);
  return true;
}

/**
 * Record the draft's fate. In-app sends pass the provider's sent message id so
 * the learning loop needn't match them; external sends it matches later.
 * Returns false when there is no snapshot.
 */
export async function markDraftStatus(
  accountId: string,
  providerDraftId: string,
  status: DraftStatus,
  sentMessageId?: string,
): Promise<boolean> {
  const row = await findByProviderId(accountId, providerDraftId);
  if (!row) return false;
  await db
    .update(schema.agentDrafts)
    .set({
      status,
      ...(sentMessageId ? { sentMessageId } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.agentDrafts.id, row.id));
  return true;
}

export async function linkDraftConversation(
  accountId: string,
  providerDraftId: string,
  conversationId: string,
): Promise<boolean> {
  const row = await findByProviderId(accountId, providerDraftId);
  if (!row) return false;
  await db
    .update(schema.agentDrafts)
    .set({ conversationId, updatedAt: new Date().toISOString() })
    .where(eq(schema.agentDrafts.id, row.id));
  return true;
}

export interface DraftStatusResult {
  status: DraftStatus;
  sentMessageId?: string;
}

export async function getDraftStatus(
  accountId: string,
  providerDraftId: string,
): Promise<DraftStatusResult | null> {
  const row = await findByProviderId(accountId, providerDraftId);
  if (!row) return null;
  return {
    status: row.status,
    ...(row.sentMessageId ? { sentMessageId: row.sentMessageId } : {}),
  };
}

/**
 * providerDraftId -> conversationId for every given draft whose linked
 * conversation still exists (a deleted chat degrades to "no link" rather than a
 * dead id).
 */
export async function getDraftConversationLinks(
  providerDraftIds: string[],
): Promise<Map<string, string>> {
  if (providerDraftIds.length === 0) return new Map();
  const rows = await db
    .select({
      providerDraftId: schema.agentDrafts.providerDraftId,
      conversationId: schema.agentDrafts.conversationId,
    })
    .from(schema.agentDrafts)
    .innerJoin(schema.conversations, eq(schema.conversations.id, schema.agentDrafts.conversationId))
    .where(
      and(
        inArray(schema.agentDrafts.providerDraftId, providerDraftIds),
        isNotNull(schema.agentDrafts.conversationId),
      ),
    );
  return new Map(
    rows
      .filter((r): r is { providerDraftId: string; conversationId: string } =>
        Boolean(r.conversationId),
      )
      .map((r) => [r.providerDraftId, r.conversationId]),
  );
}

export interface OpenDraftSnapshot {
  accountId: string;
  providerDraftId: string;
  threadId: string | null;
  subject: string;
  to: string[];
  createdAt: string;
}

export async function listOpenDraftSnapshots(): Promise<OpenDraftSnapshot[]> {
  const rows = await db
    .select({
      accountId: schema.agentDrafts.accountId,
      providerDraftId: schema.agentDrafts.providerDraftId,
      threadId: schema.agentDrafts.threadId,
      subject: schema.agentDrafts.subject,
      toAddrs: schema.agentDrafts.toAddrs,
      createdAt: schema.agentDrafts.createdAt,
    })
    .from(schema.agentDrafts)
    .where(eq(schema.agentDrafts.status, "open"));
  return rows.map((row) => ({
    accountId: row.accountId,
    providerDraftId: row.providerDraftId,
    threadId: row.threadId,
    subject: row.subject,
    to: JSON.parse(row.toAddrs) as string[],
    createdAt: row.createdAt,
  }));
}

export interface SentDraftSnapshot {
  accountId: string;
  providerDraftId: string;
  sentMessageId: string;
}

export async function listUnlearnedSentDrafts(): Promise<SentDraftSnapshot[]> {
  const rows = await db
    .select({
      accountId: schema.agentDrafts.accountId,
      providerDraftId: schema.agentDrafts.providerDraftId,
      sentMessageId: schema.agentDrafts.sentMessageId,
    })
    .from(schema.agentDrafts)
    .where(
      and(
        eq(schema.agentDrafts.status, "sent"),
        isNull(schema.agentDrafts.learnedAt),
        isNotNull(schema.agentDrafts.sentMessageId),
      ),
    );
  return rows
    .filter((row): row is typeof row & { sentMessageId: string } => Boolean(row.sentMessageId))
    .map((row) => ({
      accountId: row.accountId,
      providerDraftId: row.providerDraftId,
      sentMessageId: row.sentMessageId as string,
    }));
}

/** The latest version's body regardless of author (the matcher tiebreak's baseline). Null on a miss. */
export async function getLatestDraftBody(
  accountId: string,
  providerDraftId: string,
): Promise<string | null> {
  const row = await findByProviderId(accountId, providerDraftId);
  if (!row) return null;
  const [latest] = await db
    .select({ body: schema.agentDraftVersions.body })
    .from(schema.agentDraftVersions)
    .where(eq(schema.agentDraftVersions.draftId, row.id))
    .orderBy(desc(schema.agentDraftVersions.version))
    .limit(1);
  return latest?.body ?? null;
}

export interface DraftCardDetails {
  threadId?: string;
  subject: string;
  to: string[];
  cc: string[];
  bcc: string[];
  body: string;
}

/**
 * Identity and latest content of a snapshot in the chat draft card's shape:
 * recipients from the row (fixed at creation), subject and body from the newest
 * version. Null on a lookup miss.
 */
export async function getDraftCardDetails(
  accountId: string,
  providerDraftId: string,
): Promise<DraftCardDetails | null> {
  const row = await findByProviderId(accountId, providerDraftId);
  if (!row) return null;
  const [latest] = await db
    .select({ subject: schema.agentDraftVersions.subject, body: schema.agentDraftVersions.body })
    .from(schema.agentDraftVersions)
    .where(eq(schema.agentDraftVersions.draftId, row.id))
    .orderBy(desc(schema.agentDraftVersions.version))
    .limit(1);
  return {
    ...(row.threadId ? { threadId: row.threadId } : {}),
    subject: latest?.subject ?? row.subject,
    to: JSON.parse(row.toAddrs) as string[],
    cc: JSON.parse(row.ccAddrs) as string[],
    bcc: JSON.parse(row.bccAddrs) as string[],
    body: latest?.body ?? "",
  };
}

/**
 * The latest AGENT-authored version's body: what the extraction sweep diffs
 * against the sent message (the lesson is about the model's own wording, not a
 * later user edit). Null on a lookup miss, or (not expected: version 1 is
 * always author "agent") no agent version at all.
 */
export async function getLatestAgentDraftBody(
  accountId: string,
  providerDraftId: string,
): Promise<string | null> {
  const row = await findByProviderId(accountId, providerDraftId);
  if (!row) return null;
  const [latest] = await db
    .select({ body: schema.agentDraftVersions.body })
    .from(schema.agentDraftVersions)
    .where(
      and(
        eq(schema.agentDraftVersions.draftId, row.id),
        eq(schema.agentDraftVersions.author, "agent"),
      ),
    )
    .orderBy(desc(schema.agentDraftVersions.version))
    .limit(1);
  return latest?.body ?? null;
}

export async function markDraftLearned(
  accountId: string,
  providerDraftId: string,
): Promise<boolean> {
  const row = await findByProviderId(accountId, providerDraftId);
  if (!row) return false;
  await db
    .update(schema.agentDrafts)
    .set({ learnedAt: new Date().toISOString() })
    .where(eq(schema.agentDrafts.id, row.id));
  return true;
}
