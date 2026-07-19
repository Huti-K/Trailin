import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { Todo } from "@trailin/shared";
import { createTodo, listTodos, updateTodo } from "../db/todos.js";
import { textResult, tool } from "./toolkit.js";

const statusSchema = Type.Union(
  [Type.Literal("open"), Type.Literal("done"), Type.Literal("dismissed")],
  { description: 'Status: "open" (needs action), "done", "dismissed" (dropped).' },
);

const dueAtSchema = Type.String({
  description:
    "When the user should do or decide this, as an ISO 8601 date or date-time " +
    '("2026-07-24" or "2026-07-24T15:00"). Set it whenever the todo is time-bound — a ' +
    "deadline, a follow-up date, an appointment — so it lands on the right day of the home " +
    "agenda (overdue items surface at the top). Omit for an anytime todo.",
});

/** Renders a todo with every id the maintenance tools need (todo id, each step id). */
function todoLine(todo: Todo): string {
  const steps = todo.steps.map((s) => `    [${s.done ? "x" : " "}] (${s.id}) ${s.label}`);
  return [
    `- [${todo.id}] ${todo.title} — ${todo.status}${todo.dueAt ? ` — due ${todo.dueAt}` : ""}`,
    ...(todo.body ? [`  ${todo.body}`] : []),
    ...steps,
  ].join("\n");
}

const listTodosTool: AgentTool = tool({
  name: "list_todos",
  label: "List todos",
  description:
    `The user's todo list — everything you filed for them to do or decide, each with its id and ` +
    `its steps' ids. Call this before touching an existing todo (to get the ids) or to check what ` +
    `is still open. Filter by status.`,
  params: { status: Type.Optional(statusSchema) },
  execute: async ({ status }) => {
    const todos = await listTodos({ status });
    if (todos.length === 0) {
      return textResult(status ? `No ${status} todos.` : "The todo list is empty.");
    }
    return textResult(todos.map(todoLine).join("\n"));
  },
});

const updateTodoTool: AgentTool = tool({
  name: "update_todo",
  label: "Update todo",
  description:
    `Maintain a todo you filed — pass its id (from list_todos) and only what changes. Add steps as ` +
    `work appears, tick steps by id as they get done (ticking the last open step completes the ` +
    `todo), rewrite the title/body, or set status "dismissed" to drop it. This is how a later run ` +
    `keeps a standing todo current instead of filing a new one.`,
  params: {
    id: Type.String({ description: "The todo id (from list_todos)." }),
    title: Type.Optional(Type.String()),
    body: Type.Optional(Type.String({ description: "Complete replacement text." })),
    dueAt: Type.Optional(dueAtSchema),
    addSteps: Type.Optional(
      Type.Array(Type.String(), { description: "New checklist items to append." }),
    ),
    completeSteps: Type.Optional(
      Type.Array(Type.String(), { description: "Step ids (from list_todos) to tick." }),
    ),
    status: Type.Optional(statusSchema),
  },
  catchToText: true,
  execute: async ({ id, ...update }) => {
    const todo = await updateTodo(id, update);
    if (!todo) return textResult(`No todo with id ${id} — check list_todos.`);
    return textResult(`Updated todo:\n${todoLine(todo)}`);
  },
});

/**
 * create_todo closes over the session's conversation id so the todo links back
 * to the chat/run that filed it; list/update address todos by id alone. All
 * three stay available to unattended runs — a todo is inert data (like a lead),
 * and a run that hits a decision it can't make files one for the user.
 */
export function buildTodoTools(conversationId: string | undefined): AgentTool[] {
  const createTodoTool: AgentTool = tool({
    name: "create_todo",
    label: "Create todo",
    description:
      `File something the USER must do or decide, as a todo on their home page: a decision only ` +
      `they can make, an offline action (call someone, sign a document), or a multi-step follow-up ` +
      `to track. Reach for this from an unattended run the moment you hit a point that needs a ` +
      `human. Do NOT use it for work you can do yourself (make an automation), an email to review ` +
      `(leave a draft), or a prospect (record a lead). Pass 'steps' for a checklist. Pass a stable ` +
      `'key' from a recurring source so re-runs reuse the one open todo instead of piling up copies.`,
    params: {
      title: Type.String({
        description: 'Short imperative summary, e.g. "Approve refund for order #4821".',
      }),
      body: Type.Optional(
        Type.String({
          description: "Context the user needs to act: what is blocked, what you found.",
        }),
      ),
      steps: Type.Optional(
        Type.Array(Type.String(), {
          description: "Checklist items, each a short action. Omit for a single-decision todo.",
        }),
      ),
      dueAt: Type.Optional(dueAtSchema),
      key: Type.Optional(
        Type.String({
          description:
            'Stable dedup key for a recurring source (e.g. "weekly-returns-sweep"); recreating ' +
            "with the same key reuses the open todo instead of duplicating it.",
        }),
      ),
    },
    catchToText: true,
    execute: async ({ title, body, steps, dueAt, key }) => {
      const { todo, created } = await createTodo({
        title,
        body,
        steps,
        dueAt,
        key,
        conversationId,
      });
      if (!created) {
        return textResult(
          `A todo with this key is already open — reusing it. Use update_todo to add or tick ` +
            `steps:\n${todoLine(todo)}`,
        );
      }
      return textResult(`Created todo:\n${todoLine(todo)}`);
    },
  });

  return [createTodoTool, listTodosTool, updateTodoTool];
}
