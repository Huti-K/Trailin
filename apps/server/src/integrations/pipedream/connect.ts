import { PipedreamClient } from "@pipedream/sdk";
import type {
  ConnectedAccount,
  ConnectTokenResponse,
  PipedreamApp,
  PipedreamStatus,
} from "@trailin/shared";
import { EMAIL_APPS, POPULAR_APPS } from "@trailin/shared";
import { env } from "../../core/env.js";
import { AppError } from "../../core/errors.js";
import { createFetchCache } from "../../core/utils/fetchCache.js";
import { deleteSetting, getSetting, setSetting } from "../../db/settings.js";
import { deleteClientSecret, readClientSecret, writeClientSecret } from "./secretFile.js";

export type PipedreamEnvironment = "development" | "production";

export interface ConnectConfig {
  clientId: string;
  clientSecret: string;
  projectId: string;
  environment: PipedreamEnvironment;
  externalUserId: string;
  source: "settings" | "env";
}

// The client secret is not here: it lives in secretFile.ts, outside the SQLite
// settings table (see that module for why).
const KEYS = {
  clientId: "pipedream.clientId",
  projectId: "pipedream.projectId",
  environment: "pipedream.environment",
  useCustom: "pipedream.useCustom",
} as const;

function asEnvironment(value: string | undefined): PipedreamEnvironment {
  return value === "production" ? "production" : "development";
}

export function extractProjectId(input: string): string | null {
  return input.trim().match(/proj_[A-Za-z0-9]+/)?.[0] ?? null;
}

function builtinConfig(): ConnectConfig | null {
  const builtin = env.pipedream;
  if (!builtin.clientId || !builtin.clientSecret || !builtin.projectId) return null;
  return {
    clientId: builtin.clientId,
    clientSecret: builtin.clientSecret,
    projectId: builtin.projectId,
    environment: builtin.environment,
    externalUserId: builtin.externalUserId,
    source: "env",
  };
}

async function customConfig(): Promise<ConnectConfig | null> {
  const [clientId, projectId, environment, clientSecret] = await Promise.all([
    getSetting(KEYS.clientId),
    getSetting(KEYS.projectId),
    getSetting(KEYS.environment),
    readClientSecret(),
  ]);
  if (!clientId || !clientSecret || !projectId) return null;
  return {
    clientId,
    clientSecret,
    projectId,
    environment: asEnvironment(environment),
    externalUserId: env.pipedream.externalUserId,
    source: "settings",
  };
}

/**
 * Whether the user's own Pipedream project (vs built-in) is active. Unset
 * infers: saved custom credentials win, else built-in when available, else custom.
 */
async function getUseCustom(): Promise<boolean> {
  const explicit = await getSetting(KEYS.useCustom);
  if (explicit !== undefined) return explicit === "true";
  if (await getSetting(KEYS.clientId)) return true;
  return builtinConfig() === null;
}

export async function setUseCustom(useCustom: boolean): Promise<void> {
  await setSetting(KEYS.useCustom, String(useCustom));
  // Switching modes switches which project's accounts are "the" accounts; the
  // old mode's cache would otherwise leak into the new one.
  invalidateAccountsCache();
}

export async function getConnectConfig(): Promise<ConnectConfig | null> {
  return (await getUseCustom()) ? customConfig() : builtinConfig();
}

export async function pipedreamConfigured(): Promise<boolean> {
  return (await getConnectConfig()) !== null;
}

export async function getPipedreamStatus(): Promise<PipedreamStatus> {
  const [useCustom, config] = await Promise.all([getUseCustom(), getConnectConfig()]);
  return {
    configured: config !== null,
    mode: useCustom ? "custom" : "builtin",
    builtinAvailable: builtinConfig() !== null,
    source: config?.source ?? null,
    clientId: config?.clientId ?? null,
    projectId: config?.projectId ?? null,
    environment: config?.environment ?? "development",
    hasClientSecret: config !== null,
  };
}

export async function getSavedClientSecret(): Promise<string | undefined> {
  return readClientSecret();
}

export async function saveConnectSettings(input: {
  clientId: string;
  clientSecret: string;
  projectId: string;
  environment: PipedreamEnvironment;
}): Promise<void> {
  // Sequential, not Promise.all: concurrent setSetting calls each rebuild
  // db/settings.ts's whole-table cache from a different live snapshot, silently
  // dropping keys from the in-memory cache (the DB rows stay correct).
  await setSetting(KEYS.clientId, input.clientId);
  await setSetting(KEYS.projectId, input.projectId);
  await setSetting(KEYS.environment, input.environment);
  await writeClientSecret(input.clientSecret);
  // New credentials mean a different project/account list; the old cache is
  // no longer meaningful.
  invalidateAccountsCache();
}

/** Remove app-saved credentials; built-in ones (if any) become active again. */
export async function clearConnectSettings(): Promise<void> {
  // Sequential; see saveConnectSettings on why concurrent writes are unsafe.
  for (const key of Object.values(KEYS)) await deleteSetting(key);
  await deleteClientSecret();
  invalidateAccountsCache();
}

let cached: { client: PipedreamClient; signature: string } | null = null;

function signatureOf(config: ConnectConfig): string {
  return [config.clientId, config.clientSecret, config.projectId, config.environment].join("\n");
}

function buildClient(config: ConnectConfig): PipedreamClient {
  return new PipedreamClient({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    projectId: config.projectId,
    projectEnvironment: config.environment,
  });
}

async function getClient(): Promise<{ pd: PipedreamClient; config: ConnectConfig }> {
  const config = await getConnectConfig();
  if (!config) {
    throw new AppError(
      "Pipedream is not set up. Add your Pipedream credentials in Settings → Email.",
      409,
      {
        code: "pipedream_not_configured",
      },
    );
  }
  const signature = signatureOf(config);
  if (!cached || cached.signature !== signature) {
    cached = { client: buildClient(config), signature };
  }
  return { pd: cached.client, config };
}

/** Verify candidate credentials before saving: creating a Connect token
 *  exercises the OAuth client and project id. Throws Pipedream's error. */
export async function verifyConnectConfig(
  config: Pick<
    ConnectConfig,
    "clientId" | "clientSecret" | "projectId" | "environment" | "externalUserId"
  >,
): Promise<void> {
  const pd = buildClient(config as ConnectConfig);
  await pd.tokens.create({ externalUserId: config.externalUserId });
}

export async function getPipedreamAccessToken(): Promise<string> {
  const { pd } = await getClient();
  return pd.rawAccessToken;
}

export async function createConnectToken(app: string): Promise<ConnectTokenResponse> {
  const { pd, config } = await getClient();
  const res = await pd.tokens.create({ externalUserId: config.externalUserId });
  const url = new URL(res.connectLinkUrl);
  url.searchParams.set("app", app);
  return {
    token: res.token,
    connectLinkUrl: url.toString(),
    expiresAt: res.expiresAt instanceof Date ? res.expiresAt.toISOString() : String(res.expiresAt),
    externalUserId: config.externalUserId,
  };
}

/**
 * `listAccounts` cache: a short TTL plus in-flight dedup (fetchCache.ts) turns
 * N concurrent callers into one Pipedream round-trip. Failed fetches never
 * populate the cache, and a fetch dispatched under old credentials never
 * repopulates it once invalidateAccountsCache has run (fetchCache's generation
 * counter).
 */
const ACCOUNTS_CACHE_KEY = "accounts";

const accountsCache = createFetchCache<ConnectedAccount[]>({ ttlMs: 60_000 });

/** Drop the cache so the next call fetches live; call when accounts or the active project change. */
export function invalidateAccountsCache(): void {
  accountsCache.invalidate(ACCOUNTS_CACHE_KEY);
}

async function fetchAccountsLive(): Promise<ConnectedAccount[]> {
  const { pd, config } = await getClient();
  const page = await pd.accounts.list({ externalUserId: config.externalUserId });

  const accounts: ConnectedAccount[] = [];
  for await (const account of page) {
    const a = account as {
      id: string;
      app?: { nameSlug?: string; name?: string; imgSrc?: string };
      name?: string;
      healthy?: boolean;
      createdAt?: string | Date;
    };
    accounts.push({
      id: a.id,
      app: a.app?.nameSlug ?? "unknown",
      appName: a.app?.name,
      imgSrc: a.app?.imgSrc,
      name: a.name ?? a.app?.name ?? a.id,
      healthy: a.healthy ?? true,
      createdAt:
        a.createdAt instanceof Date ? a.createdAt.toISOString() : String(a.createdAt ?? ""),
    });
  }
  // Stable order: oldest first, so tool names stay stable as accounts are added.
  return accounts.sort((x, y) => x.createdAt.localeCompare(y.createdAt));
}

/**
 * All connected accounts. `refresh: true` bypasses a fresh cache entry (so the
 * Connections screen sees a just-linked account immediately) but still joins an
 * in-flight fetch rather than starting a second one.
 */
export async function listAccounts(opts: { refresh?: boolean } = {}): Promise<ConnectedAccount[]> {
  if (!opts.refresh) {
    const hit = accountsCache.peek(ACCOUNTS_CACHE_KEY);
    if (hit?.fresh) return hit.value;
  }
  return (await accountsCache.fetch(ACCOUNTS_CACHE_KEY, fetchAccountsLive)).value;
}

function mapPipedreamApp(app: unknown): PipedreamApp | null {
  const a = app as { nameSlug?: string; name?: string; imgSrc?: string };
  if (!a.nameSlug || !a.name) return null;
  return { slug: a.nameSlug, name: a.name, imgSrc: a.imgSrc };
}

export async function searchApps(query: string): Promise<PipedreamApp[]> {
  const { pd } = await getClient();
  const page = await pd.apps.list({ q: query, limit: 10 });
  const apps: PipedreamApp[] = [];
  for await (const app of page) {
    const mapped = mapPipedreamApp(app);
    if (!mapped) continue;
    apps.push(mapped);
    if (apps.length >= 10) break;
  }
  return apps;
}

const DEFAULT_APP_NAME_OVERRIDES: Record<string, string> = {
  slack_bot: "Slack",
};

async function resolveApp(pd: PipedreamClient, slug: string): Promise<PipedreamApp | null> {
  // A slug query isn't guaranteed to rank the exact app first; pull a few and
  // pick the exact slug match.
  const page = await pd.apps.list({ q: slug, limit: 5 });
  for await (const app of page) {
    const mapped = mapPipedreamApp(app);
    if (mapped?.slug === slug) {
      return { ...mapped, name: DEFAULT_APP_NAME_OVERRIDES[slug] ?? mapped.name };
    }
  }
  return null;
}

// The suggested set never changes at runtime; resolve it once per process.
let defaultAppsCache: PipedreamApp[] | null = null;

export async function getDefaultApps(): Promise<PipedreamApp[]> {
  if (defaultAppsCache) return defaultAppsCache;
  const { pd } = await getClient();
  const slugs: string[] = [...EMAIL_APPS, ...POPULAR_APPS];
  const resolved = await Promise.all(slugs.map((slug) => resolveApp(pd, slug)));
  defaultAppsCache = resolved.filter((a): a is PipedreamApp => a !== null);
  return defaultAppsCache;
}

export async function deleteAccount(accountId: string): Promise<void> {
  const { pd } = await getClient();
  await pd.accounts.delete(accountId);
}

/**
 * Authenticated request through Pipedream's Connect proxy (it injects the
 * account's OAuth credentials). Used where prebuilt components fall short: their
 * draft/send need a paid workspace for attachments; the proxy is on all plans.
 */
export async function proxyRequest(
  accountId: string,
  method: "get" | "post" | "put" | "patch" | "delete",
  url: string,
  opts: { params?: Record<string, string>; body?: unknown; signal?: AbortSignal } = {},
): Promise<unknown> {
  const { pd, config } = await getClient();
  const request = {
    url,
    externalUserId: config.externalUserId,
    accountId,
    params: opts.params,
  };
  const requestOptions = { abortSignal: opts.signal };
  if (method === "get") return pd.proxy.get(request, requestOptions);
  if (method === "delete") return pd.proxy.delete(request, requestOptions);
  if (method === "put")
    return pd.proxy.put(
      { ...request, body: (opts.body ?? {}) as Record<string, unknown> },
      requestOptions,
    );
  if (method === "patch")
    return pd.proxy.patch(
      { ...request, body: (opts.body ?? {}) as Record<string, unknown> },
      requestOptions,
    );
  return pd.proxy.post(
    { ...request, body: (opts.body ?? {}) as Record<string, unknown> },
    requestOptions,
  );
}
