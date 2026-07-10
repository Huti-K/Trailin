import { createRequire } from "node:module";
import { pino, type Logger, type TransportSingleOptions, type TransportMultiOptions } from "pino";
import { env } from "./env.js";

/**
 * Key names whose values must never reach a log line: the Pipedream OAuth
 * client secret, its access token, saved LLM API keys, and the Authorization
 * headers built from them.
 *
 * These are redacted by key name rather than by exact location because the
 * usual way a secret escapes is not someone logging it on purpose — it's an
 * SDK attaching the outbound request to the error it throws, so that a bare
 * `log.error({ err })` prints `err.config.headers.authorization`.
 *
 * pino's redaction has no recursive wildcard, so each key is covered to four
 * levels. That reaches the request config hanging off a serialized Error,
 * which is where these actually turn up. Anything nested deeper is not
 * redacted — don't log whole config objects.
 *
 * Paths are case-sensitive, hence the duplicated header names.
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

const REDACT_PATHS = SECRET_KEYS.flatMap((key) => [
  key,
  `*.${key}`,
  `*.*.${key}`,
  `*.*.*.${key}`,
]);

const LEVELS = new Set(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);
const level = LEVELS.has(env.logLevel) ? env.logLevel : "info";

const require_ = createRequire(import.meta.url);

/**
 * Colourized single-line logs while developing; raw JSON everywhere else, so
 * piping the output to a file or a log collector stays useful. pino-pretty is
 * a dev dependency — a production install won't have it, so fall back to JSON
 * rather than failing to boot. The target is resolved to an absolute path
 * because pino loads it inside a worker thread, which does not inherit this
 * package's pnpm resolution.
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
 * Where logs go. With no LOG_FILE this is unchanged: pino-pretty in a dev TTY,
 * or `undefined` (pino's fast direct-to-stdout JSON) otherwise. When LOG_FILE
 * is set, tee the same stream to a rotating file (pino-roll: daily or at 10MB,
 * 14 files kept) so an unattended run's output survives the terminal closing.
 */
function buildTransport(): TransportSingleOptions | TransportMultiOptions | undefined {
  const pretty = prettyTransport();
  if (!env.logFile) return pretty;
  // pino loads transport targets in a worker thread that doesn't inherit this
  // package's pnpm resolution, so resolve pino-roll to an absolute path (same
  // reason prettyTransport does). If it isn't installed, keep console logging
  // rather than taking the whole logger — and boot — down over a file sink.
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
 * The process-wide logger. Fastify is handed this instance (see index.ts), so
 * `req.log` is a child of it and every line — request, route, agent, scheduler
 * — shares one level, one format and one redaction policy.
 */
export const logger: Logger = pino({
  level,
  redact: { paths: REDACT_PATHS, censor: "[redacted]" },
  transport: buildTransport(),
});

/**
 * A logger for a module with no Fastify request in scope — the scheduler, the
 * MCP bridge, the seeders. Tags every line with `module` so one subsystem's
 * output can be filtered out of the stream.
 */
export function moduleLogger(module: string): Logger {
  return logger.child({ module });
}

/**
 * Last-resort handlers for errors that escaped every other net.
 *
 * An unhandled rejection would otherwise terminate the process (Node's default
 * since v15). For a personal email agent, staying up with a logged error beats
 * dropping the user's scheduled automations, so this downgrades it to a log.
 * An uncaught exception is different: the process state is undefined after
 * one, so it is logged and the process exits.
 */
export function installProcessErrorHandlers(log: Logger = logger): void {
  process.on("unhandledRejection", (reason) => {
    log.error({ err: reason }, "unhandled promise rejection");
  });

  process.on("uncaughtException", (error) => {
    log.fatal({ err: error }, "uncaught exception — exiting");
    // pino-pretty runs in a worker thread; give it a moment to drain before
    // the process dies, otherwise the fatal line above is never written.
    setTimeout(() => process.exit(1), 100);
  });
}
