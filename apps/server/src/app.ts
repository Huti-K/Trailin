import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { closeDb } from "./db/index.js";
import { env } from "./env.js";
import { type ErrorResponse, registerErrorHandler } from "./errors.js";
import { isAllowedHost } from "./hostGuard.js";
import { logger } from "./logger.js";
import { accountRoutes } from "./routes/accounts.js";
import { automationRoutes } from "./routes/automations.js";
import { backupRoutes } from "./routes/backup.js";
import { chatRoutes } from "./routes/chat.js";
import { contactRoutes } from "./routes/contacts.js";
import { draftRoutes } from "./routes/drafts.js";
import { eventRoutes } from "./routes/events.js";
import { libraryRoutes } from "./routes/library.js";
import { llmRoutes } from "./routes/llm.js";
import { memoryRoutes } from "./routes/memories.js";
import { newsletterRoutes } from "./routes/newsletters.js";
import { pipedreamRoutes } from "./routes/pipedream.js";
import { searchRoutes } from "./routes/search.js";
import { settingsRoutes } from "./routes/settings.js";
import { waitingRoutes } from "./routes/waiting.js";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Build the fully configured Fastify instance: error handling, CORS, host
 * guard, every route plugin, and static serving of the built web app.
 * Everything except background services and listening — index.ts starts
 * those around it, and tests drive this instance directly via app.inject()
 * against a scratch DATABASE_PATH.
 */
export async function buildApp(): Promise<FastifyInstance> {
  // Share the process-wide logger rather than letting Fastify build its own,
  // so `req.log` and the scheduler/MCP loggers agree on level and redaction.
  // Typed as FastifyBaseLogger at the boundary: handing Fastify a pino.Logger
  // narrows the inferred FastifyInstance and every plugin then mismatches it.
  const loggerInstance: FastifyBaseLogger = logger;
  const app = Fastify({ loggerInstance });
  registerErrorHandler(app);

  // The database handle follows the app's lifecycle: close() releases it so
  // the process holds no SQLite lock afterwards, and a test worker can build
  // a fresh app against a fresh scratch file.
  app.addHook("onClose", async () => {
    closeDb();
  });

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
  await app.register(contactRoutes);
  await app.register(automationRoutes);
  await app.register(llmRoutes);
  await app.register(pipedreamRoutes);
  await app.register(settingsRoutes);
  await app.register(draftRoutes);
  await app.register(waitingRoutes);
  await app.register(memoryRoutes);
  await app.register(newsletterRoutes);
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

  return app;
}
