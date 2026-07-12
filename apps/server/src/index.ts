import { resetSessions } from "./agent/emailAgent.js";
import { recoverInterruptedTurns } from "./agent/turnRecorder.js";
import { buildApp } from "./app.js";
import { seedDefaultAutomations } from "./automations/defaults.js";
import { startScheduler, stopScheduler } from "./automations/scheduler.js";
import { startContacts, stopContacts } from "./email/contacts/contactsService.js";
import { startEnrichment, stopEnrichment } from "./email/enrich/enrichService.js";
import { startNightlyLearning, stopNightlyLearning } from "./email/learn/extractService.js";
import { startDraftMatching, stopDraftMatching } from "./email/learn/matchService.js";
import { startSyncEngine, stopSyncEngine } from "./email/sync/syncEngine.js";
import { env } from "./env.js";
import { getLibraryDir, startLibrary, stopLibrary } from "./library/ingest.js";
import { activeModelConfigured } from "./llm/registry.js";
import { installProcessErrorHandlers, logger } from "./logger.js";
import { pipedreamConfigured } from "./pipedream/connect.js";

async function main(): Promise<void> {
  const app = await buildApp();

  // Populate the built-in automations on a fresh install, then schedule
  // everything (defaults included) for this boot.
  await seedDefaultAutomations();
  await startScheduler();
  // Close out any chat/automation turn left dangling by a mid-turn restart.
  await recoverInterruptedTurns();

  // Mirror every connected mailbox into SQLite (email/sync/) — the local
  // state summaries/triage/drafts read from. Enrichment rides the mirror's
  // "mail" events to keep per-thread summaries/triage fresh. The contacts
  // core (email/contacts/) rides the same events to keep its per-address
  // aggregates and kind/category/gist judgments fresh. The draft-vs-sent
  // learning loop (email/learn/) rides the same events to match agent drafts
  // against the mail they became, then extracts style lessons nightly.
  startSyncEngine();
  startEnrichment();
  startContacts();
  startDraftMatching();
  await startNightlyLearning();

  // Index the document drop folder and keep watching it.
  await startLibrary((message) => app.log.info(message));
  app.log.info(`Document library folder: ${getLibraryDir()}`);

  // Everything started above is torn down by close(): cron tasks, the sync
  // and enrichment timers, the folder watcher, and each cached agent
  // session's MCP toolset — so app.close() is the one complete teardown
  // path, for signals and anything else that closes the instance.
  app.addHook("onClose", async () => {
    stopScheduler();
    stopSyncEngine();
    stopEnrichment();
    stopContacts();
    stopDraftMatching();
    stopNightlyLearning();
    stopLibrary();
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
