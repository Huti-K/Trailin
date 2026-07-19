import { jsonSecretFile } from "../../core/utils/jsonSecretFile.js";

/**
 * onOffice credentials (token + secret) in their own file, not the SQLite
 * settings table: GET /api/backup streams the whole DB unauthenticated, so the
 * secret stays out of it. Storage discipline is jsonSecretFile.ts's.
 */

export interface OnOfficeSecret {
  token: string;
  secret: string;
}

const store = jsonSecretFile<OnOfficeSecret>({
  filename: "onoffice-secret.json",
  label: "onOffice credential",
  narrow: (value): value is OnOfficeSecret => {
    const p = value as Partial<OnOfficeSecret> | null;
    return typeof p?.token === "string" && typeof p?.secret === "string";
  },
});

/** @internal */
export const secretPath = store.path;

export async function readOnOfficeSecret(): Promise<OnOfficeSecret | undefined> {
  return store.read();
}

export async function writeOnOfficeSecret(value: OnOfficeSecret): Promise<void> {
  await store.write(value);
}

export async function deleteOnOfficeSecret(): Promise<void> {
  await store.delete();
}
