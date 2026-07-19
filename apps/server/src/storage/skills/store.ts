import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { SKILL_MAX_LENGTH, type Skill } from "@trailin/shared";
import { emitServerEvent } from "../../core/events.js";
import { writeFileAtomic } from "../../core/utils/atomicFile.js";
import { slugify } from "../../core/utils/util.js";
import { skillsDir } from "../home/agentHome.js";
import { parseFrontmatter, serializeFrontmatter } from "../home/frontmatter.js";

/**
 * The skills folder in the agent home: one markdown playbook per file,
 * `<name>.md`, with a `description:` frontmatter line (listed in the agent's
 * system prompt and on the Knowledge page) above the instructions the agent
 * follows via skill_read. The folder is the source of truth — no DB rows, no
 * index — so the user can also edit skills in any editor; every consumer
 * (prompt index, tools, routes) re-reads it on demand. A file without
 * frontmatter is a valid skill with an empty description.
 */

/** Absolute path of one skill's file; null when the name doesn't survive slugging. */
function skillPath(name: string): string | null {
  const slug = slugify(name);
  return slug ? join(skillsDir(), `${slug}.md`) : null;
}

function parseSkillFile(text: string): { description: string; instructions: string } {
  const { fields, body } = parseFrontmatter(text);
  return { description: fields.description ?? "", instructions: body };
}

/** Every skill, alphabetized by name. A missing folder is an empty list, not an error. */
export async function listSkills(): Promise<Skill[]> {
  let entries: string[];
  try {
    entries = await readdir(skillsDir());
  } catch {
    return [];
  }
  const skills = await Promise.all(
    entries
      .filter((file) => file.endsWith(".md"))
      .map(async (file): Promise<Skill | null> => {
        const path = join(skillsDir(), file);
        try {
          const [text, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
          const { description, instructions } = parseSkillFile(text);
          return {
            // macOS readdir can return NFD names; ids must round-trip as typed.
            name: file.slice(0, -".md".length).normalize("NFC"),
            description,
            instructions,
            updatedAt: info.mtime.toISOString(),
          };
        } catch {
          return null;
        }
      }),
  );
  return skills.filter((s): s is Skill => s !== null).sort((a, b) => a.name.localeCompare(b.name));
}

export async function readSkill(name: string): Promise<Skill | null> {
  const path = skillPath(name);
  if (!path) return null;
  try {
    const [text, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    const { description, instructions } = parseSkillFile(text);
    return {
      name: slugify(name),
      description,
      instructions,
      updatedAt: info.mtime.toISOString(),
    };
  } catch {
    return null;
  }
}

/**
 * Create or overwrite one skill (same-name write updates it in place).
 * Throws on an unusable name, an empty field, or an oversized body — callers
 * surface the message to the model or as a 400.
 */
export async function writeSkill(
  name: string,
  description: string,
  instructions: string,
): Promise<Skill> {
  const slug = slugify(name);
  if (!slug) throw new Error("skill name must contain letters or digits");
  const trimmedDescription = description.trim().replace(/\s+/g, " ");
  if (!trimmedDescription) throw new Error("skill description must not be empty");
  const trimmedInstructions = instructions.trim();
  if (!trimmedInstructions) throw new Error("skill instructions must not be empty");
  if (trimmedInstructions.length > SKILL_MAX_LENGTH) {
    throw new Error(`skill instructions must be at most ${SKILL_MAX_LENGTH} characters`);
  }

  const path = join(skillsDir(), `${slug}.md`);
  // Atomic temp+rename: the folder is watched and cloud-syncable, so a file
  // must never be observable half-written. Creates the folder if deleted.
  await writeFileAtomic(
    path,
    serializeFrontmatter({ description: trimmedDescription }, trimmedInstructions),
    0o644,
  );
  emitServerEvent("skills");
  const info = await stat(path);
  return {
    name: slug,
    description: trimmedDescription,
    instructions: trimmedInstructions,
    updatedAt: info.mtime.toISOString(),
  };
}

/** Delete one skill's file; false when it didn't exist. */
export async function deleteSkill(name: string): Promise<boolean> {
  const path = skillPath(name);
  if (!path) return false;
  try {
    await rm(path);
  } catch {
    return false;
  }
  emitServerEvent("skills");
  return true;
}
