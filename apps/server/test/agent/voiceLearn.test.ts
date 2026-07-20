import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Boot reconcile treats an attempted account as done, so a recorded failure is
 * permanent unless something re-opens it. The "no model configured" failure is
 * the one that must re-open: an account connected before the user signed in to
 * a model records it, and reconcile itself only runs once a model exists, so
 * the row is stale by definition. Getting this wrong is silent — the account
 * simply never learns a voice and nothing says why.
 */

let voiceLearn: typeof import("../../src/agent/voiceLearn.js");

const ACCOUNT = {
  id: "acct-gmail",
  app: "gmail",
  name: "personal",
  externalId: "ext-1",
};

/** Deps whose learn() only records the call; the real one needs a provider and an LLM. */
function deps(modelConfigured: boolean, learned: string[], learn?: () => Promise<void>) {
  return {
    listAccounts: async () => [ACCOUNT],
    modelConfigured: async () => modelConfigured,
    learn: async (accountId: string) => {
      learned.push(accountId);
      if (learn) await learn();
    },
  } as unknown as import("../../src/agent/voiceLearn.js").VoiceLearnDeps;
}

beforeAll(async () => {
  const scratch = await mkdtemp(join(tmpdir(), "trailin-voicelearn-test-"));
  process.env.AGENT_HOME_PATH = join(scratch, "Trailin");
  process.env.DATABASE_PATH = join(scratch, "test.db");
  voiceLearn = await import("../../src/agent/voiceLearn.js");
});

describe("voice-learn boot reconcile", () => {
  it("retries an account that failed only because no model was configured", async () => {
    const learned: string[] = [];

    // Connected before signing in to a model: records the stale failure.
    await voiceLearn.runVoiceLearnOnConnect(ACCOUNT.id, deps(false, learned));
    expect(learned).toEqual([]);

    // A later boot, model now configured.
    await voiceLearn.reconcileVoiceLearns(deps(true, learned));
    expect(learned).toEqual([ACCOUNT.id]);
  });

  it("leaves a genuinely failed account for the user to retry", async () => {
    const learned: string[] = [];
    const failing = deps(true, learned, () => Promise.reject(new Error("mailbox unreachable")));

    await voiceLearn.runVoiceLearnOnConnect(ACCOUNT.id, failing);
    expect(learned).toEqual([ACCOUNT.id]);

    // Reconcile must not hammer it every boot.
    await voiceLearn.reconcileVoiceLearns(deps(true, learned));
    expect(learned).toEqual([ACCOUNT.id]);
  });
});
