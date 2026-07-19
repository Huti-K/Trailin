import { createRequire } from "node:module";
import { type Logger, pino, type TransportMultiOptions, type TransportSingleOptions } from "pino";
import { env } from "./env.js";

/**
 * The slice of pino's Logger the turn machinery passes around. The narrow shape
 * lets a route hand over req.log.child(...) (typed FastifyBaseLogger, not
 * pino.Logger) without a cast, and lets automations/ depend on it without
 * importing the agent.
 */
export interface TurnLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

/**
 * Key names redacted from every log line: the Pipedream client
 * secret, access tokens, saved LLM API keys, and Authorization headers.
 *
 * Redacted by key name, not exact location, because the usual leak is not a
 * deliberate log; it's an SDK attaching the outbound request to the error it
 * throws, so `log.error({ err })` prints `err.config.headers.authorization`.
 *
 * pino has no recursive wildcard, so each key is covered to four levels (the
 * depth of a request config on a serialized Error). Deeper nesting is not
 * redacted, so don't log whole config objects. Paths are case-sensitive, hence
 * the duplicated header names.
 */
const SECRET_KEYS = [
  "clientSecret",
  "client_secret",
  "apiKey",
  "api_key",
  "accessToken",
  "access_token",
  "rawAccessToken",
  "refreshToken",
  "refresh_token",
  "token",
  "password",
  "authorization",
  "Authorization",
  "cookie",
  "Cookie",
];

const REDACT_PATHS = SECRET_KEYS.flatMap((key) => [key, `*.${key}`, `*.*.${key}`, `*.*.*.${key}`]);

const LEVELS = new Set(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);
const level = LEVELS.has(env.logLevel) ? env.logLevel : "info";

const require_ = createRequire(import.meta.url);

/**
 * Colourized single-line logs in a dev TTY, raw JSON elsewhere. pino-pretty is
 * a dev dependency a production install won't have, so fall back to JSON rather
 * than failing to boot. Resolved to an absolute path because pino loads it in a
 * worker thread that doesn't inherit this package's pnpm resolution.
 */
function prettyTransport(): { target: string; options: Record<string, unknown> } | undefined {
  if (env.isProduction || !process.stdout.isTTY) return undefined;
  try {
    return {
      target: require_.resolve("pino-pretty"),
      options: { colorize: true, translateTime: "HH:MM:ss.l", ignore: "pid,hostname" },
    };
  } catch {
    return undefined;
  }
}

/**
 * Where logs go: with no LOG_FILE, pino-pretty in a dev TTY or pino's direct
 * JSON otherwise; with LOG_FILE set, also tee to a rotating file so an
 * unattended run's output survives the terminal closing.
 */
function buildTransport(): TransportSingleOptions | TransportMultiOptions | undefined {
  const pretty = prettyTransport();
  if (!env.logFile) return pretty;
  // pino loads transport targets in a worker thread that doesn't inherit this
  // package's pnpm resolution, so resolve pino-roll to an absolute path. If it
  // isn't installed, keep console logging rather than taking boot down over a
  // file sink.
  let rollTarget: string;
  try {
    rollTarget = require_.resolve("pino-roll");
  } catch {
    return pretty;
  }
  const consoleTarget = pretty ?? { target: "pino/file", options: { destination: 1 } };
  return {
    targets: [
      { ...consoleTarget, level },
      {
        target: rollTarget,
        level,
        options: {
          file: env.logFile,
          frequency: "daily",
          size: "10m",
          limit: { count: 14 },
          mkdir: true,
        },
      },
    ],
  };
}

/**
 * The process-wide logger. Fastify is handed this instance, so req.log is a
 * child of it and every line shares one level, format, and redaction policy.
 */
export const logger: Logger = pino({
  level,
  redact: { paths: REDACT_PATHS, censor: "[redacted]" },
  transport: buildTransport(),
});

/** A logger for a module with no Fastify request in scope; tags every line with `module`. */
export function moduleLogger(module: string): Logger {
  return logger.child({ module });
}

/**
 * Last-resort handlers for errors that escaped every other net. An unhandled
 * rejection would otherwise terminate the process (Node's default since v15);
 * staying up with a logged error beats dropping scheduled automations, so it's
 * downgraded to a log. An uncaught exception leaves process state undefined, so
 * it is logged and the process exits.
 */
export function installProcessErrorHandlers(log: Logger = logger): void {
  process.on("unhandledRejection", (reason) => {
    log.error({ err: reason }, "unhandled promise rejection");
  });

  process.on("uncaughtException", (error) => {
    log.fatal({ err: error }, "uncaught exception — exiting");
    // pino-pretty runs in a worker thread; give it a moment to drain before the
    // process dies, or the fatal line above is never written.
    setTimeout(() => process.exit(1), 100);
  });
}
