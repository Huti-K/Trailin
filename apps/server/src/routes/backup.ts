import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { moduleLogger } from "../core/logger.js";
import { sqlite } from "../db/index.js";

const log = moduleLogger("backup");

/**
 * better-sqlite3's online `.backup()` is WAL-safe; copying the `.db` file while
 * the server runs is not, since recent writes may live only in the `-wal` side
 * file. Excludes `data/auth.json` (LLM credentials), `data/pipedream-secret.json`,
 * and the agent home folder (memories, skills, knowledge documents) — those
 * live outside the DB and are backed up like any files.
 */
export const backupRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get("/api/backup", async (_req, reply) => {
    const tmpPath = join(tmpdir(), `trailin-backup-${randomUUID()}.db`);
    await sqlite.backup(tmpPath);

    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    reply.header("Content-Type", "application/x-sqlite3");
    reply.header("Content-Disposition", `attachment; filename="trailin-backup-${stamp}.db"`);

    const stream = createReadStream(tmpPath);
    // Drop the temp snapshot when the response finishes or aborts.
    stream.on("close", () => {
      void unlink(tmpPath).catch((err: unknown) =>
        log.warn({ err, tmpPath }, "removing backup temp file failed"),
      );
    });
    return reply.send(stream);
  });
};
