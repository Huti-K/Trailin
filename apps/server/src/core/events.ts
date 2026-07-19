import { EventEmitter } from "node:events";
import type { RunNotification, ServerEvent, ServerEventTopic } from "@trailin/shared";

/**
 * In-process bus for "data changed" notifications, fanned out to the web UI
 * over GET /api/events. Emits live in the lowest-level mutation functions, so
 * every path is covered once.
 */
const bus = new EventEmitter();
bus.setMaxListeners(0);

export function emitServerEvent(topic: ServerEventTopic): void {
  bus.emit("event", { topic } satisfies ServerEvent);
}

/** Emit a "notification" event, the one topic that carries a payload. */
export function emitRunNotification(notification: RunNotification): void {
  bus.emit("event", { topic: "notification", notification } satisfies ServerEvent);
}

export function onServerEvent(listener: (event: ServerEvent) => void): () => void {
  bus.on("event", listener);
  return () => {
    bus.off("event", listener);
  };
}
