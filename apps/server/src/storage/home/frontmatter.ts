/**
 * Flat frontmatter for the agent-home markdown files (memories, skills): a
 * leading `---` block of single-line `key: value` scalars, then the body.
 * Deliberately not YAML — no nesting, no quoting, no multi-line values — so
 * a file hand-edited in any editor parses predictably. A file without a
 * leading `---` is all body: a bare sentence dropped into the folder is
 * valid content, not a parse error.
 */

export interface FrontmatterFile {
  fields: Record<string, string>;
  body: string;
}

export function parseFrontmatter(text: string): FrontmatterFile {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return { fields: {}, body: normalized.trim() };
  const close = normalized.indexOf("\n---", 4);
  if (close === -1) return { fields: {}, body: normalized.trim() };
  const fields: Record<string, string> = {};
  for (const line of normalized.slice(4, close).split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key) fields[key] = value;
  }
  const bodyStart = normalized.indexOf("\n", close + 1);
  return { fields, body: bodyStart === -1 ? "" : normalized.slice(bodyStart + 1).trim() };
}

/** Empty-string values are omitted: absent and empty mean the same thing on read. */
export function serializeFrontmatter(fields: Record<string, string>, body: string): string {
  const lines = Object.entries(fields)
    .filter(([, value]) => value !== "")
    .map(([key, value]) => `${key}: ${value.replace(/\s+/g, " ").trim()}`);
  const block = lines.length > 0 ? `---\n${lines.join("\n")}\n---\n\n` : "";
  return `${block}${body.trim()}\n`;
}
