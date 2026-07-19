import type { OnOfficeStatus } from "@trailin/shared";
import { env } from "../../core/env.js";
import { getOnOfficeAutomationCreates, getOnOfficeWriteAccess } from "../../db/settings.js";
import { OnOfficeClient, STABLE_URL } from "./client.js";
import { deleteOnOfficeSecret, readOnOfficeSecret, writeOnOfficeSecret } from "./secretFile.js";

export interface OnOfficeConfig {
  token: string;
  secret: string;
  apiUrl: string;
  source: "settings" | "env";
}

export async function getOnOfficeConfig(): Promise<OnOfficeConfig | null> {
  const saved = await readOnOfficeSecret();
  if (saved) {
    return {
      token: saved.token,
      secret: saved.secret,
      // A saved apiUrl override isn't a secret, so it rides the env; a saved
      // pair otherwise implies the default stable endpoint.
      apiUrl: env.onoffice.apiUrl || STABLE_URL,
      source: "settings",
    };
  }
  const { token, secret, apiUrl } = env.onoffice;
  if (token && secret) {
    return { token, secret, apiUrl: apiUrl || STABLE_URL, source: "env" };
  }
  return null;
}

export async function getOnOfficeClient(): Promise<OnOfficeClient | null> {
  const config = await getOnOfficeConfig();
  if (!config) return null;
  return new OnOfficeClient({ token: config.token, secret: config.secret, apiUrl: config.apiUrl });
}

/** Credential state for Settings; the token and secret never leave the server. */
export async function getOnOfficeStatus(): Promise<OnOfficeStatus> {
  const config = await getOnOfficeConfig();
  return {
    configured: config !== null,
    source: config?.source ?? null,
    apiUrl: config?.apiUrl ?? STABLE_URL,
    automationCreates: await getOnOfficeAutomationCreates(),
    writeAccess: await getOnOfficeWriteAccess(),
  };
}

/**
 * Save credentials to the secret file. An omitted token or secret keeps the
 * saved one, so the form can update one field without re-entering the other
 * (the secret is never sent to the browser to pre-fill). Throws when a field is
 * still missing after the merge.
 */
export async function saveOnOfficeConfig(input: {
  token?: string;
  secret?: string;
}): Promise<void> {
  const existing = await readOnOfficeSecret();
  const token = input.token?.trim() || existing?.token;
  const secret = input.secret?.trim() || existing?.secret;
  if (!token) throw new Error("token is required");
  if (!secret) throw new Error("secret is required");
  await writeOnOfficeSecret({ token, secret });
}

export async function clearOnOfficeConfig(): Promise<void> {
  await deleteOnOfficeSecret();
}
