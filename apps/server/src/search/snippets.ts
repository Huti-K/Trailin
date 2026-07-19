export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Strip markdown so snippets render as plain text, not literal `## **…**` noise.
 * Runs before whitespace is collapsed: the line-anchored rules (headings,
 * quotes, bullets) need the newlines.
 */
function stripMarkdown(text: string): string {
  return (
    text
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")
      .replace(/^\s{0,3}>\s?/gm, "")
      .replace(/^\s{0,3}([-*+]|\d+\.)\s+/gm, "")
      .replace(/^\s{0,3}([-*_]\s*){3,}$/gm, " ")
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/__(.+?)__/g, "$1")
      .replace(/~~(.+?)~~/g, "$1")
      // Emphasis only when the asterisks hug the text; `a * b` and `2 * 3` survive.
      .replace(/\*(\S(?:[^*]*\S)?)\*/g, "$1")
  );
}

export function plainText(text: string): string {
  return collapseWhitespace(stripMarkdown(text));
}

/** Context kept each side of the first match; the palette list truncates to one line, the preview pane shows the whole thing. */
const SNIPPET_RADIUS = 160;

export function buildSnippet(text: string, query: string): string {
  const collapsed = plainText(text);
  if (!collapsed) return "";
  const idx = collapsed.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return collapsed.slice(0, SNIPPET_RADIUS * 2);
  const start = Math.max(0, idx - SNIPPET_RADIUS);
  const end = Math.min(collapsed.length, idx + query.length + SNIPPET_RADIUS);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < collapsed.length ? "…" : "";
  return `${prefix}${collapsed.slice(start, end)}${suffix}`;
}

export function trimSnippet(value: string, max = 200): string {
  const collapsed = collapseWhitespace(value);
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1).trimEnd()}…`;
}
