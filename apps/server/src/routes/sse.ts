import type { FastifyReply } from "fastify";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
} as const;

export interface SseStream<T> {
  /** Write one `data:` frame; a no-op once the stream has ended. */
  send(payload: T): void;
  /** End the underlying response; safe to call more than once. */
  end(): void;
}

/**
 * Hijacks `reply` (we stream on the raw socket), writes SSE headers, and listens
 * for the raw response's "close" to detect a client disconnect. Response close,
 * not request close, signals a real disconnect: request "close" fires as soon as
 * the body is consumed (Node ≥ 16), long before the client goes away. `end()`
 * detaches the listener before ending, so a graceful shutdown can't re-trigger
 * the disconnect cleanup.
 */
export function openSse<T>(reply: FastifyReply, onClose: () => void): SseStream<T> {
  reply.hijack();
  reply.raw.writeHead(200, SSE_HEADERS);

  let ended = false;
  const handleClose = () => {
    if (ended) return;
    ended = true;
    onClose();
  };
  reply.raw.on("close", handleClose);

  return {
    send(payload) {
      if (ended) return;
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    },
    end() {
      reply.raw.off("close", handleClose);
      if (ended) return;
      ended = true;
      if (!reply.raw.writableEnded) reply.raw.end();
    },
  };
}
