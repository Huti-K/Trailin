import type { TurnLogger } from "../core/logger.js";

/**
 * The narrow slice of the agent's turn machinery an automation run drives.
 * automations/ never imports the agent graph; the real runner is registered at
 * boot (index.ts), keeping agent → automations the only dependency direction.
 */

export interface TurnRunnerInput {
  /** The run id; doubles as the run's conversation id. */
  runId: string;
  prompt: string;
  title: string;
  signal: AbortSignal;
  log: TurnLogger;
}

export interface TurnRunnerResult {
  text: string;
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
