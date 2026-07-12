import "dotenv/config";

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : undefined;
}

export const env = {
  port: Number(optional("PORT") ?? 3001),
  // Loopback by default: the API has no authentication, so it must not be
  // reachable from the LAN out of the box. Set HOST=0.0.0.0 to expose it
  // deliberately (e.g. a container or a trusted host).
  host: optional("HOST") ?? "127.0.0.1",
  isProduction: process.env.NODE_ENV === "production",
  /** pino level: fatal | error | warn | info | debug | trace | silent. */
  logLevel: optional("LOG_LEVEL") ?? "info",
  // Opt-in file sink for logs (rotated daily / at 10MB, 14 files kept), so an
  // unattended run's output survives past the terminal. Unset = stdout only.
  logFile: optional("LOG_FILE"),
  // Hard deadline for a single automation run before its agent turn is
  // aborted, so a stuck model/MCP call can't wedge a schedule forever.
  automationRunTimeoutMs: Number(optional("AUTOMATION_RUN_TIMEOUT_MS") ?? 300_000),
  databasePath: optional("DATABASE_PATH") ?? "./data/trailin.db",
  /** Default drop folder for the document library; a folder saved in the app wins. */
  libraryPath: optional("LIBRARY_PATH") ?? "./data/library",

  agentProvider: optional("AGENT_PROVIDER") ?? "anthropic",
  agentModel: optional("AGENT_MODEL") ?? "claude-opus-4-8",

  /** Mailbox mirror (email/sync/): poll cadence, initial backfill window, page size. */
  sync: {
    intervalMs: Number(optional("SYNC_INTERVAL_MS") ?? 180_000),
    backfillDays: Number(optional("SYNC_BACKFILL_DAYS") ?? 30),
    pageSize: Number(optional("SYNC_PAGE_SIZE") ?? 50),
  },
  /** Thread enrichment (email/enrich/): cheap-tier model override + cycle caps. */
  enrich: {
    /** Model id tried against the active provider before the built-in cheap candidates. */
    model: optional("ENRICH_MODEL"),
    batch: Number(optional("ENRICH_BATCH") ?? 20),
    concurrency: Number(optional("ENRICH_CONCURRENCY") ?? 2),
  },
  /** Contacts core (email/contacts/): cheap-tier model override + cycle caps. */
  contacts: {
    /** Model id tried against the active provider before the built-in cheap candidates. */
    model: optional("CONTACTS_MODEL"),
    batch: Number(optional("CONTACTS_BATCH") ?? 20),
    concurrency: Number(optional("CONTACTS_CONCURRENCY") ?? 2),
  },

  // Fallbacks only — credentials saved in the app (Settings → Connect email)
  // take precedence; see pipedream/connect.ts.
  pipedream: {
    clientId: optional("PIPEDREAM_CLIENT_ID"),
    clientSecret: optional("PIPEDREAM_CLIENT_SECRET"),
    projectId: optional("PIPEDREAM_PROJECT_ID"),
    environment: (optional("PIPEDREAM_ENVIRONMENT") ?? "development") as
      | "development"
      | "production",
    externalUserId: optional("PIPEDREAM_EXTERNAL_USER_ID") ?? "local-user",
  },
};
