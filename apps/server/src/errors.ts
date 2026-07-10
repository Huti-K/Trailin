import type { FastifyInstance } from "fastify";
import { errorMessage } from "./util.js";

/**
 * An error that already knows which HTTP status it deserves. Throw one of the
 * helpers below from anywhere under a route and the handler registered by
 * registerErrorHandler turns it into the API's standard `{ error }` body.
 *
 * Anything else that escapes a route is a bug, and becomes a 500.
 */
export class AppError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "AppError";
  }
}

/** The request was malformed or asked for something nonsensical. */
export const badRequest = (message: string): AppError => new AppError(message, 400);

/** The thing addressed by the URL doesn't exist. */
export const notFound = (message: string): AppError => new AppError(message, 404);

/** The request is valid but conflicts with the current state (e.g. a login already running). */
export const conflict = (message: string): AppError => new AppError(message, 409);

/** Trailin is not configured well enough to serve this yet (no model, no Pipedream). */
export const notConfigured = (message: string): AppError => new AppError(message, 503);

/** An upstream dependency failed: Pipedream, a mail provider, the model API. */
export const upstreamError = (message: string, cause?: unknown): AppError =>
  new AppError(message, 502, { cause });

/**
 * Duck-typed HTTP status off whatever an upstream SDK call threw — e.g.
 * PipedreamError from @pipedream/sdk, which every mail-provider driver's
 * calls (through pipedream/connect.ts's proxyRequest) ultimately throw.
 * Lets a route tell "that id doesn't exist upstream" (404) apart from a real
 * outage before deciding between notFound and upstreamError. Undefined when
 * the thrown value carries no numeric statusCode.
 */
export function upstreamStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const status = (error as { statusCode?: unknown }).statusCode;
  return typeof status === "number" ? status : undefined;
}

/** The `{ error }` envelope every non-2xx API response uses. `requestId` ties it to the logs. */
export interface ErrorResponse {
  error: string;
  requestId: string;
}

function statusOf(error: unknown): number {
  if (error instanceof AppError) return error.statusCode;
  const candidate = error as { statusCode?: unknown; validation?: unknown };
  // Fastify's own schema validation failures.
  if (candidate.validation) return 400;
  if (typeof candidate.statusCode === "number" && candidate.statusCode >= 400) {
    return candidate.statusCode;
  }
  return 500;
}

/**
 * One error shape for the whole API. Without this, an unexpected throw falls
 * through to Fastify's default handler, which answers with
 * `{ statusCode, error: "Internal Server Error", message }` — and since the web
 * client reads the `error` field (see apps/web/src/lib/api.ts), the user is
 * shown the string "Internal Server Error" while the real message is dropped.
 *
 * The real message is included even on a 500: Trailin runs on the user's own
 * machine, so the person reading the error is the person running the server.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, req, reply) => {
    const statusCode = statusOf(error);

    if (statusCode >= 500) {
      req.log.error({ err: error }, "request failed");
    } else {
      req.log.warn({ err: error, statusCode }, "request rejected");
    }

    // A hijacked reply (the SSE streams) or a partially written response can't
    // be given a body — the log line above is all we can do.
    if (reply.raw.headersSent) return;

    const body: ErrorResponse = { error: errorMessage(error), requestId: String(req.id) };
    reply.code(statusCode).send(body);
  });
}
