import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { db, schema, sqlite } from "../db/index.js";
import { parseStoredCards } from "../agent/cards.js";
import { emitServerEvent } from "../events.js";
import {
  getNextRunAt,
  isValidCron,
  refreshSchedule,
  runAutomation,
  unschedule,
} from "../automations/scheduler.js";
import { escapeLikeInput, likePattern } from "../util.js";

interface AutomationBody {
  name: string;
  instruction: string;
  schedule: string;
  enabled?: boolean;
  showInActivity?: boolean;
  pinned?: boolean;
}

/**
 * Exactly one automation may be pinned. Clearing every other row and setting
 * this one happen as a single SQLite transaction so two concurrent "pin"
 * requests can never both leave a row pinned — whichever transaction commits
 * last wins, and the invariant (at most one pinned row) always holds.
 */
const pinExclusively = sqlite.transaction((id: string) => {
  sqlite.prepare("UPDATE automations SET pinned = 0 WHERE id != ?").run(id);
  sqlite.prepare("UPDATE automations SET pinned = 1 WHERE id = ?").run(id);
});

export async function automationRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/automations", async () => {
    const rows = await db
      .select()
      .from(schema.automations)
      .orderBy(desc(schema.automations.createdAt));
    return rows.map((row) => ({ ...row, nextRunAt: getNextRunAt(row.id) }));
  });

  /** Cross-automation run feed for the Home activity section. */
  app.get<{ Querystring: { q?: string; limit?: string; offset?: string } }>(
    "/api/runs",
    async (req) => {
      const q = req.query.q?.trim();
      const limit = Math.min(Math.max(parseInt(req.query.limit ?? "", 10) || 30, 1), 100);
      const offset = Math.max(parseInt(req.query.offset ?? "", 10) || 0, 0);

      // Hide runs from automations the user has excluded from the activity feed.
      // leftJoin → a run whose automation was deleted has NULL columns; keep those.
      const visible = or(
        isNull(schema.automations.showInActivity),
        eq(schema.automations.showInActivity, true),
      );
      // SQLite's LIKE is case-insensitive for ASCII by default, which covers the
      // digest text this searches over.
      const pattern = q ? `%${escapeLikeInput(q)}%` : undefined;
      const where = pattern
        ? and(
            visible,
            or(
              likePattern(schema.automationRuns.result, pattern),
              likePattern(schema.automations.name, pattern),
            ),
          )
        : visible;

      const itemsQuery = db
        .select({
          id: schema.automationRuns.id,
          automationId: schema.automationRuns.automationId,
          status: schema.automationRuns.status,
          result: schema.automationRuns.result,
          cards: schema.automationRuns.cards,
          startedAt: schema.automationRuns.startedAt,
          finishedAt: schema.automationRuns.finishedAt,
          automationName: schema.automations.name,
        })
        .from(schema.automationRuns)
        .leftJoin(schema.automations, eq(schema.automations.id, schema.automationRuns.automationId));
      const rows = await itemsQuery
        .where(where)
        .orderBy(desc(schema.automationRuns.startedAt))
        .limit(limit)
        .offset(offset);
      const items = rows.map(({ cards, ...row }) => ({ ...row, cards: parseStoredCards(cards) }));

      const totalQuery = db
        .select({ count: sql<number>`count(*)` })
        .from(schema.automationRuns)
        .leftJoin(schema.automations, eq(schema.automations.id, schema.automationRuns.automationId));
      const [totalRow] = await totalQuery.where(where);

      return { items, total: Number(totalRow?.count ?? 0) };
    },
  );

  /**
   * The pinned automation's latest successful run, for the Home page lead
   * card. Deliberately bypasses both filters /api/runs applies: it is not
   * hidden by showInActivity (pinning is an explicit, stronger signal), and
   * it is not subject to that endpoint's pagination limit, so an old pinned
   * run can never fall out of view.
   */
  app.get("/api/runs/pinned", async () => {
    const [automation] = await db
      .select()
      .from(schema.automations)
      .where(eq(schema.automations.pinned, true));
    if (!automation) return { run: null, automation: null };

    const [run] = await db
      .select({
        id: schema.automationRuns.id,
        automationId: schema.automationRuns.automationId,
        status: schema.automationRuns.status,
        result: schema.automationRuns.result,
        cards: schema.automationRuns.cards,
        startedAt: schema.automationRuns.startedAt,
        finishedAt: schema.automationRuns.finishedAt,
        automationName: schema.automations.name,
      })
      .from(schema.automationRuns)
      .leftJoin(schema.automations, eq(schema.automations.id, schema.automationRuns.automationId))
      .where(
        and(
          eq(schema.automationRuns.automationId, automation.id),
          eq(schema.automationRuns.status, "success"),
          ne(schema.automationRuns.result, ""),
        ),
      )
      .orderBy(desc(schema.automationRuns.startedAt))
      .limit(1);

    return {
      run: run ? { ...run, cards: parseStoredCards(run.cards) } : null,
      automation: { ...automation, nextRunAt: getNextRunAt(automation.id) },
    };
  });

  app.post<{ Body: AutomationBody }>("/api/automations", async (req, reply) => {
    const { name, instruction, schedule } = req.body ?? {};
    if (!name?.trim() || !instruction?.trim() || !schedule?.trim()) {
      return reply.code(400).send({ error: "name, instruction and schedule are required" });
    }
    if (!isValidCron(schedule.trim())) {
      return reply.code(400).send({ error: `invalid cron expression: ${schedule}` });
    }
    const automation = {
      id: randomUUID(),
      name: name.trim(),
      instruction: instruction.trim(),
      schedule: schedule.trim(),
      enabled: req.body.enabled ?? true,
      showInActivity: req.body.showInActivity ?? true,
      pinned: req.body.pinned ?? false,
      createdAt: new Date().toISOString(),
    };
    await db.insert(schema.automations).values(automation);
    if (automation.pinned) pinExclusively(automation.id);
    await refreshSchedule(automation.id);
    emitServerEvent("automations");
    return automation;
  });

  app.patch<{ Params: { id: string }; Body: Partial<AutomationBody> }>(
    "/api/automations/:id",
    async (req, reply) => {
      const updates: Record<string, unknown> = {};
      if (req.body.name !== undefined) {
        const name = req.body.name?.trim();
        if (!name) {
          return reply.code(400).send({ error: "name must not be empty" });
        }
        updates.name = name;
      }
      if (req.body.instruction !== undefined) {
        const instruction = req.body.instruction?.trim();
        if (!instruction) {
          return reply.code(400).send({ error: "instruction must not be empty" });
        }
        updates.instruction = instruction;
      }
      if (req.body.schedule !== undefined) {
        if (!isValidCron(req.body.schedule.trim())) {
          return reply.code(400).send({ error: `invalid cron expression: ${req.body.schedule}` });
        }
        updates.schedule = req.body.schedule.trim();
      }
      if (req.body.enabled !== undefined) updates.enabled = req.body.enabled;
      if (req.body.showInActivity !== undefined) updates.showInActivity = req.body.showInActivity;
      if (req.body.pinned !== undefined) updates.pinned = req.body.pinned;
      if (Object.keys(updates).length === 0) {
        return reply.code(400).send({ error: "nothing to update" });
      }

      // Must run before any mutation: pinExclusively unpins every other row,
      // so a PATCH for a nonexistent id must never reach it — otherwise a
      // pinned: true request for a bad id would unpin every real automation
      // and then still 404.
      const [existing] = await db
        .select({ id: schema.automations.id })
        .from(schema.automations)
        .where(eq(schema.automations.id, req.params.id));
      if (!existing) {
        return reply.code(404).send({ error: "not found" });
      }

      await db
        .update(schema.automations)
        .set(updates)
        .where(eq(schema.automations.id, req.params.id));
      if (updates.pinned === true) pinExclusively(req.params.id);
      await refreshSchedule(req.params.id);
      emitServerEvent("automations");

      const [automation] = await db
        .select()
        .from(schema.automations)
        .where(eq(schema.automations.id, req.params.id));
      return automation ?? reply.code(404).send({ error: "not found" });
    },
  );

  app.delete<{ Params: { id: string } }>("/api/automations/:id", async (req) => {
    unschedule(req.params.id);

    // Each run also created a conversation (id = run id) plus its user/
    // assistant message rows (see automations/scheduler.ts) — nothing else
    // ever cleans those up, so without this they'd linger forever in the
    // chat sidebar's Automations section, orphaned from a deleted automation.
    const runs = await db
      .select({ id: schema.automationRuns.id })
      .from(schema.automationRuns)
      .where(eq(schema.automationRuns.automationId, req.params.id));
    const runIds = runs.map((run) => run.id);
    if (runIds.length > 0) {
      await db.delete(schema.messages).where(inArray(schema.messages.conversationId, runIds));
      await db.delete(schema.conversations).where(inArray(schema.conversations.id, runIds));
    }

    await db.delete(schema.automations).where(eq(schema.automations.id, req.params.id));
    await db
      .delete(schema.automationRuns)
      .where(eq(schema.automationRuns.automationId, req.params.id));
    emitServerEvent("automations");
    if (runIds.length > 0) emitServerEvent("conversations");
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/automations/:id/run", async (req, reply) => {
    const [automation] = await db
      .select({ id: schema.automations.id })
      .from(schema.automations)
      .where(eq(schema.automations.id, req.params.id));
    if (!automation) {
      return reply.code(404).send({ error: "not found" });
    }
    // Fire and forget; the UI polls the runs list.
    runAutomation(req.params.id, { manual: true }).catch((error) =>
      req.log.error(error, `manual run of ${req.params.id} failed`),
    );
    return reply.code(202).send({ ok: true });
  });

  app.get<{ Params: { id: string } }>("/api/automations/:id/runs", async (req) => {
    const rows = await db
      .select()
      .from(schema.automationRuns)
      .where(eq(schema.automationRuns.automationId, req.params.id))
      .orderBy(desc(schema.automationRuns.startedAt))
      .limit(20);
    return rows.map(({ cards, ...row }) => ({ ...row, cards: parseStoredCards(cards) }));
  });
}
