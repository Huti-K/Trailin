import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { env } from "../core/env.js";
import * as schema from "./schema.js";
import { SCHEMA_STEPS } from "./schemaSteps.js";

/**
 * Lazy singleton: importing never touches the filesystem; the database is
 * created, opened, and DDL-initialized on first use, so tests can point
 * DATABASE_PATH at a scratch file before any query runs. Module-scope prepared
 * statements/transactions use lazyStatement / lazyTransaction for the same reason.
 */

type DrizzleDb = BetterSQLite3Database<typeof schema>;

interface DbHandle {
  sqlite: Database.Database;
  db: DrizzleDb;
}

let handle: DbHandle | null = null;

/**
 * Run every step past the file's user_version, each in its own transaction so
 * a failed step leaves the version at the last completed one. A file from a
 * newer build is refused outright: no downgrades (see schemaSteps.ts).
 */
function applySchema(sqlite: Database.Database): void {
  const version = sqlite.pragma("user_version", { simple: true }) as number;
  if (version > SCHEMA_STEPS.length) {
    throw new Error(
      `database is at schema version ${version}, this build knows ${SCHEMA_STEPS.length} — ` +
        `delete ${env.databasePath}* and restart to recreate it`,
    );
  }
  for (const [index, step] of SCHEMA_STEPS.entries()) {
    if (index < version) continue;
    sqlite.transaction(() => {
      sqlite.exec(step);
      sqlite.pragma(`user_version = ${index + 1}`);
    })();
  }
}

function openHandle(): DbHandle {
  if (handle) return handle;

  const dbPath = resolve(process.cwd(), env.databasePath);
  mkdirSync(dirname(dbPath), { recursive: true });

  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  // Wait up to 5s for a competing writer instead of throwing SQLITE_BUSY: under
  // WAL a second server process (pnpm start alongside pnpm dev) can hold the DB,
  // and a locked moment shouldn't fail a request.
  sqlite.pragma("busy_timeout = 5000");

  applySchema(sqlite);

  handle = { sqlite, db: drizzle(sqlite, { schema }) };
  return handle;
}

/** Forwards property access to the lazily opened target, so call sites use plain db.select() / sqlite.prepare(). */
function lazyView<T extends object>(resolveTarget: () => T): T {
  return new Proxy({} as T, {
    get(_stub, prop) {
      const target = resolveTarget();
      const value = Reflect.get(target as object, prop, target);
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
    has(_stub, prop) {
      return prop in (resolveTarget() as object);
    },
  });
}

export const db: DrizzleDb = lazyView(() => openHandle().db);

// Raw handle for the FTS5 tables and .backup(); drizzle can't address virtual tables.
export const sqlite: Database.Database = lazyView(() => openHandle().sqlite);

export { schema };

/**
 * Memoized prepare, safe at module scope: prepared on first call against
 * whichever handle is open, and re-prepared if the database was closed and
 * reopened since.
 */
export function lazyStatement(sql: string): () => Database.Statement {
  let prepared: { stmt: Database.Statement; owner: DbHandle } | null = null;
  return () => {
    const h = openHandle();
    if (!prepared || prepared.owner !== h) prepared = { stmt: h.sqlite.prepare(sql), owner: h };
    return prepared.stmt;
  };
}

/**
 * Memoized sqlite.transaction(fn), safe at module scope: built on first call
 * against whichever handle is open, and rebuilt after a close/reopen (the same
 * owner check lazyStatement uses).
 */
export function lazyTransaction<Args extends unknown[], Result>(
  fn: (...args: Args) => Result,
): (...args: Args) => Result {
  let built: { run: Database.Transaction<(...args: Args) => Result>; owner: DbHandle } | null =
    null;
  return (...args) => {
    const h = openHandle();
    if (!built || built.owner !== h) built = { run: h.sqlite.transaction(fn), owner: h };
    return built.run(...args);
  };
}

let generation = 0;

/**
 * Increments every time the handle is closed. Module-scope caches (e.g.
 * db/settings.ts) store the generation they loaded under and reload when it
 * moves, mirroring lazyStatement's owner check.
 */
export function dbGeneration(): number {
  return generation;
}

/** Close the handle (app shutdown, test teardown); the next access reopens. */
export function closeDb(): void {
  handle?.sqlite.close();
  handle = null;
  generation++;
}
