import type { TurnLogger } from "../logger.js";

/**
 * The narrow slice of the agent's turn machinery an automation run drives.
 * automations/ never imports the agent graph — the real runner (built on
 * agent/turnRecorder.ts) is registered once at boot (index.ts), which keeps
 * agent → automations the only dependency direction between the two. Tests
 * can register a fake to execute runs without a model.
 */

export interface TurnRunnerInput {
  /** The run id — it doubles as the run's conversation id. */
  runId: string;
  prompt: string;
  /** Title for the run's Conversation row, e.g. `Run: <automation name>`. */
  title: string;
  signal: AbortSignal;
  log: TurnLogger;
}

export interface TurnRunnerResult {
  text: string;
  /** The turn's cards serialized for automation_runs.cards — the same serializer messages.cards uses. */
  cardsJson: string | null;
}

export type TurnRunner = (input: TurnRunnerInput) => Promise<TurnRunnerResult>;

let runner: TurnRunner | null = null;

export function registerTurnRunner(next: TurnRunner): void {
  runner = next;
}

export function getTurnRunner(): TurnRunner {
  if (!runner) {
    throw new Error("no turn runner registered — the agent runtime wires one at boot (index.ts)");
  }
  return runner;
}
