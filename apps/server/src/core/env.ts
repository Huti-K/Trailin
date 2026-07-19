// Loads ./.env into process.env; already-set variables win. Missing file is
// fine (the packaged app and CI set their environment directly).
try {
  process.loadEnvFile();
} catch {}

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : undefined;
}

/** Numeric env var: boot fails loudly on a malformed value instead of running on NaN. */
function num(name: string, fallback: number): number {
  const raw = optional(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (Number.isNaN(value)) throw new Error(`${name} must be a number, got "${raw}"`);
  return value;
}

function pipedreamEnvironment(): "development" | "production" {
  const value = optional("PIPEDREAM_ENVIRONMENT") ?? "development";
  if (value !== "development" && value !== "production") {
    throw new Error(`PIPEDREAM_ENVIRONMENT must be "development" or "production", got "${value}"`);
  }
  return value;
}

export const env = {
  port: num("PORT", 3001),
  // Loopback by default: the API has no authentication, so it is not
  // reachable from the LAN out of the box. Set HOST=0.0.0.0 to expose it deliberately.
  host: optional("HOST") ?? "127.0.0.1",
  isProduction: process.env.NODE_ENV === "production",
  /** pino level: fatal | error | warn | info | debug | trace | silent. */
  logLevel: optional("LOG_LEVEL") ?? "info",
  // Opt-in file sink for logs (rotated daily / at 10MB, 14 kept); unset = stdout only.
  logFile: optional("LOG_FILE"),
  // Hard deadline for one automation run, so a stuck model/MCP call can't wedge a schedule forever.
  automationRunTimeoutMs: num("AUTOMATION_RUN_TIMEOUT_MS", 300_000),
  databasePath: optional("DATABASE_PATH") ?? "./data/trailin.db",
  /**
   * The agent's home folder: memory/, skills/ and knowledge/ live under it as
   * plain browsable files (see home/agentHome.ts). Project-relative by default;
   * the desktop shell points it into Electron's userData. Tests and the verify
   * skill point this at a scratch folder for isolation.
   */
  agentHomePath: optional("AGENT_HOME_PATH") ?? "./agent-home",
  // Pre-relocation agent home; read only by the boot migration that moves its
  // contents into the current home. ~/Trailin was the old default location.
  legacyAgentHomePath: optional("LEGACY_AGENT_HOME_PATH") ?? "~/Trailin",
  /**
   * Pre-home library folder. Read only by the boot migration that moves its
   * files into the agent home's knowledge/; the desktop shell still sets it
   * so packaged upgrades can find their old location.
   */
  libraryPath: optional("LIBRARY_PATH") ?? "./data/library",
  /**
   * Pre-home skills folder. Read only by the boot migration that moves its
   * files into the agent home; the desktop shell still sets it so packaged
   * upgrades can find their old location.
   */
  skillsPath: optional("SKILLS_PATH") ?? "./data/skills",
  // Where the built web app lives when not at the repo-relative default; the
  // desktop shell points it at its packaged copy.
  webDistPath: optional("WEB_DIST_PATH"),

  agentProvider: optional("AGENT_PROVIDER") ?? "anthropic",
  agentModel: optional("AGENT_MODEL") ?? "claude-opus-4-8",

  // Fallbacks only; credentials saved in the app take precedence (see integrations/pipedream/connect.ts).
  pipedream: {
    clientId: optional("PIPEDREAM_CLIENT_ID"),
    clientSecret: optional("PIPEDREAM_CLIENT_SECRET"),
    projectId: optional("PIPEDREAM_PROJECT_ID"),
    environment: pipedreamEnvironment(),
    externalUserId: optional("PIPEDREAM_EXTERNAL_USER_ID") ?? "local-user",
  },
  // Fallbacks only; credentials saved in the app take precedence (see
  // integrations/onoffice/config.ts). onOffice connects natively with an API user's token + secret.
  onoffice: {
    token: optional("ONOFFICE_TOKEN"),
    secret: optional("ONOFFICE_SECRET"),
    apiUrl: optional("ONOFFICE_API_URL"),
  },
  /**
   * Folder holding the WhatsApp pairing credentials (signal keys + creds). The
   * desktop shell points this into Electron's userData, like the database.
   */
  whatsappAuthPath: optional("WHATSAPP_AUTH_PATH") ?? "./data/whatsapp-auth",
  // Optional upgrade for web_search: with a key it uses the Brave Search API;
  // without one it falls back to Exa's keyless MCP endpoint, so search works out of the box.
  webSearch: {
    braveApiKey: optional("BRAVE_SEARCH_API_KEY"),
  },
};
