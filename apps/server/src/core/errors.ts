import type { ApiErrorCode } from "@trailin/shared";
import type { FastifyInstance } from "fastify";
import { errorMessage } from "./utils/util.js";

/**
 * An error that already knows its HTTP status; the registered handler turns it
 * into the API's { error } body. `code` marks a failure the user can fix in the
 * app (the web client makes it a click-through). Anything else that escapes a
 * route is a bug and becomes a 500.
 */
export class AppError extends Error {
  readonly code?: ApiErrorCode;

  constructor(
    message: string,
    readonly statusCode: number,
    options?: { cause?: unknown; code?: ApiErrorCode },
  ) {
    super(message, { cause: options?.cause });
    this.name = "AppError";
    this.code = options?.code;
  }
}

export const badRequest = (message: string): AppError => new AppError(message, 400);

export const notFound = (message: string): AppError => new AppError(message, 404);

export const conflict = (message: string): AppError => new AppError(message, 409);

/**
 * An upstream dependency failed (Pipedream, a mail provider, the model API). An
 * AppError cause passes through unwrapped: flattening it to a 502 would lose
 * its status, message, and code.
 */
export const upstreamError = (message: string, cause?: unknown): AppError =>
  cause instanceof AppError ? cause : new AppError(message, 502, { cause });

/**
 * Await a single-row select and throw notFound(message) if empty; the guard
 * routes run before mutating a row that might not exist.
 */
export async function requireRow<T>(rows: Promise<T[]>, message: string): Promise<T> {
  const [row] = await rows;
  if (!row) throw notFound(message);
  return row;
}

/**
 * Duck-typed HTTP status off whatever an upstream SDK threw (e.g. PipedreamError),
 * so a route can tell an upstream 404 apart from a real outage. Undefined when
 * the thrown value carries no numeric statusCode.
 */
export function upstreamStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const status = (error as { statusCode?: unknown }).statusCode;
  return typeof status === "number" ? status : undefined;
}

/**
 * Map a failure from a provider call: an upstream 404 becomes a client-facing
 * 404 (the id is gone), anything else a 502. An AppError the route threw
 * deliberately passes through as-is.
 */
export function toProviderError(error: unknown, notFoundMessage: string): AppError {
  if (error instanceof AppError) return error;
  if (upstreamStatusCode(error) === 404) return notFound(notFoundMessage);
  return upstreamError(errorMessage(error), error);
}

/** The { error } envelope every non-2xx API response uses; requestId ties it to the logs. */
export interface ErrorResponse {
  error: string;
  requestId: string;
  /** Present when the failure is user-fixable in the app. */
  code?: ApiErrorCode;
}

function statusOf(error: unknown): number {
  if (error instanceof AppError) return error.statusCode;
  if (typeof error !== "object" || error === null) return 500;
  const candidate = error as { statusCode?: unknown; validation?: unknown };
  // Fastify's own schema validation failures.
  if (candidate.validation) return 400;
  if (typeof candidate.statusCode === "number" && candidate.statusCode >= 400) {
    return candidate.statusCode;
  }
  return 500;
}

/**
 * One error shape for the whole API. Without this, Fastify's default handler
 * answers { statusCode, error: "Internal Server Error", message }, and since
 * the web client reads the `error` field it would show "Internal Server Error"
 * and drop the real message. The real message is included even on a 500:
 * Trailin runs on the user's own machine.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, req, reply) => {
    const statusCode = statusOf(error);

    if (statusCode >= 500) {
      req.log.error({ err: error }, "request failed");
    } else {
      req.log.warn({ err: error, statusCode }, "request rejected");
    }

    // A hijacked reply (SSE) or partially written response can't be given a
    // body; the log line above is all we can do.
    if (reply.raw.headersSent) return;

    const body: ErrorResponse = { error: errorMessage(error), requestId: String(req.id) };
    if (error instanceof AppError && error.code) body.code = error.code;
    reply.code(statusCode).send(body);
  });
}
