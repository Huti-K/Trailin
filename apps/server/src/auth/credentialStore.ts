import { promises as fs } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import { env } from "../env.js";
import { moduleLogger } from "../logger.js";

const log = moduleLogger("credential-store");

/**
 * File-backed pi-ai CredentialStore (pi-ai only ships an in-memory one).
 * Holds one credential per provider id; pi-ai reads it on every model call
 * and writes refreshed OAuth tokens back through `modify`.
 */
export class FileCredentialStore implements CredentialStore {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async load(): Promise<Record<string, Credential>> {
    try {
      return JSON.parse(await fs.readFile(this.filePath, "utf8")) as Record<string, Credential>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      // A corrupt or unreadable store must never be treated as "no
      // credentials" — modify()/delete() would then save over the file and
      // permanently wipe every other provider's saved credential. Fail loudly.
      log.error({ err: error, filePath: this.filePath }, "failed to read credential store");
      throw error;
    }
  }

  private async save(all: Record<string, Credential>): Promise<void> {
    await fs.mkdir(dirname(this.filePath), { recursive: true });
    // Atomic write: a crash or power loss mid-write must never leave a
    // truncated/corrupt auth.json — load() would then wipe every credential
    // on the very next save. Write to a temp file in the same directory,
    // fsync it, then rename over the target (same-filesystem rename is atomic).
    const tempPath = `${this.filePath}.tmp`;
    const handle = await fs.open(tempPath, "w", 0o600);
    try {
      await handle.writeFile(JSON.stringify(all, null, 2));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tempPath, this.filePath);
  }

  read(providerId: string): Promise<Credential | undefined> {
    return this.enqueue(async () => (await this.load())[providerId]);
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.enqueue(async () => {
      const all = await this.load();
      const next = await fn(all[providerId]);
      if (next === undefined) {
        delete all[providerId];
      } else {
        all[providerId] = next;
      }
      await this.save(all);
      return next;
    });
  }

  delete(providerId: string): Promise<void> {
    return this.enqueue(async () => {
      const all = await this.load();
      delete all[providerId];
      await this.save(all);
    });
  }
}

// Stored next to the SQLite database (data/auth.json by default).
const authPath = resolve(dirname(resolve(process.cwd(), env.databasePath)), "auth.json");
export const credentialStore = new FileCredentialStore(authPath);
