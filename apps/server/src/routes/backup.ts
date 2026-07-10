import { createReadStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { sqlite } from "../db/index.js";
import { moduleLogger } from "../logger.js";

const log = moduleLogger("backup");

/**
 * Download a consistent snapshot of the SQLite database. better-sqlite3's
 * online `.backup()` is WAL-safe — copying the `.db` file directly while the
 * server runs is not, because recent writes may still live only in the `-wal`
 * side file. The snapshot holds everything in the DB (conversations, memories,
 * automations, draft links, the library index, the mailbox mirror, settings)
 * but NOT `data/auth.json` (LLM/Pipedream credentials), which lives outside the
 * DB and must be backed up separately.
 */
export async function backupRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/backup", async (_req, reply) => {
    const tmpPath = join(tmpdir(), `trailin-backup-${randomUUID()}.db`);
    await sqlite.backup(tmpPath);

    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    reply.header("Content-Type", "application/x-sqlite3");
    reply.header("Content-Disposition", `attachment; filename="trailin-backup-${stamp}.db"`);

    const stream = createReadStream(tmpPath);
    // Drop the temp snapshot once the response finishes or the transfer aborts.
    stream.on("close", () => {
      void unlink(tmpPath).catch((err: unknown) =>
        log.warn({ err, tmpPath }, "removing backup temp file failed"),
      );
    });
    return reply.send(stream);
  });
}
