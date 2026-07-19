import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Suite-wide guard: no test may ever touch the real agent home, the legacy
// ~/Trailin home, the dev database, or the pre-home data folders —
// initAgentHome() MOVES files from the legacy home and skills/library
// locations and drops the legacy memories table, so an unisolated path here
// would destroy real data. Tests
// that need their own locations still set these themselves before importing
// src modules (env.ts reads them at import); these defaults catch the rest.
const scratch = mkdtempSync(join(tmpdir(), "trailin-test-"));
process.env.AGENT_HOME_PATH ??= join(scratch, "home");
process.env.LEGACY_AGENT_HOME_PATH ??= join(scratch, "legacy-home");
process.env.DATABASE_PATH ??= join(scratch, "trailin.db");
process.env.SKILLS_PATH ??= join(scratch, "legacy-skills");
process.env.LIBRARY_PATH ??= join(scratch, "legacy-library");
