import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { moduleLogger } from "../../core/logger.js";
import { db, schema } from "../../db/index.js";
import { getSetting, setSetting } from "../../db/settings.js";

const log = moduleLogger("automations");

interface DefaultAutomation {
  name: string;
  // Earlier names; refreshUnmodifiedDefaults renames untouched rows in place,
  // and their seed flags still guard re-seeding.
  previousNames: readonly string[];
  schedule: string;
  enabled: boolean;
  showInActivity: boolean;
  /** At most one default may set this (the pinned Home hero). */
  pinned: boolean;
  runOnNewMail: boolean;
  notifyOnCompletion: boolean;
  instruction: string;
}

// Default instruction texts live as prose in instructions/*.md, loaded eagerly
// so a missing file fails at startup. The path resolves against import.meta.url,
// which the desktop build copies instructions/ next to (build.mjs). The text
// must round-trip byte-identical (trimmed) — the seed/refresh logic below
// compares stored instructions against it and hashes it.
function readInstruction(name: string): string {
  return readFileSync(new URL(`./instructions/${name}.md`, import.meta.url), "utf8").trim();
}

const DEFAULT_AUTOMATIONS: DefaultAutomation[] = [
  {
    name: `Morgenbriefing`,
    previousNames: ["Morning briefing"],
    schedule: "0 8 * * *",
    enabled: true,
    showInActivity: true,
    pinned: true,
    runOnNewMail: false,
    notifyOnCompletion: false,
    instruction: readInstruction("morgenbriefing"),
  },
];

// Per-default seed flag: each seeds at most once ever, so deleting one never
// re-seeds it, yet a default added later still reaches existing installs.
const DEFAULT_SEEDED_KEY_PREFIX = "automations.defaultSeeded.";

/**
 * sha256 of every instruction text a previous version seeded (looked up under
 * previousNames aliases too). A listed hash means that stored instruction is
 * ours and untouched by the user, so refreshUnmodifiedDefaults may overwrite it
 * with the current text; anything unlisted is the user's own prose. Append the
 * outgoing hash on every instruction change; drop none.
 */
const SUPERSEDED_INSTRUCTION_HASHES: Record<string, readonly string[]> = {
  Morgenbriefing: [
    "0998189fc3533bde38d61e1d508ec6e77378a3d73209cc8e5dbeb6f2d6511034",
    "eb629153709687168e1bd914a1bcf2f8ff2aedcbcc20003b232225b7c95eb59f",
    "e68d5f2bca75eec90583f9f9d39d1772b52a567e1f7408b343727bd44338c572",
    "faa799adad451168271033bbac979f2b140ef593d282e8a10c0fa39760f3e86a",
    "7c4621cb73762f3084063f3badbc68acd13cd32fcdbb636312ad5abb366290a9",
    "0b520b578e9c44272df6d60d6e7b36f3fa39b927ba610e6eba79ceb85c80d269",
    "a6d6449e13be71a758a3f7267e96fdb2b7493ad11a7e9c42012703aa58aec904",
    "8143dcf1f711d79a4ce3c54cd18eb48151579ba2fe55e3368004aaedfee2aaf9",
    "6f950cc9cca011fafd533f75a70be207178833ce67b28a6dec56c16bc42bcd79",
    "970259db349d8b1a3381a12b55d5bd3f89816ffab7ed1fd454e114b33a3fe1f3",
    "9e4c71afed90559d4656e7fd5eb066290ced32eeb8172a3cd17d5d3aa8db0feb",
    "592cd77cd0c5c40c6a30caa663c8a910c59217c40cd5abe19a91faf442eadbc8",
    "e2a47a74653ca955ea376ba5da9731c8ae21a8e22c8602be73930facf33d7fc3",
    "399fdc4a2c5fce9ee3cc95618ee56576158053d4a0ba2f482bea56cbdf5db773",
    "4c31b690979bff36728ab4a71ea1353a74853bb2cece4c05421d8fdfc5748c22",
  ],
};

function instructionHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Rewrites untouched built-in automations to the current name and instruction
 * (renaming previousNames rows in the same write). Idempotent: a rewritten
 * row's hash no longer matches a superseded entry, so later boots no-op.
 */
async function refreshUnmodifiedDefaults(): Promise<void> {
  const rows = await db
    .select({
      id: schema.automations.id,
      name: schema.automations.name,
      instruction: schema.automations.instruction,
    })
    .from(schema.automations);

  for (const row of rows) {
    const current = DEFAULT_AUTOMATIONS.find(
      (a) => a.name === row.name || a.previousNames.includes(row.name),
    );
    if (!current) continue;
    if (row.name === current.name && row.instruction === current.instruction) continue;

    const superseded = SUPERSEDED_INSTRUCTION_HASHES[current.name] ?? [];
    const untouched =
      row.instruction === current.instruction ||
      superseded.includes(instructionHash(row.instruction));
    if (!untouched) continue;

    await db
      .update(schema.automations)
      .set({ name: current.name, instruction: current.instruction })
      .where(eq(schema.automations.id, row.id));
    log.info({ automation: current.name }, "refreshed unmodified default automation");
  }
}

/**
 * Seed the built-in automations: each seeds at most once ever (deleting one
 * never brings it back), and a default whose name already exists is adopted,
 * not duplicated. Also refreshes unedited defaults on every call. Call before
 * startScheduler().
 */
export async function seedDefaultAutomations(): Promise<void> {
  await refreshUnmodifiedDefaults();

  const now = Date.now();
  for (const [i, preset] of DEFAULT_AUTOMATIONS.entries()) {
    // A previous name's flag still counts as seeded, so a rename can't resurrect
    // a default the user deleted under its old name.
    const key = `${DEFAULT_SEEDED_KEY_PREFIX}${preset.name}`;
    const seedKeys = [key, ...preset.previousNames.map((n) => `${DEFAULT_SEEDED_KEY_PREFIX}${n}`)];
    const flags = await Promise.all(seedKeys.map((k) => getSetting(k)));
    if (flags.includes("true")) continue;

    const [existing] = await db
      .select({ id: schema.automations.id })
      .from(schema.automations)
      .where(eq(schema.automations.name, preset.name))
      .limit(1);
    if (!existing) {
      await db.insert(schema.automations).values({
        id: randomUUID(),
        name: preset.name,
        instruction: preset.instruction,
        schedule: preset.schedule,
        enabled: preset.enabled,
        showInActivity: preset.showInActivity,
        pinned: preset.pinned,
        runOnNewMail: preset.runOnNewMail,
        notifyOnCompletion: preset.notifyOnCompletion,
        // Distinct keys so the first entry leads the position-asc list.
        position: -(now - i * 1000),
        createdAt: new Date(now - i * 1000).toISOString(),
      });
      log.info({ automation: preset.name }, "seeded default automation");
    }
    await setSetting(key, "true");
  }
}
