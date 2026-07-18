import { resetSessions } from "./agent/sessionCache.js";
import { beginTurn, recoverInterruptedTurns, serializeTurnCards } from "./agent/turnRecorder.js";
import { reconcileVoiceLearns } from "./agent/voiceLearn.js";
import { buildApp } from "./app.js";
import { seedDefaultAutomations } from "./automations/defaults.js";
import { startMailProbe, stopMailProbe } from "./automations/mailProbe.js";
import { startScheduler, stopScheduler } from "./automations/scheduler.js";
import { startNightlySuggest, stopNightlySuggest } from "./automations/suggestService.js";
import { registerTurnRunner } from "./automations/turnRunner.js";
import { startLearning, stopLearning } from "./email/learn/service.js";
import { env } from "./env.js";
import { getLibraryDir, startLibrary, stopLibrary } from "./library/ingest.js";
import { activeModelConfigured } from "./llm/registry.js";
import { installProcessErrorHandlers, logger } from "./logger.js";
import { pipedreamConfigured } from "./pipedream/connect.js";
import { onWhatsAppLinkedChange, startWhatsApp, stopWhatsApp } from "./whatsapp/session.js";

async function main(): Promise<void> {
  const app = await buildApp();

  // The agent-backed turn runner automations drive their runs through
  // (automations/turnRunner.ts) — registered before the scheduler starts so
  // even a run fired during boot finds it.
  registerTurnRunner(async ({ runId, prompt, title, signal, log }) => {
    const turn = beginTurn(runId);
    const { text, cards } = await turn.run({
      prompt,
      session: "ephemeral",
      conversation: { type: "automation", title },
      signal,
      log,
    });
    return { text, cardsJson: serializeTurnCards(cards) };
  });

  // Populate the built-in automations on a fresh install, then schedule
  // everything (defaults included) for this boot.
  await seedDefaultAutomations();
  await startScheduler();
  // The new-mail probe: runs runOnNewMail-flagged automations as soon as new
  // inbound mail shows up in any connected account (automations/mailProbe.ts).
  startMailProbe();
  // Close out any chat/automation turn left dangling by a mid-turn restart.
  await recoverInterruptedTurns();

  // The draft-vs-sent learning loops (email/learn/): the matcher polls each
  // account's sent mail live to find what an agent draft became, and the
  // nightly extraction diffs draft vs. sent to learn style lessons.
  await startLearning();
  // The automation-suggestion sweep: recurring chat requests become pending
  // suggestions on the Automations page (automations/suggestService.ts).
  await startNightlySuggest();
  // Voice-learn catch-up: any email account never attempted (missed connect
  // trigger, or linked before automatic learning) gets its style analyzed
  // now. Off the boot critical path — it records its own outcomes.
  void reconcileVoiceLearns();

  // Index the document drop folder and keep watching it.
  await startLibrary((message) => app.log.info(message));
  app.log.info(`Document library folder: ${getLibraryDir()}`);

  // Reconnect a paired WhatsApp account (no-op while none is linked). Live
  // agent sessions hold a tool list built for the old link state, so a
  // pairing or unlink rebuilds them.
  onWhatsAppLinkedChange(() => void resetSessions());
  startWhatsApp();

  // Everything started above is torn down by close(): cron tasks, the learn
  // loops, the folder watcher, and each cached agent session's MCP toolset —
  // so app.close() is the one complete teardown path, for signals and
  // anything else that closes the instance.
  app.addHook("onClose", async () => {
    stopScheduler();
    stopMailProbe();
    stopLearning();
    stopNightlySuggest();
    stopLibrary();
    await stopWhatsApp();
    await resetSessions();
  });

  if (!(await activeModelConfigured())) {
    app.log.warn(
      "No LLM credentials yet — open Settings in the web UI to sign in with a subscription or save an API key.",
    );
  }
  if (!(await pipedreamConfigured())) {
    app.log.warn(
      "Pipedream is not set up — open Settings → Connect email in the web UI to link your email accounts.",
    );
  }

  // Ctrl-C / `docker stop` drains in-flight requests, then runs the onClose
  // hooks (background services, MCP sessions, database) before exiting.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      app.log.info({ signal }, "shutting down");
      app.close().then(
        () => process.exit(0),
        (error: unknown) => {
          app.log.error({ err: error }, "shutdown failed");
          process.exit(1);
        },
      );
    });
  }

  await app.listen({ port: env.port, host: env.host });
}

installProcessErrorHandlers();

main().catch((error) => {
  logger.fatal({ err: error }, "server failed to start");
  setTimeout(() => process.exit(1), 100);
});
