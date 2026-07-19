import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { ServerEvent } from "@trailin/shared";
import { onServerEvent } from "../core/events.js";
import { openSse } from "./sse.js";

/**
 * Named "ping" events (not comment frames, which EventSource never surfaces)
 * give the client a liveness signal: a proxy can swallow the upstream's end
 * without closing the browser socket, so a stalled ping is the only way the
 * client detects a dead stream (web lib/serverEvents.ts).
 */
const HEARTBEAT_MS = 15_000;

export const eventRoutes: FastifyPluginAsyncTypebox = async (app) => {
  // Hijacked replies are invisible to Fastify's request draining, so onClose
  // tears down the open streams itself rather than wait on connected tabs.
  const teardowns = new Set<() => void>();
  app.addHook("onClose", async () => {
    for (const teardown of teardowns) teardown();
  });

  app.get("/api/events", async (_req, reply) => {
    const stream = openSse<ServerEvent>(reply, () => teardown());
    const unsubscribe = onServerEvent((event) => stream.send(event));
    const heartbeat = setInterval(() => {
      reply.raw.write("event: ping\ndata: {}\n\n");
    }, HEARTBEAT_MS);
    // One teardown for both disconnect and shutdown; clearInterval precedes
    // end() so nothing writes to an ended response.
    const teardown = () => {
      teardowns.delete(teardown);
      unsubscribe();
      clearInterval(heartbeat);
      stream.end();
    };
    teardowns.add(teardown);

    reply.raw.write("retry: 3000\n\n");
    reply.raw.write(": connected\n\n");
  });
};
