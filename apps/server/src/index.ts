import { activeModelConfigured } from "./agent/llm/registry.js";
import { resetSessions } from "./agent/sessionCache.js";
import { beginTurn, recoverInterruptedTurns, serializeTurnCards } from "./agent/turnRecorder.js";
import { reconcileVoiceLearns } from "./agent/voiceLearn.js";
import { buildApp } from "./app.js";
import { seedDefaultAutomations } from "./automations/defaults.js";
import { startMailProbe, stopMailProbe } from "./automations/mailProbe.js";
import { startScheduler, stopScheduler } from "./automations/scheduler.js";
import { startNightlySuggest, stopNightlySuggest } from "./automations/suggest.js";
import { registerTurnRunner } from "./automations/turnRunner.js";
import { env } from "./core/env.js";
import { installProcessErrorHandlers, logger } from "./core/logger.js";
import { startLearning, stopLearning } from "./email/learn/service.js";
import { pipedreamConfigured } from "./integrations/pipedream/connect.js";
import {
  onWhatsAppLinkedChange,
  startWhatsApp,
  stopWhatsApp,
} from "./integrations/whatsapp/session.js";
import { initAgentHome, stopHomeWatchers } from "./storage/home/agentHome.js";
import { getLibraryDir, startLibrary, stopLibrary } from "./storage/library/ingest.js";

async function main(): Promise<void> {
  // Before anything that can read skills or memories (the scheduler may fire
  // a run during boot): make the agent home exist and finish any pending
  // migration into it.
  await initAgentHome();

  const app = await buildApp();

  // Register the turn runner (automations/turnRunner.ts) before the scheduler
  // starts, so even a run fired during boot finds it.
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

  await seedDefaultAutomations();
  await startScheduler();
  // Runs runOnNewMail-flagged automations when new inbound mail arrives.
  startMailProbe();
  await recoverInterruptedTurns();

  await startLearning();
  await startNightlySuggest();
  // Voice-learn catch-up for accounts never attempted. Off the boot critical
  // path (void); it records its own outcomes.
  void reconcileVoiceLearns();

  await startLibrary((message) => app.log.info(message));
  app.log.info(`Document library folder: ${getLibraryDir()}`);

  // Reconnect a paired WhatsApp account (no-op while none linked). Live agent
  // sessions hold a tool list for the old link state, so a pairing/unlink rebuilds them.
  onWhatsAppLinkedChange(() => void resetSessions());
  startWhatsApp();

  // app.close() is the one complete teardown path (cron tasks, learn loops,
  // folder watcher, cached agent sessions' MCP toolsets), for signals and
  // anything else that closes the instance.
  app.addHook("onClose", async () => {
    stopScheduler();
    stopMailProbe();
    stopLearning();
    stopNightlySuggest();
    stopLibrary();
    stopHomeWatchers();
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
  // hooks before exiting.
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
