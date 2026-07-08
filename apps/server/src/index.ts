import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { env } from "./env.js";
import { pipedreamConfigured } from "./pipedream/connect.js";
import { chatRoutes } from "./routes/chat.js";
import { accountRoutes } from "./routes/accounts.js";
import { automationRoutes } from "./routes/automations.js";
import { llmRoutes } from "./routes/llm.js";
import { pipedreamRoutes } from "./routes/pipedream.js";
import { settingsRoutes } from "./routes/settings.js";
import { draftRoutes } from "./routes/drafts.js";
import { memoryRoutes } from "./routes/memories.js";
import { libraryRoutes } from "./routes/library.js";
import { startScheduler } from "./automations/scheduler.js";
import { seedDefaultAutomations } from "./automations/defaults.js";
import { startLibrary, getLibraryDir } from "./library/ingest.js";
import { activeModelConfigured } from "./llm/registry.js";

const here = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const app = Fastify({ logger: { level: "info" } });

  await app.register(cors, { origin: true });
  await app.register(accountRoutes);
  await app.register(chatRoutes);
  await app.register(automationRoutes);
  await app.register(llmRoutes);
  await app.register(pipedreamRoutes);
  await app.register(settingsRoutes);
  await app.register(draftRoutes);
  await app.register(memoryRoutes);
  await app.register(libraryRoutes);

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
  }

  // Populate the built-in automations on a fresh install, then schedule
  // everything (defaults included) for this boot.
  await seedDefaultAutomations();
  await startScheduler();

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

  await app.listen({ port: env.port, host: "0.0.0.0" });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
