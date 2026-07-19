import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * The run prompt is the contract between the scheduler and the agent: it must
 * carry the last-successful-run anchor and the run's trigger — the missed slot
 * of a catch-up, or the todo whose completion fired a chained automation.
 * Without it, "check the past 24 hours" automations silently lose the gap the
 * machine slept through, and chained runs can't tell what they fired for.
 */

let dbModule: typeof import("../../src/db/index.js");
let runRecorder: typeof import("../../src/services/automations/runRecorder.js");
const prompts: string[] = [];

beforeAll(async () => {
  const scratch = await mkdtemp(join(tmpdir(), "trailin-runrecorder-test-"));
  process.env.AGENT_HOME_PATH = join(scratch, "Trailin");
  process.env.DATABASE_PATH = join(scratch, "test.db");
  dbModule = await import("../../src/db/index.js");
  runRecorder = await import("../../src/services/automations/runRecorder.js");
  const { registerTurnRunner } = await import("../../src/services/automations/turnRunner.js");
  registerTurnRunner(async ({ prompt }) => {
    prompts.push(prompt);
    return { text: "done", cardsJson: null };
  });

  await dbModule.db.insert(dbModule.schema.automations).values({
    id: "auto-1",
    name: "Mail sweep",
    instruction: "Check emails from the past 24 hours.",
    schedule: "0 6 * * *",
    createdAt: new Date().toISOString(),
  });
});

describe("automation run prompt context", () => {
  it("anchors runs to the previous success and flags catch-up gaps", async () => {
    const first = await runRecorder.executeAutomationRun("auto-1");
    expect(first.succeeded).toBe(true);
    expect(prompts[0]).toContain("no previous successful run");
    expect(prompts[0]).toContain("Check emails from the past 24 hours.");

    const [recorded] = await dbModule.db.select().from(dbModule.schema.automationRuns);
    const catchUp = await runRecorder.executeAutomationRun("auto-1", {
      trigger: { kind: "catchUp", dueAt: "2026-07-18T06:00:00.000Z" },
    });
    expect(catchUp.succeeded).toBe(true);
    expect(prompts[1]).toContain(`previous successful run finished at ${recorded?.finishedAt}`);
    expect(prompts[1]).toContain("catch-up run");
    expect(prompts[1]).toContain("2026-07-18T06:00:00.000Z");
  });

  it("hands a chained run the todo that fired it", async () => {
    const run = await runRecorder.executeAutomationRun("auto-1", {
      trigger: { kind: "todo", todoId: "todo-9", title: "Erreicht: Unterlagen an Familie Berger" },
    });
    expect(run.succeeded).toBe(true);
    const prompt = prompts.at(-1) ?? "";
    expect(prompt).toContain('completed the linked todo "Erreicht: Unterlagen an Familie Berger"');
    expect(prompt).toContain("todo-9");
  });
});
