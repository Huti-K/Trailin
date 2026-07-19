import { promises as fs } from "node:fs";
import { dirname, resolve } from "node:path";
import { env } from "../env.js";
import { writeFileAtomic } from "./atomicFile.js";

/**
 * A JSON credential file stored next to the SQLite database, for secrets kept
 * out of the settings table (GET /api/backup streams the whole DB
 * unauthenticated). The invariants consumers rely on:
 *
 * - ENOENT reads as "no secret" (undefined).
 * - A corrupt or malformed file fails loudly, never as "no secret", or saving
 *   new credentials over it would silently discard what it held. The error
 *   names the label and path.
 * - Writes go through writeFileAtomic, so a crash mid-write can't leave a
 *   truncated file for the next read.
 * - Delete tolerates the file being absent.
 */

export interface JsonSecretFile<T> {
  path: string;
  read(): Promise<T | undefined>;
  write(value: T): Promise<void>;
  delete(): Promise<void>;
}

export function jsonSecretFile<T>(opts: {
  filename: string;
  /** Payload name used in error messages, e.g. "Pipedream client secret". */
  label: string;
  /** Validates the parsed payload shape; a false return fails the read loudly. */
  narrow: (value: unknown) => value is T;
}): JsonSecretFile<T> {
  const path = resolve(dirname(resolve(process.cwd(), env.databasePath)), opts.filename);

  return {
    path,

    async read(): Promise<T | undefined> {
      let raw: string;
      try {
        raw = await fs.readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw new Error(`failed to read ${opts.label} file at ${path}`, { cause: error });
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        throw new Error(`${opts.label} file at ${path} is corrupt`, { cause: error });
      }
      if (!opts.narrow(parsed)) {
        throw new Error(`${opts.label} file at ${path} is malformed`);
      }
      return parsed;
    },

    async write(value: T): Promise<void> {
      await writeFileAtomic(path, JSON.stringify(value, null, 2));
    },

    async delete(): Promise<void> {
      try {
        await fs.unlink(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
  };
}
