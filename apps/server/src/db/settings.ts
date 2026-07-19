import type {
  AccountColor,
  AccountPermissions,
  AccountVoice,
  FileAccessSettings,
} from "@trailin/shared";
import { isLanguage, type Language } from "@trailin/shared";
import { eq } from "drizzle-orm";
import { emitServerEvent } from "../core/events.js";
import { db, dbGeneration, schema } from "./index.js";

/**
 * Key/value settings, read through a whole-table in-memory cache (settings are
 * consulted on every prompt and model call). All reads and writes go through
 * this module, so write-through keeps the cache exact; the generation check
 * reloads it after closeDb(). A second process writing the same file isn't
 * reflected until restart (acceptable for a single-user app).
 */

let cache: { entries: Map<string, string>; generation: number } | null = null;

async function loadCache(): Promise<Map<string, string>> {
  const generation = dbGeneration();
  if (!cache || cache.generation !== generation) {
    const rows = await db.select().from(schema.settings);
    cache = { entries: new Map(rows.map((row) => [row.key, row.value])), generation };
  }
  return cache.entries;
}

export async function getSetting(key: string): Promise<string | undefined> {
  return (await loadCache()).get(key);
}

export async function setSetting(key: string, value: string): Promise<void> {
  const entries = await loadCache();
  await db
    .insert(schema.settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value } });
  entries.set(key, value);
}

export async function deleteSetting(key: string): Promise<void> {
  const entries = await loadCache();
  await db.delete(schema.settings).where(eq(schema.settings.key, key));
  entries.delete(key);
}

export const LANGUAGE_SETTING_KEY = "app.language";

export async function getLanguageSetting(): Promise<Language | null> {
  const value = await getSetting(LANGUAGE_SETTING_KEY);
  return isLanguage(value) ? value : null;
}

export const TIMEZONE_SETTING_KEY = "app.timezone";

export function isValidTimezone(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export async function getTimezoneSetting(): Promise<string | null> {
  const value = await getSetting(TIMEZONE_SETTING_KEY);
  return isValidTimezone(value) ? value : null;
}

/**
 * A settings value stored as a JSON array under one key. Read parses it back
 * (missing or unparseable reads as [], never throws); write serializes the
 * whole array.
 */
function jsonArraySetting<T>(key: string): {
  get: () => Promise<T[]>;
  set: (values: T[]) => Promise<void>;
} {
  return {
    async get(): Promise<T[]> {
      const raw = await getSetting(key);
      if (!raw) return [];
      try {
        return JSON.parse(raw) as T[];
      } catch {
        return [];
      }
    },
    async set(values: T[]): Promise<void> {
      await setSetting(key, JSON.stringify(values));
    },
  };
}

const ACCOUNT_COLORS_SETTING_KEY = "account.colors";
const accountColorsSetting = jsonArraySetting<AccountColor>(ACCOUNT_COLORS_SETTING_KEY);

export const getAccountColors = accountColorsSetting.get;
export const setAccountColors = accountColorsSetting.set;

const ACCOUNT_VOICES_SETTING_KEY = "account.voices";
const accountVoicesSetting = jsonArraySetting<AccountVoice>(ACCOUNT_VOICES_SETTING_KEY);

export const getAccountVoices = accountVoicesSetting.get;

// Serializes patchAccountVoice calls: the voices live as one JSON array under
// one key, so two interleaved read-modify-write cycles would each write the
// array as they read it, erasing the other account's update.
let accountVoicePatchChain: Promise<unknown> = Promise.resolve();

/**
 * Replace (or append) exactly one account's voice, leaving every other slot as
 * it is on disk at write time: the array is re-read inside the serialized
 * section and only this account's slot is swapped, so runs for different
 * accounts can overlap freely.
 */
export async function patchAccountVoice(
  accountId: string,
  update: (existing: AccountVoice | undefined) => AccountVoice,
): Promise<AccountVoice> {
  const run = accountVoicePatchChain.then(async () => {
    const voices = await accountVoicesSetting.get();
    const index = voices.findIndex((voice) => voice.accountId === accountId);
    const next = update(index >= 0 ? voices[index] : undefined);
    const updated =
      index >= 0 ? voices.map((voice, i) => (i === index ? next : voice)) : [...voices, next];
    await accountVoicesSetting.set(updated);
    return next;
  });
  // The chain only sequences; each caller still sees its own failure via `run`.
  accountVoicePatchChain = run.catch(() => {});
  return run;
}

const ONOFFICE_AUTOMATION_CREATES_KEY = "onoffice.automationCreates";

/**
 * Whether unattended automation runs may use onOffice's create tools. Off by
 * default: mail content reaching an unattended run could otherwise plant
 * records in the live CRM. Modify/delete/send stay interactive-only regardless.
 */
export async function getOnOfficeAutomationCreates(): Promise<boolean> {
  return (await getSetting(ONOFFICE_AUTOMATION_CREATES_KEY)) === "true";
}

export async function setOnOfficeAutomationCreates(enabled: boolean): Promise<void> {
  await setSetting(ONOFFICE_AUTOMATION_CREATES_KEY, enabled ? "true" : "false");
}

const ONOFFICE_WRITE_ACCESS_KEY = "onoffice.writeAccess";

/**
 * Whether interactive chat sessions may use onOffice's modify/delete/send
 * tools (and raw batches). Off by default (the CRM is live business data)
 * until the user arms it. Unattended runs never get these tools regardless.
 */
export async function getOnOfficeWriteAccess(): Promise<boolean> {
  return (await getSetting(ONOFFICE_WRITE_ACCESS_KEY)) === "true";
}

export async function setOnOfficeWriteAccess(enabled: boolean): Promise<void> {
  await setSetting(ONOFFICE_WRITE_ACCESS_KEY, enabled ? "true" : "false");
}

const WHATSAPP_SEND_ACCESS_KEY = "whatsapp.sendAccess";

/**
 * Whether interactive chat sessions may use whatsapp_send_message. Off by
 * default: a WhatsApp message dispatches immediately with no draft stage.
 * Unattended runs never get the send tool regardless.
 */
export async function getWhatsAppSendAccess(): Promise<boolean> {
  return (await getSetting(WHATSAPP_SEND_ACCESS_KEY)) === "true";
}

export async function setWhatsAppSendAccess(enabled: boolean): Promise<void> {
  await setSetting(WHATSAPP_SEND_ACCESS_KEY, enabled ? "true" : "false");
  // sendAccess is served as part of WhatsAppStatus.
  emitServerEvent("whatsapp");
}

const FILES_READ_KEY = "files.read";
const FILES_WRITE_KEY = "files.write";
const FILES_BASH_KEY = "files.bash";

/** The agent's filesystem grants; all off by default. */
export async function getFileAccessSettings(): Promise<FileAccessSettings> {
  return {
    read: (await getSetting(FILES_READ_KEY)) === "true",
    write: (await getSetting(FILES_WRITE_KEY)) === "true",
    bash: (await getSetting(FILES_BASH_KEY)) === "true",
  };
}

export async function setFileAccessSettings(next: FileAccessSettings): Promise<void> {
  await setSetting(FILES_READ_KEY, next.read ? "true" : "false");
  await setSetting(FILES_WRITE_KEY, next.write ? "true" : "false");
  await setSetting(FILES_BASH_KEY, next.bash ? "true" : "false");
}

const ACCOUNT_PERMISSIONS_SETTING_KEY = "account.permissions";
const accountPermissionsSetting = jsonArraySetting<AccountPermissions>(
  ACCOUNT_PERMISSIONS_SETTING_KEY,
);

/**
 * Per-account permission grants (write / send / delete) for the agent's
 * provider tools. An account without a record is read-only; drafts are always
 * allowed. Armed per account from Settings.
 */
export const getAccountPermissions = accountPermissionsSetting.get;
export const setAccountPermissions = accountPermissionsSetting.set;
