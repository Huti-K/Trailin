import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Todo } from "@trailin/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Todos through the real API + store: the agent files/maintains them (the store
 * seam), the web lists and toggles them (the routes). Locks the behaviors that
 * would hurt — ordered checklist, key idempotency, step-driven completion.
 */

let store: typeof import("../../src/db/todos.js");
let app: Awaited<ReturnType<typeof import("../../src/app.js").buildApp>>;

beforeAll(async () => {
  const scratch = await mkdtemp(join(tmpdir(), "trailin-todos-test-"));
  process.env.AGENT_HOME_PATH = join(scratch, "Trailin");
  process.env.DATABASE_PATH = join(scratch, "test.db");
  store = await import("../../src/db/todos.js");
  app = await (await import("../../src/app.js")).buildApp();
});

afterAll(async () => {
  await app?.close();
});

const listOpen = async (): Promise<Todo[]> =>
  (await app.inject({ method: "GET", url: "/api/todos?status=open" })).json<Todo[]>();

const patch = async (id: string, body: Record<string, unknown>) =>
  app.inject({ method: "PATCH", url: `/api/todos/${encodeURIComponent(id)}`, payload: body });

describe("todos", () => {
  it("creates a todo with an ordered checklist and lists it open", async () => {
    const { todo, created } = await store.createTodo({
      title: "Onboard Acme",
      body: "Waiting on the signed contract.",
      steps: ["Collect W-9", "Send welcome email", "Schedule kickoff"],
    });
    expect(created).toBe(true);

    const listed = (await listOpen()).find((t) => t.id === todo.id);
    expect(listed).toBeDefined();
    if (!listed) return;
    expect(listed.title).toBe("Onboard Acme");
    expect(listed.status).toBe("open");
    expect(listed.steps.map((s) => s.label)).toEqual([
      "Collect W-9",
      "Send welcome email",
      "Schedule kickoff",
    ]);
    expect(listed.steps.every((s) => !s.done)).toBe(true);
  });

  it("is idempotent on key: recreating reuses the one open todo", async () => {
    const first = await store.createTodo({ title: "Weekly sweep", key: "returns-sweep" });
    const second = await store.createTodo({ title: "Weekly sweep again", key: "returns-sweep" });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.todo.id).toBe(first.todo.id);
    // Reused, not recreated: the title stays the original and only one row is open.
    expect(second.todo.title).toBe("Weekly sweep");
    expect((await listOpen()).filter((t) => t.id === first.todo.id)).toHaveLength(1);
  });

  it("auto-completes when the last step is ticked, then reopens when unticked", async () => {
    const { todo } = await store.createTodo({ title: "Two-step", steps: ["a", "b"] });
    const [a, b] = todo.steps.map((s) => s.id);

    expect((await patch(todo.id, { completeSteps: [a] })).json<Todo>().status).toBe("open");
    expect((await patch(todo.id, { completeSteps: [b] })).json<Todo>().status).toBe("done");
    expect((await listOpen()).some((t) => t.id === todo.id)).toBe(false);

    expect((await patch(todo.id, { reopenSteps: [b] })).json<Todo>().status).toBe("open");
    expect((await listOpen()).some((t) => t.id === todo.id)).toBe(true);
  });

  it("dismisses a todo, removing it from the open list", async () => {
    const { todo } = await store.createTodo({ title: "Dismiss me" });
    expect((await patch(todo.id, { status: "dismissed" })).json<Todo>().status).toBe("dismissed");
    expect((await listOpen()).some((t) => t.id === todo.id)).toBe(false);
  });

  it("stores a due date and clears it", async () => {
    const { todo } = await store.createTodo({
      title: "Call the notary",
      dueAt: "2026-07-24T15:00",
    });
    expect((await listOpen()).find((x) => x.id === todo.id)?.dueAt).toBe("2026-07-24T15:00");
    const cleared = (await patch(todo.id, { dueAt: null })).json<Todo>();
    expect(cleared.dueAt).toBeNull();
  });

  it("404s a patch to an unknown todo", async () => {
    expect((await patch("does-not-exist", { status: "dismissed" })).statusCode).toBe(404);
  });
});
