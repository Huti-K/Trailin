import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import Fastify, { type FastifyBaseLogger } from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { env } from "./env.js";
import { registerErrorHandler, type ErrorResponse } from "./errors.js";
import { isAllowedHost } from "./hostGuard.js";
import { installProcessErrorHandlers, logger } from "./logger.js";
import { pipedreamConfigured } from "./pipedream/connect.js";
import { chatRoutes } from "./routes/chat.js";
import { accountRoutes } from "./routes/accounts.js";
import { automationRoutes } from "./routes/automations.js";
import { llmRoutes } from "./routes/llm.js";
import { pipedreamRoutes } from "./routes/pipedream.js";
import { settingsRoutes } from "./routes/settings.js";
import { draftRoutes } from "./routes/drafts.js";
import { waitingRoutes } from "./routes/waiting.js";
import { memoryRoutes } from "./routes/memories.js";
import { libraryRoutes } from "./routes/library.js";
import { eventRoutes } from "./routes/events.js";
import { searchRoutes } from "./routes/search.js";
import { backupRoutes } from "./routes/backup.js";
import { startScheduler } from "./automations/scheduler.js";
import { seedDefaultAutomations } from "./automations/defaults.js";
import { startSyncEngine } from "./email/sync/syncEngine.js";
import { startEnrichment } from "./email/enrich/enrichService.js";
import { seedDemoData } from "./demo/seed.js";
import { startLibrary, getLibraryDir } from "./library/ingest.js";
import { activeModelConfigured } from "./llm/registry.js";
import { recoverInterruptedTurns } from "./agent/turnRecorder.js";

const here = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  // Share the process-wide logger rather than letting Fastify build its own,
  // so `req.log` and the scheduler/MCP loggers agree on level and redaction.
  // Typed as FastifyBaseLogger at the boundary: handing Fastify a pino.Logger
  // narrows the inferred FastifyInstance and every plugin then mismatches it.
  const loggerInstance: FastifyBaseLogger = logger;
  const app = Fastify({ loggerInstance });
  registerErrorHandler(app);

  // No auth on this API (local-first, single-user), so CORS is the only
  // thing stopping an arbitrary website from reading/mutating it via the
  // browser — reflect only same-host origins (any port), never `true`.
  await app.register(cors, {
    origin: (origin, cb) => {
      cb(null, !origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin));
    },
  });

  // DNS-rebinding defense: CORS above only looks at Origin, which a rebound
  // page never has to send — the Host header is what's left to catch it.
  app.addHook("onRequest", async (req, reply) => {
    if (!isAllowedHost(req.headers.host, env.host)) {
      const body: ErrorResponse = { error: "host not allowed", requestId: String(req.id) };
      reply.code(403).send(body);
    }
  });

  await app.register(accountRoutes);
  await app.register(chatRoutes);
  await app.register(automationRoutes);
  await app.register(llmRoutes);
  await app.register(pipedreamRoutes);
  await app.register(settingsRoutes);
  await app.register(draftRoutes);
  await app.register(waitingRoutes);
  await app.register(memoryRoutes);
  await app.register(libraryRoutes);
  await app.register(eventRoutes);
  await app.register(searchRoutes);
  await app.register(backupRoutes);

  // When the web app has been built, serve it from the same process so a
  // single `pnpm start` works on a desktop machine or a host.
  const webDist = resolve(here, "../../web/dist");
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url?.startsWith("/api/")) {
        reply.code(404).send({ error: "not found" });
        return;
      }
      reply.sendFile("index.html");
    });
  } else {
    // Dev (web is served by Vite): still answer 404s in the API's `{ error }`
    // shape instead of Fastify's default `{ statusCode, error, message }`.
    app.setNotFoundHandler((_req, reply) => {
      reply.code(404).send({ error: "not found" });
    });
  }

  if (env.demoMode) {
    // Seeded history (20 days of digests, drafts, chats, memories, library
    // docs) stands in for live automation runs — the scheduler never starts,
    // so nothing runs on a timer or touches Pipedream.
    await seedDemoData();
    app.log.info("Demo mode: automation scheduler disabled — seeded history replaces it");
  } else {
    // Populate the built-in automations on a fresh install, then schedule
    // everything (defaults included) for this boot.
    await seedDefaultAutomations();
    await startScheduler();
    // Close out any chat/automation turn left dangling by a mid-turn restart.
    await recoverInterruptedTurns();
  }

  // Mirror every connected mailbox into SQLite (email/sync/) — the local
  // state summaries/triage/drafts read from. Demo mode syncs the seeded
  // mailbox through the same engine instead of calling out to Pipedream, so
  // this starts after seeding either way. Enrichment rides the mirror's
  // "mail" events to keep per-thread summaries/triage fresh.
  startSyncEngine();
  startEnrichment();

  // Index the document drop folder and keep watching it.
  await startLibrary((message) => app.log.info(message));
  app.log.info(`Document library folder: ${getLibraryDir()}`);

  if (!(await activeModelConfigured())) {
    app.log.warn(
      "No LLM credentials yet — open Settings in the web UI to sign in with a subscription or save an API key.",
    );
  }
  if (!(await pipedreamConfigured())) {
    app.log.warn(
      "Pipedream is not set up — open Settings → Connect email in the web UI to link Gmail/Outlook.",
    );
  }

  // Ctrl-C / `docker stop` should drain in-flight requests and close the
  // agents' MCP sessions, rather than dropping the sockets on the floor.
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
