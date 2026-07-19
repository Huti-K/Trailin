import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { badRequest, conflict, requireRow } from "../../core/errors.js";
import { emitServerEvent } from "../../core/events.js";
import { deleteConversationCascade } from "../../db/conversationStore.js";
import { db, lazyTransaction, schema, sqlite } from "../../db/index.js";
import { isRunInFlight, isValidCron, refreshSchedule, unschedule } from "./scheduler.js";

export type AutomationRow = typeof schema.automations.$inferSelect;

export interface AutomationInput {
  name: string;
  instruction: string;
  /** Five-field cron; empty/omitted means manual-only, never on a schedule. */
  schedule?: string;
  enabled?: boolean;
  showInActivity?: boolean;
  pinned?: boolean;
  runOnNewMail?: boolean;
  notifyOnCompletion?: boolean;
  leadId?: string | null;
}

export interface AutomationPatch {
  name?: string;
  instruction?: string;
  schedule?: string;
  enabled?: boolean;
  showInActivity?: boolean;
  pinned?: boolean;
  runOnNewMail?: boolean;
  notifyOnCompletion?: boolean;
  position?: number;
}

/**
 * At most one automation is pinned. Unpinning every other row and pinning this
 * one run as one transaction, so concurrent pins can't both leave a row pinned.
 */
const pinExclusively = lazyTransaction((id: string) => {
  sqlite.prepare("UPDATE automations SET pinned = 0 WHERE id != ?").run(id);
  sqlite.prepare("UPDATE automations SET pinned = 1 WHERE id = ?").run(id);
});

export async function createAutomation(input: AutomationInput): Promise<AutomationRow> {
  const name = input.name.trim();
  const instruction = input.instruction.trim();
  const schedule = input.schedule?.trim() ?? "";
  if (!name || !instruction) {
    throw badRequest("name and instruction are required");
  }
  if (schedule && !isValidCron(schedule)) {
    throw badRequest(`invalid cron expression: ${input.schedule}`);
  }
  if (input.leadId) {
    const [lead] = await db
      .select({ id: schema.leads.id })
      .from(schema.leads)
      .where(eq(schema.leads.id, input.leadId));
    if (!lead) throw badRequest(`no lead with id ${input.leadId}`);
  }
  const automation: AutomationRow = {
    id: randomUUID(),
    name,
    instruction,
    schedule,
    enabled: input.enabled ?? true,
    showInActivity: input.showInActivity ?? true,
    pinned: input.pinned ?? false,
    runOnNewMail: input.runOnNewMail ?? false,
    notifyOnCompletion: input.notifyOnCompletion ?? false,
    leadId: input.leadId ?? null,
    position: -Date.now(),
    createdAt: new Date().toISOString(),
  };
  await db.insert(schema.automations).values(automation);
  if (automation.pinned) pinExclusively(automation.id);
  await refreshSchedule(automation.id);
  // Run views (feed, pinned, missed) embed automation fields, so an
  // automation mutation is also a runs-data mutation.
  emitServerEvent("automations");
  emitServerEvent("runs");
  return automation;
}

export async function updateAutomation(id: string, patch: AutomationPatch): Promise<AutomationRow> {
  const updates: Partial<AutomationRow> = {};
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw badRequest("name must not be empty");
    updates.name = name;
  }
  if (patch.instruction !== undefined) {
    const instruction = patch.instruction.trim();
    if (!instruction) throw badRequest("instruction must not be empty");
    updates.instruction = instruction;
  }
  if (patch.schedule !== undefined) {
    const schedule = patch.schedule.trim();
    if (schedule && !isValidCron(schedule)) {
      throw badRequest(`invalid cron expression: ${patch.schedule}`);
    }
    updates.schedule = schedule;
  }
  if (patch.enabled !== undefined) updates.enabled = patch.enabled;
  if (patch.showInActivity !== undefined) updates.showInActivity = patch.showInActivity;
  if (patch.pinned !== undefined) updates.pinned = patch.pinned;
  if (patch.runOnNewMail !== undefined) updates.runOnNewMail = patch.runOnNewMail;
  if (patch.notifyOnCompletion !== undefined) {
    updates.notifyOnCompletion = patch.notifyOnCompletion;
  }
  if (patch.position !== undefined) updates.position = patch.position;
  if (Object.keys(updates).length === 0) throw badRequest("nothing to update");

  // Must run before any mutation: a pinned:true update for a nonexistent id
  // would otherwise unpin every real automation via pinExclusively and still
  // report not found.
  await requireRow(
    db
      .select({ id: schema.automations.id })
      .from(schema.automations)
      .where(eq(schema.automations.id, id)),
    "not found",
  );

  await db.update(schema.automations).set(updates).where(eq(schema.automations.id, id));
  if (updates.pinned === true) pinExclusively(id);
  await refreshSchedule(id);
  emitServerEvent("automations");
  emitServerEvent("runs");

  return requireRow(
    db.select().from(schema.automations).where(eq(schema.automations.id, id)),
    "not found",
  );
}

export async function deleteAutomation(id: string): Promise<boolean> {
  const [existing] = await db
    .select({ id: schema.automations.id })
    .from(schema.automations)
    .where(eq(schema.automations.id, id));
  if (!existing) return false;

  // A run executing now would write its run and conversation rows after the
  // cascade below, orphaning rows nothing cleans up; refuse instead of racing.
  if (isRunInFlight(id)) {
    throw conflict("a run of this automation is in progress");
  }

  unschedule(id);

  // Each run created a conversation (id = run id) with its message rows;
  // nothing else cleans those up, so without this they'd linger forever in the
  // chat sidebar, orphaned from a deleted automation.
  const runs = await db
    .select({ id: schema.automationRuns.id })
    .from(schema.automationRuns)
    .where(eq(schema.automationRuns.automationId, id));
  for (const run of runs) deleteConversationCascade(run.id);

  await db.delete(schema.automations).where(eq(schema.automations.id, id));
  await db.delete(schema.automationRuns).where(eq(schema.automationRuns.automationId, id));
  emitServerEvent("automations");
  emitServerEvent("runs");
  return true;
}
