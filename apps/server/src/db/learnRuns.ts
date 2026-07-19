import { randomUUID } from "node:crypto";
import type { LearnRun } from "@trailin/shared";
import { desc, inArray } from "drizzle-orm";
import { emitServerEvent } from "../core/events.js";
import { db, schema } from "./index.js";

const KEEP_RUNS = 20;

export async function listLearnRuns(): Promise<LearnRun[]> {
  const rows = await db.select().from(schema.learnRuns).orderBy(desc(schema.learnRuns.startedAt));
  return rows as LearnRun[];
}

export async function recordLearnRun(input: Omit<LearnRun, "id">): Promise<LearnRun> {
  const entry: LearnRun = { id: randomUUID(), ...input };
  await db.insert(schema.learnRuns).values(entry);

  const rows = await db
    .select({ id: schema.learnRuns.id })
    .from(schema.learnRuns)
    .orderBy(desc(schema.learnRuns.startedAt));
  const excess = rows.slice(KEEP_RUNS).map((row) => row.id);
  if (excess.length > 0) {
    await db.delete(schema.learnRuns).where(inArray(schema.learnRuns.id, excess));
  }

  emitServerEvent("learn");
  return entry;
}
