import type { Todo } from "@trailin/shared";
import { eq } from "drizzle-orm";
import { badRequest } from "../core/errors.js";
import { moduleLogger } from "../core/logger.js";
import { db, schema } from "../db/index.js";
import { getTodo, type TodoUpdate, updateTodo } from "../db/todos.js";
import { requestRun } from "./automations/scheduler.js";

const log = moduleLogger("todos");

/** Whether an automation with this id exists — a valid link target. */
export async function automationExists(id: string): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.automations.id })
    .from(schema.automations)
    .where(eq(schema.automations.id, id));
  return Boolean(row);
}

/**
 * Apply a todo update, then fire its linked automation if this update just
 * completed it (open→done). The PATCH route and the update_todo tool both go
 * through here, so completion behaves the same however it happens. The run is
 * fire-and-forget and manual, like "Run now": the human's tick authorizes it
 * (bypassing the paused gate); a missing/deleted target no-ops in the runner.
 */
export async function applyTodoUpdate(id: string, update: TodoUpdate): Promise<Todo | null> {
  if (update.linkedAutomationId && !(await automationExists(update.linkedAutomationId))) {
    throw badRequest("no automation with this id");
  }
  const before = await getTodo(id);
  const todo = await updateTodo(id, update);
  if (todo?.linkedAutomationId && before?.status !== "done" && todo.status === "done") {
    const automationId = todo.linkedAutomationId;
    // requestRun queues (never drops) and hands the run the todo it fired for.
    requestRun(automationId, { kind: "todo", todoId: todo.id, title: todo.title }).catch((error) =>
      log.error(error, `linked automation ${automationId} for todo ${todo.id} failed`),
    );
  }
  return todo;
}
