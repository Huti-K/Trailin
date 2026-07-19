import { jsonSecretFile } from "../../core/utils/jsonSecretFile.js";

/**
 * The Pipedream OAuth client secret in its own file, not the SQLite settings
 * table: GET /api/backup streams the whole DB unauthenticated, so this secret
 * stays out of it. Storage discipline is jsonSecretFile.ts's.
 */

interface SecretFile {
  clientSecret: string;
}

const store = jsonSecretFile<SecretFile>({
  filename: "pipedream-secret.json",
  label: "Pipedream client secret",
  narrow: (value): value is SecretFile =>
    typeof (value as Partial<SecretFile> | null)?.clientSecret === "string",
});

/** @internal */
export const secretPath = store.path;

export async function readClientSecret(): Promise<string | undefined> {
  return (await store.read())?.clientSecret;
}

export async function writeClientSecret(clientSecret: string): Promise<void> {
  await store.write({ clientSecret });
}

export async function deleteClientSecret(): Promise<void> {
  await store.delete();
}
