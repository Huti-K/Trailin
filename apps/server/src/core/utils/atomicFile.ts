import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";

/**
 * Write contents to path without leaving a truncated file on a crash mid-write:
 * write to a unique temp file in the same directory, fsync, then rename over the
 * target (same-filesystem rename is atomic). The unique temp name keeps
 * concurrent writers from publishing each other's partial writes; a failed write
 * unlinks its temp file.
 */
export async function writeFileAtomic(path: string, contents: string, mode = 0o600): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(tempPath, "w", mode);
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tempPath, path);
  } catch (error) {
    await fs.unlink(tempPath).catch(() => {});
    throw error;
  }
}
