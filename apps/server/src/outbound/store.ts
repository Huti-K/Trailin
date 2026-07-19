import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";

/**
 * Pending outbound messages for comm channels without a native provider draft
 * (WhatsApp today). The row is inert until a human clicks Send on its card, or
 * an armed autosend dispatches it; the channel registry (outbound/registry.ts)
 * owns the actual sending. Email keeps its own provider-draft path.
 */

export type OutboundStatus = "open" | "sent" | "discarded";

export interface OutboundDraft {
  id: string;
  channel: string;
  target: string;
  targetLabel: string;
  body: string;
  status: OutboundStatus;
  sentRef: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OutboundDraftInput {
  channel: string;
  /** Channel-native recipient address (a WhatsApp jid). */
  target: string;
  targetLabel?: string;
  body: string;
}

export async function createOutboundDraft(input: OutboundDraftInput): Promise<OutboundDraft> {
  const now = new Date().toISOString();
  const draft: OutboundDraft = {
    id: randomUUID(),
    channel: input.channel,
    target: input.target,
    targetLabel: input.targetLabel?.trim() ?? "",
    body: input.body,
    status: "open",
    sentRef: null,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(schema.outboundDrafts).values(draft);
  return draft;
}

export async function getOutboundDraft(id: string): Promise<OutboundDraft | null> {
  const [row] = await db
    .select()
    .from(schema.outboundDrafts)
    .where(eq(schema.outboundDrafts.id, id));
  return (row as OutboundDraft | undefined) ?? null;
}

export async function markOutboundStatus(
  id: string,
  status: OutboundStatus,
  sentRef?: string,
): Promise<boolean> {
  const existing = await getOutboundDraft(id);
  if (!existing) return false;
  await db
    .update(schema.outboundDrafts)
    .set({
      status,
      ...(sentRef !== undefined ? { sentRef } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.outboundDrafts.id, id));
  return true;
}
