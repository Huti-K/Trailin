import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, isNull, max } from "drizzle-orm";
import { db, schema } from "./index.js";

/**
 * Snapshot store for agent-written drafts (agent_drafts +
 * agent_draft_versions). The provider remains source of truth for the live
 * drafts list; these rows preserve what the agent composed so the
 * draft-vs-sent learning loop can diff against it after the provider draft
 * has been edited, sent, or deleted. Only drafts created through the agent's
 * create-draft tool have a row here — a lookup miss means "not agent-written"
 * and every writer below treats that as a silent no-op, never an error:
 * snapshot bookkeeping must not fail the provider action it rides on.
 *
 * Rows are keyed internally by uuid but addressed by callers as
 * (accountId, providerDraftId) — the identity the routes and tools actually
 * hold. Version rows are append-only; fields a patch omits carry forward from
 * the latest version so every row is a complete (subject, body) as-written.
 */

export type DraftVersionAuthor = "agent" | "user";
export type DraftStatus = "open" | "sent" | "discarded";

export interface DraftSnapshotInput {
  accountId: string;
  providerDraftId: string;
  providerMessageId?: string;
  /** Provider thread id for reply drafts; omitted for standalone mail. */
  threadId?: string;
  subject: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  /** The account's configured signature at compose time; null when none. */
  signature: string | null;
  /** The body exactly as written to the provider (post-humanize, signature included). */
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

/** Insert the snapshot row and its version 1 (author "agent"). */
export async function createDraftSnapshot(input: DraftSnapshotInput): Promise<void> {
  const now = new Date().toISOString();
  const id = randomUUID();
  await db.insert(schema.agentDrafts).values({
    id,
    accountId: input.accountId,
    providerDraftId: input.providerDraftId,
    providerMessageId: input.providerMessageId ?? null,
    threadId: input.threadId ?? null,
    subject: input.subject,
    toAddrs: JSON.stringify(input.to),
    ccAddrs: JSON.stringify(input.cc ?? []),
    bccAddrs: JSON.stringify(input.bcc ?? []),
    signature: input.signature,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.agentDraftVersions).values({
    draftId: id,
    version: 1,
    author: "agent",
    subject: input.subject,
    body: input.body,
    createdAt: now,
  });
}

/**
 * Append one version row for an in-app write (UI edit or agent rewrite).
 * Fields the patch omits carry forward from the latest version. Returns false
 * when the draft has no snapshot (not agent-written).
 */
export async function appendDraftVersion(
  accountId: string,
  providerDraftId: string,
  author: DraftVersionAuthor,
  patch: { body?: string; subject?: string },
): Promise<boolean> {
  const row = await findByProviderId(accountId, providerDraftId);
  if (!row) return false;

  const [latest] = await db
    .select({ version: max(schema.agentDraftVersions.version) })
    .from(schema.agentDraftVersions)
    .where(eq(schema.agentDraftVersions.draftId, row.id));
  const latestVersion = latest?.version ?? 0;
  const [current] = await db
    .select()
    .from(schema.agentDraftVersions)
    .where(
      and(
        eq(schema.agentDraftVersions.draftId, row.id),
        eq(schema.agentDraftVersions.version, latestVersion),
      ),
    );

  const now = new Date().toISOString();
  await db.insert(schema.agentDraftVersions).values({
    draftId: row.id,
    version: latestVersion + 1,
    author,
    subject: patch.subject ?? current?.subject ?? row.subject,
    body: patch.body ?? current?.body ?? "",
    createdAt: now,
  });
  await db
    .update(schema.agentDrafts)
    .set({ updatedAt: now })
    .where(eq(schema.agentDrafts.id, row.id));
  return true;
}

/**
 * Record the draft's fate. In-app sends pass the provider's sent message id
 * so the learning loop never has to match those; external sends are matched
 * later by the loop itself. Returns false when there is no snapshot.
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

/** Attach the conversation whose turn created the draft. Returns false on a lookup miss. */
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

/** The draft's recorded fate, or null when it has no snapshot. */
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
 * providerDraftId -> conversationId for every given draft whose snapshot has
 * a link to a conversation that still exists (a deleted chat degrades to "no
 * link" instead of navigating into a dead id).
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

/**
 * Reads and mark-helpers for the draft-vs-sent learning loop
 * (email/learn/matcher.ts, email/learn/extractor.ts). The matcher sweeps
 * every open snapshot looking for the mail it turned into; the extractor
 * sweeps every sent-but-unlearned snapshot to diff against what the mirror
 * says was actually sent.
 */

export interface OpenDraftSnapshot {
  accountId: string;
  providerDraftId: string;
  /** Provider thread id for reply drafts; null for standalone mail. */
  threadId: string | null;
  subject: string;
  to: string[];
  createdAt: string;
}

/** Every snapshot still awaiting a match — the matcher's per-sweep candidate pool. */
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
  signature: string | null;
}

/** Sent snapshots the nightly extraction sweep hasn't consumed yet. */
export async function listUnlearnedSentDrafts(): Promise<SentDraftSnapshot[]> {
  const rows = await db
    .select({
      accountId: schema.agentDrafts.accountId,
      providerDraftId: schema.agentDrafts.providerDraftId,
      sentMessageId: schema.agentDrafts.sentMessageId,
      signature: schema.agentDrafts.signature,
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
      signature: row.signature,
    }));
}

/** The latest version's body regardless of author — the matcher tiebreak's baseline. Null on a lookup miss. */
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
 * Identity and latest content of a snapshot in the shape the chat's draft
 * card needs — recipients from the row (they never change after creation),
 * subject and body from the newest version. Null on a lookup miss (not
 * agent-written).
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
 * The latest AGENT-authored version's body — what the extraction sweep diffs
 * against the sent message, since the lesson is about how the model's own
 * wording differs from what actually went out, not a later user edit. Null
 * when the draft has no snapshot, or (never expected in practice — version 1
 * is always author "agent") no agent-authored version at all.
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

/** Stamp learned_at on a snapshot the extraction sweep has processed. Returns false on a lookup miss. */
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
