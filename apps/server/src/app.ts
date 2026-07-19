import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
// Populate the provider registries once for the whole process; this is the
// single place the register modules are imported.
import "./email/registerProviders.js";
import "./email/registerAttachmentProviders.js";
import "./email/read/registerReadProviders.js";
import "./outbound/registerChannels.js";
import { env } from "./core/env.js";
import { type ErrorResponse, registerErrorHandler } from "./core/errors.js";
import { isAllowedHost, isLoopbackOrigin } from "./core/hostGuard.js";
import { logger } from "./core/logger.js";
import { closeDb } from "./db/index.js";
import { accountRoutes } from "./routes/accounts.js";
import { automationRoutes } from "./routes/automations.js";
import { backupRoutes } from "./routes/backup.js";
import { chatRoutes } from "./routes/chat.js";
import { draftRoutes } from "./routes/drafts.js";
import { eventRoutes } from "./routes/events.js";
import { leadsRoutes } from "./routes/leads.js";
import { learnRoutes } from "./routes/learn.js";
import { libraryRoutes } from "./routes/library.js";
import { llmRoutes } from "./routes/llm.js";
import { mailRoutes } from "./routes/mail.js";
import { memoryRoutes } from "./routes/memories.js";
import { onOfficeRoutes } from "./routes/onoffice.js";
import { outboundRoutes } from "./routes/outbound.js";
import { pipedreamRoutes } from "./routes/pipedream.js";
import { searchRoutes } from "./routes/search.js";
import { settingsRoutes } from "./routes/settings.js";
import { skillRoutes } from "./routes/skills.js";
import { todosRoutes } from "./routes/todos.js";
import { whatsAppRoutes } from "./routes/whatsapp.js";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Build the fully configured Fastify instance: error handling, CORS, host
 * guard, every route plugin, and static serving of the web app. Everything
 * except background services and listening (index.ts adds those; tests drive
 * this instance via app.inject()).
 */
export async function buildApp(): Promise<FastifyInstance> {
  // Share the process-wide logger so req.log and the scheduler/MCP loggers agree
  // on level and redaction. Typed FastifyBaseLogger at the boundary: a
  // pino.Logger narrows the inferred FastifyInstance and every plugin mismatches it.
  const loggerInstance: FastifyBaseLogger = logger;
  // maxParamLength exceeds the longest provider id in a path param: Outlook
  // Graph ids run ~140-170 chars (immutable ids longer), and the router's
  // 100-char default would 404 such routes with no handler ever running.
  const app = Fastify({ loggerInstance, routerOptions: { maxParamLength: 512 } });
  registerErrorHandler(app);

  // The database handle follows the app's lifecycle: close() releases it so the
  // process holds no SQLite lock and a test worker can build a fresh app.
  app.addHook("onClose", async () => {
    closeDb();
  });

  // No auth on this API (local-first, single-user), so CORS is the only thing
  // stopping an arbitrary website from reading/mutating it via the browser:
  // reflect only loopback origins, never `true`.
  await app.register(cors, {
    origin: (origin, cb) => {
      cb(null, !origin || isLoopbackOrigin(origin));
    },
  });

  // DNS-rebinding defense: CORS above only checks Origin, which a rebound page
  // need not send; the Host header is what's left to catch it.
  app.addHook("onRequest", async (req, reply) => {
    if (!isAllowedHost(req.headers.host, env.host)) {
      const body: ErrorResponse = { error: "host not allowed", requestId: String(req.id) };
      // Returning the reply marks the hook as having handled the request; the
      // send alone only works while it stays synchronous.
      return reply.code(403).send(body);
    }
  });

  await app.register(accountRoutes);
  await app.register(chatRoutes);
  await app.register(automationRoutes);
  await app.register(llmRoutes);
  await app.register(pipedreamRoutes);
  await app.register(onOfficeRoutes);
  await app.register(whatsAppRoutes);
  await app.register(settingsRoutes);
  await app.register(draftRoutes);
  await app.register(outboundRoutes);
  await app.register(todosRoutes);
  await app.register(memoryRoutes);
  await app.register(skillRoutes);
  await app.register(leadsRoutes);
  await app.register(learnRoutes);
  await app.register(libraryRoutes);
  await app.register(mailRoutes);
  await app.register(eventRoutes);
  await app.register(searchRoutes);
  await app.register(backupRoutes);

  // 404s answer in the API's { error } shape, not Fastify's default.
  const apiNotFound = (req: FastifyRequest, reply: FastifyReply): void => {
    const body: ErrorResponse = { error: "not found", requestId: String(req.id) };
    reply.code(404).send(body);
  };

  // When the web app is built, serve it from the same process (a single
  // pnpm start on desktop or a host); non-API routes fall through to the SPA.
  // In dev, Vite serves it instead.
  const webDist = env.webDistPath ?? resolve(here, "../../web/dist");
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url?.startsWith("/api/")) apiNotFound(req, reply);
      else reply.sendFile("index.html");
    });
  } else {
    app.setNotFoundHandler(apiNotFound);
  }

  return app;
}
