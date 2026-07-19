import { randomUUID } from "node:crypto";
import type { Todo, TodoStatus, TodoStep } from "@trailin/shared";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { emitServerEvent } from "../core/events.js";
import { db, schema } from "./index.js";

type TodoRow = typeof schema.todos.$inferSelect;
type StepRow = typeof schema.todoSteps.$inferSelect;

function toStep(row: StepRow): TodoStep {
  return { id: row.id, label: row.label, done: row.done };
}

function assemble(todo: TodoRow, steps: StepRow[]): Todo {
  return {
    id: todo.id,
    title: todo.title,
    body: todo.body,
    status: todo.status,
    dueAt: todo.dueAt,
    conversationId: todo.conversationId,
    steps: steps.map(toStep),
    createdAt: todo.createdAt,
    updatedAt: todo.updatedAt,
  };
}

export async function listTodos(filter: { status?: TodoStatus } = {}): Promise<Todo[]> {
  const base = db.select().from(schema.todos);
  const todoRows = await (filter.status
    ? base.where(eq(schema.todos.status, filter.status))
    : base
  ).orderBy(desc(schema.todos.updatedAt));
  if (todoRows.length === 0) return [];

  const stepRows = await db
    .select()
    .from(schema.todoSteps)
    .where(
      inArray(
        schema.todoSteps.todoId,
        todoRows.map((t) => t.id),
      ),
    )
    .orderBy(asc(schema.todoSteps.ordinal));

  const byTodo = new Map<string, StepRow[]>();
  for (const step of stepRows) {
    const list = byTodo.get(step.todoId);
    if (list) list.push(step);
    else byTodo.set(step.todoId, [step]);
  }
  return todoRows.map((todo) => assemble(todo, byTodo.get(todo.id) ?? []));
}

export async function getTodo(id: string): Promise<Todo | null> {
  const [row] = await db.select().from(schema.todos).where(eq(schema.todos.id, id));
  if (!row) return null;
  const steps = await db
    .select()
    .from(schema.todoSteps)
    .where(eq(schema.todoSteps.todoId, id))
    .orderBy(asc(schema.todoSteps.ordinal));
  return assemble(row, steps);
}

/** An open todo carrying this dedup key, so a repeating run reuses it instead of duplicating. */
async function findOpenTodoByKey(key: string): Promise<Todo | null> {
  if (!key) return null;
  const [row] = await db
    .select()
    .from(schema.todos)
    .where(and(eq(schema.todos.dedupeKey, key), eq(schema.todos.status, "open")));
  return row ? getTodo(row.id) : null;
}

export interface TodoInput {
  title: string;
  body?: string;
  steps?: string[];
  dueAt?: string | null;
  conversationId?: string | null;
  key?: string;
}

export async function createTodo(input: TodoInput): Promise<{ todo: Todo; created: boolean }> {
  const key = input.key?.trim() ?? "";
  const existing = await findOpenTodoByKey(key);
  if (existing) return { todo: existing, created: false };

  const now = new Date().toISOString();
  const id = randomUUID();
  await db.insert(schema.todos).values({
    id,
    title: input.title.trim(),
    body: input.body?.trim() ?? "",
    status: "open",
    dueAt: input.dueAt ?? null,
    conversationId: input.conversationId ?? null,
    dedupeKey: key,
    createdAt: now,
    updatedAt: now,
  });

  const labels = (input.steps ?? []).map((label) => label.trim()).filter(Boolean);
  if (labels.length > 0) await insertSteps(id, 0, labels, now);

  emitServerEvent("todos");
  // getTodo can't be null immediately after the insert.
  return { todo: (await getTodo(id)) as Todo, created: true };
}

function insertSteps(
  todoId: string,
  from: number,
  labels: string[],
  now: string,
): Promise<unknown> {
  return db.insert(schema.todoSteps).values(
    labels.map((label, i) => ({
      id: randomUUID(),
      todoId,
      ordinal: from + i,
      label,
      done: false,
      createdAt: now,
    })),
  );
}

export interface TodoUpdate {
  title?: string;
  body?: string;
  status?: TodoStatus;
  /** ISO due date/time; "" or null clears it. */
  dueAt?: string | null;
  addSteps?: string[];
  /** Step ids to tick. */
  completeSteps?: string[];
  /** Step ids to untick. */
  reopenSteps?: string[];
}

/**
 * The single maintenance verb (agent tool, routes, and step toggles all route
 * here). Status is derived from the steps — all ticked → done, any open → open
 * — unless the caller sets it explicitly or the todo is dismissed.
 */
export async function updateTodo(id: string, update: TodoUpdate): Promise<Todo | null> {
  const existing = await getTodo(id);
  if (!existing) return null;
  const now = new Date().toISOString();

  const added = (update.addSteps ?? []).map((label) => label.trim()).filter(Boolean);
  if (added.length > 0) await insertSteps(id, existing.steps.length, added, now);
  await setStepsDone(id, update.completeSteps, true);
  await setStepsDone(id, update.reopenSteps, false);

  const fields: Partial<TodoRow> = { updatedAt: now };
  if (update.title !== undefined) fields.title = update.title.trim();
  if (update.body !== undefined) fields.body = update.body.trim();
  if (update.dueAt !== undefined) fields.dueAt = update.dueAt || null;
  if (update.status !== undefined) fields.status = update.status;
  else fields.status = await derivedStatus(id, existing.status);
  await db.update(schema.todos).set(fields).where(eq(schema.todos.id, id));

  emitServerEvent("todos");
  return getTodo(id);
}

function setStepsDone(
  todoId: string,
  stepIds: string[] | undefined,
  done: boolean,
): Promise<unknown> {
  if (!stepIds || stepIds.length === 0) return Promise.resolve();
  return db
    .update(schema.todoSteps)
    .set({ done })
    .where(and(eq(schema.todoSteps.todoId, todoId), inArray(schema.todoSteps.id, stepIds)));
}

/** all steps ticked → done, any open → open; a dismissed or step-less todo keeps its status. */
async function derivedStatus(id: string, current: TodoStatus): Promise<TodoStatus> {
  if (current === "dismissed") return current;
  const steps = await db.select().from(schema.todoSteps).where(eq(schema.todoSteps.todoId, id));
  if (steps.length === 0) return current;
  return steps.every((step) => step.done) ? "done" : "open";
}
