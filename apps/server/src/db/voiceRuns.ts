import type { VoiceLearnRun } from "@trailin/shared";
import { eq } from "drizzle-orm";
import { emitServerEvent } from "../core/events.js";
import { db, schema } from "./index.js";

export async function listVoiceLearnRuns(): Promise<VoiceLearnRun[]> {
  const rows = await db.select().from(schema.voiceLearnRuns);
  return rows as VoiceLearnRun[];
}

export async function markVoiceLearnRunning(accountId: string): Promise<void> {
  const row: VoiceLearnRun = {
    accountId,
    status: "running",
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  await db
    .insert(schema.voiceLearnRuns)
    .values(row)
    .onConflictDoUpdate({
      target: schema.voiceLearnRuns.accountId,
      set: { status: row.status, error: null, startedAt: row.startedAt, finishedAt: null },
    });
  emitServerEvent("learn");
}

export async function finishVoiceLearnRun(
  accountId: string,
  error: string | null = null,
): Promise<void> {
  await db
    .update(schema.voiceLearnRuns)
    .set({
      status: error === null ? "ok" : "error",
      error,
      finishedAt: new Date().toISOString(),
    })
    .where(eq(schema.voiceLearnRuns.accountId, accountId));
  emitServerEvent("learn");
}

export async function deleteVoiceLearnRun(accountId: string): Promise<void> {
  await db.delete(schema.voiceLearnRuns).where(eq(schema.voiceLearnRuns.accountId, accountId));
  emitServerEvent("learn");
}

/**
 * Close out attempts left "running" by a mid-run restart, so they surface as
 * retryable errors instead of spinning forever. Called once at boot.
 */
export async function failInterruptedVoiceLearnRuns(): Promise<void> {
  const rows = await db
    .select()
    .from(schema.voiceLearnRuns)
    .where(eq(schema.voiceLearnRuns.status, "running"));
  for (const row of rows) {
    await finishVoiceLearnRun(row.accountId, "interrupted by a server restart");
  }
}
