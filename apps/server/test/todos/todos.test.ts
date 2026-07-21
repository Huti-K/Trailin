import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Todo } from "@marlen/shared";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Todos through the real API + store: the agent files/maintains them (the store
 * seam), the web lists and toggles them (the routes). Locks the behaviors that
 * would hurt — key idempotency, completion firing a linked automation, and the
 * sub-todo retirement migration folding content forward instead of dropping it.
 */

let store: typeof import("../../src/db/todos.js");
let manage: typeof import("../../src/services/automations/manage.js");
let app: Awaited<ReturnType<typeof import("../../src/app.js").buildApp>>;

beforeAll(async () => {
  const scratch = await mkdtemp(join(tmpdir(), "marlen-todos-test-"));
  process.env.AGENT_HOME_PATH = join(scratch, "Marlen");
  process.env.DATABASE_PATH = join(scratch, "test.db");
  store = await import("../../src/db/todos.js");
  manage = await import("../../src/services/automations/manage.js");
  app = await (await import("../../src/app.js")).buildApp();
  // buildApp wires no turn runner (that happens at boot); a fake lets a linked
  // automation's run complete without a real LLM.
  const { registerTurnRunner } = await import("../../src/services/automations/turnRunner.js");
  registerTurnRunner(async () => ({ text: "linked run ok", cardsJson: null }));
});

afterAll(async () => {
  await app?.close();
});

const listOpen = async (): Promise<Todo[]> =>
  (await app.inject({ method: "GET", url: "/api/todos?status=open" })).json<Todo[]>();

const patch = async (id: string, body: Record<string, unknown>) =>
  app.inject({ method: "PATCH", url: `/api/todos/${encodeURIComponent(id)}`, payload: body });

const runsOf = async (automationId: string): Promise<{ status: string }[]> =>
  (await app.inject({ method: "GET", url: `/api/automations/${automationId}/runs` })).json<
    { status: string }[]
  >();

/** Poll until `fn` yields a value, or throw. The linked run is fire-and-forget. */
async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 2000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("waitFor timed out");
}

describe("todos", () => {
  it("creates a todo and lists it open", async () => {
    const { todo, created } = await store.createTodo({
      title: "Onboard Acme",
      body: "Waiting on the signed contract.",
    });
    expect(created).toBe(true);

    const listed = (await listOpen()).find((t) => t.id === todo.id);
    expect(listed).toBeDefined();
    if (!listed) return;
    expect(listed.title).toBe("Onboard Acme");
    expect(listed.body).toBe("Waiting on the signed contract.");
    expect(listed.status).toBe("open");
  });

  it("creates a manual todo via POST, trimming the title; a blank title 400s", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/todos",
      payload: { title: "  Call the plumber  " },
    });
    const todo = res.json<Todo>();
    expect(todo.title).toBe("Call the plumber");
    expect((await listOpen()).some((t) => t.id === todo.id)).toBe(true);

    const blank = await app.inject({ method: "POST", url: "/api/todos", payload: { title: "  " } });
    expect(blank.statusCode).toBe(400);
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

  it("completes and dismisses via status, removing it from the open list", async () => {
    const { todo } = await store.createTodo({ title: "Finish me" });
    expect((await patch(todo.id, { status: "done" })).json<Todo>().status).toBe("done");
    expect((await listOpen()).some((t) => t.id === todo.id)).toBe(false);

    const { todo: other } = await store.createTodo({ title: "Dismiss me" });
    expect((await patch(other.id, { status: "dismissed" })).json<Todo>().status).toBe("dismissed");
    expect((await listOpen()).some((t) => t.id === other.id)).toBe(false);
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

describe("linked automation", () => {
  const manualAutomation = (name: string) =>
    manage.createAutomation({ name, instruction: "noop", schedule: "" });

  it("runs the linked automation when the todo completes", async () => {
    const automation = await manualAutomation("After-call follow-up");
    const { todo } = await store.createTodo({
      title: "Call the lead",
      linkedAutomationId: automation.id,
    });

    const done = (await patch(todo.id, { status: "done" })).json<Todo>();
    expect(done.status).toBe("done");
    const runs = await waitFor(async () => {
      const list = await runsOf(automation.id);
      return list.length > 0 ? list : undefined;
    });
    expect(runs).toHaveLength(1);
  });

  it("links and unlinks via PATCH; an unknown automation id 400s", async () => {
    const automation = await manualAutomation("Linkable");
    const { todo } = await store.createTodo({ title: "Link me" });

    const linked = (await patch(todo.id, { linkedAutomationId: automation.id })).json<Todo>();
    expect(linked.linkedAutomationId).toBe(automation.id);
    expect((await patch(todo.id, { linkedAutomationId: "does-not-exist" })).statusCode).toBe(400);
    const unlinked = (await patch(todo.id, { linkedAutomationId: null })).json<Todo>();
    expect(unlinked.linkedAutomationId).toBeNull();
  });

  it("does not run the link when the todo is dismissed", async () => {
    const skipped = await manualAutomation("Should not fire");
    const { todo } = await store.createTodo({
      title: "Dismiss me",
      linkedAutomationId: skipped.id,
    });
    await patch(todo.id, { status: "dismissed" });

    // Barrier: complete a second linked todo and wait for its run. Once that has
    // fired, any erroneous fire of the dismissed one would already have landed.
    const sentinel = await manualAutomation("Sentinel");
    const s = await store.createTodo({ title: "Sentinel", linkedAutomationId: sentinel.id });
    await patch(s.todo.id, { status: "done" });
    await waitFor(async () => {
      const list = await runsOf(sentinel.id);
      return list.length > 0 ? list : undefined;
    });

    expect(await runsOf(skipped.id)).toHaveLength(0);
  });
});

describe("sub-todo retirement migration", () => {
  it("folds existing steps into the body instead of dropping them", async () => {
    const { SCHEMA_STEPS } = await import("../../src/db/schemaSteps.js");
    const foldIndex = SCHEMA_STEPS.findIndex((s) => s.includes("DROP TABLE todo_steps"));
    const foldStep = SCHEMA_STEPS[foldIndex] ?? "";
    expect(foldStep).toContain("DROP TABLE todo_steps");

    const raw = new Database(":memory:");
    for (const step of SCHEMA_STEPS.slice(0, foldIndex)) raw.exec(step);
    raw
      .prepare(
        "INSERT INTO todos (id, title, body, status, created_at, updated_at) VALUES (?, ?, ?, 'open', '2026-01-01', '2026-01-01')",
      )
      .run("t1", "Onboarding", "Context.");
    const insertStep = raw.prepare(
      "INSERT INTO todo_steps (id, todo_id, ordinal, label, done, due_at, created_at) VALUES (?, 't1', ?, ?, ?, ?, '2026-01-01')",
    );
    insertStep.run("s1", 0, "Collect W-9", 1, null);
    insertStep.run("s2", 1, "Kickoff", 0, "2026-07-22");

    raw.exec(foldStep);

    const { body } = raw.prepare("SELECT body FROM todos WHERE id = 't1'").get() as {
      body: string;
    };
    expect(body).toBe("Context.\n\n- ☑ Collect W-9\n- ☐ Kickoff · 2026-07-22");
    expect(
      raw.prepare("SELECT name FROM sqlite_master WHERE name = 'todo_steps'").get(),
    ).toBeUndefined();
    raw.close();
  });
});
