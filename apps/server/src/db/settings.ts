import { eq } from "drizzle-orm";
import { isLanguage, type Language } from "@trailin/shared";
import { db, schema } from "./index.js";

/** Simple key/value settings persisted in SQLite. */

export async function getSetting(key: string): Promise<string | undefined> {
  const [row] = await db.select().from(schema.settings).where(eq(schema.settings.key, key));
  return row?.value;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await db
    .insert(schema.settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value } });
}

export async function deleteSetting(key: string): Promise<void> {
  await db.delete(schema.settings).where(eq(schema.settings.key, key));
}

export const LANGUAGE_SETTING_KEY = "app.language";

/** The chosen language, or null until the web app first sets one from the browser locale. */
export async function getLanguageSetting(): Promise<Language | null> {
  const value = await getSetting(LANGUAGE_SETTING_KEY);
  return isLanguage(value) ? value : null;
}

export const TIMEZONE_SETTING_KEY = "app.timezone";

/** True for a string Intl recognizes as an IANA timezone identifier. */
export function isValidTimezone(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** The chosen IANA timezone, or null until the web app first sets one from the browser. */
export async function getTimezoneSetting(): Promise<string | null> {
  const value = await getSetting(TIMEZONE_SETTING_KEY);
  return isValidTimezone(value) ? value : null;
}

export const EMAIL_WRITE_SETTING_KEY = "agent.allowEmailWrite";

/**
 * Whether the agent gets tools that send or change anything. Defaults to
 * false: read-only (plus drafts) until the user explicitly allows more.
 */
export async function getEmailWriteSetting(): Promise<boolean> {
  return (await getSetting(EMAIL_WRITE_SETTING_KEY)) === "true";
}

export const LIBRARY_FOLDER_SETTING_KEY = "library.folder";

/** The user-chosen library drop folder, or null to fall back to the LIBRARY_PATH env default. */
export async function getLibraryFolderSetting(): Promise<string | null> {
  return (await getSetting(LIBRARY_FOLDER_SETTING_KEY)) ?? null;
}

export const ACCOUNT_COLORS_SETTING_KEY = "account.colors";

/** All persisted account color assignments. */
export async function getAccountColors(): Promise<import("@trailin/shared").AccountColor[]> {
  const raw = await getSetting(ACCOUNT_COLORS_SETTING_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export async function setAccountColors(colors: import("@trailin/shared").AccountColor[]): Promise<void> {
  await setSetting(ACCOUNT_COLORS_SETTING_KEY, JSON.stringify(colors));
}

export const ACCOUNT_DESCRIPTIONS_SETTING_KEY = "account.descriptions";

/** All persisted per-account purpose notes (fed to the agent as tool context). */
export async function getAccountDescriptions(): Promise<
  import("@trailin/shared").AccountDescription[]
> {
  const raw = await getSetting(ACCOUNT_DESCRIPTIONS_SETTING_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export async function setAccountDescriptions(
  descriptions: import("@trailin/shared").AccountDescription[],
): Promise<void> {
  await setSetting(ACCOUNT_DESCRIPTIONS_SETTING_KEY, JSON.stringify(descriptions));
}

export const ACCOUNT_VOICES_SETTING_KEY = "account.voices";

/** All persisted per-account voices (signature + style notes for drafting). */
export async function getAccountVoices(): Promise<import("@trailin/shared").AccountVoice[]> {
  const raw = await getSetting(ACCOUNT_VOICES_SETTING_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export async function setAccountVoices(
  voices: import("@trailin/shared").AccountVoice[],
): Promise<void> {
  await setSetting(ACCOUNT_VOICES_SETTING_KEY, JSON.stringify(voices));
}

export const DEMO_DRAFTS_SETTING_KEY = "demo.drafts";

/** One demo Gmail draft, stored whole (list + detail views both read this). */
export interface DemoDraftRecord {
  id: string;
  messageId: string;
  threadId: string;
  subject: string;
  to: string;
  cc?: string;
  bcc?: string;
  date: string;
  webUrl: string;
  body: string;
}

/** Demo drafts, keyed by the fake account id — seeded once, then edited via deletes. */
export type DemoDraftStore = Record<string, DemoDraftRecord[]>;

/** Fake Gmail drafts for demo mode (see email/gmailDrafts.ts), keyed by account id. */
export async function getDemoDraftStore(): Promise<DemoDraftStore> {
  const raw = await getSetting(DEMO_DRAFTS_SETTING_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export async function setDemoDraftStore(store: DemoDraftStore): Promise<void> {
  await setSetting(DEMO_DRAFTS_SETTING_KEY, JSON.stringify(store));
}
