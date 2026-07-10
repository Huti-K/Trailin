import * as React from "react";
import { AlertTriangle, MessageCircleQuestion, PenLine } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AccountColor, ConnectedAccount } from "@trailin/shared";
import { api } from "@/lib/api";
import { Markdown } from "@/components/ui/markdown";
import { dispatchQuickAction } from "@/lib/quickActions";
import { cn } from "@/lib/utils";

/**
 * Morning-briefing-shaped digests (see apps/server/src/demo/content.ts and
 * apps/server/src/automations/defaults.ts) look like:
 *
 *   **selin.kaya.mail@gmail.com (Personal)**
 *   - **Ayşe Kaya** — Geburtstag von Opa — erinnert daran, dass ...
 *   - 3 Newsletter/Angebote nicht aufgeführt: Zalando Sale, Duolingo, Spotify.
 *
 * — a bold heading line naming the account, followed by `- **Sender** —
 * Subject — gist` bullets (gist optionally prefixed "⚠️ " for urgent), plus
 * an occasional plain trailing bullet (the newsletter rollup). The heading's
 * bold span carries the email; real runs also trail arbitrary prose after it
 * (`**a@b.com** (2 messages, both low-value)`), which this module keeps as
 * part of the heading text rather than requiring the bold to span the whole
 * line. Item bullets are also recognized when the agent skips a heading
 * altogether, rendering as an unlabeled ("implicit") section. This module
 * parses that shape and renders it as a structured digest; anything that
 * isn't shaped like this — a chat reply, an End-of-day learnings run, a
 * one-off report — falls back to the plain Markdown renderer untouched.
 */

/** One recognized item bullet: `- **Sender** — Subject — gist`. */
export interface DigestItem {
  sender: string;
  subject: string;
  gist: string;
  /** True when the gist was prefixed with the agent's "⚠️ " urgent marker. */
  urgent: boolean;
}

/** One per-account section: a bold-headed line whose bold span contains the
 *  account's email, its recognized item bullets, and any other bullet lines
 *  in the section that don't fit the item shape (e.g. a newsletter-count
 *  rollup). `heading: ""` / `email: null` marks the implicit section that
 *  collects item bullets found with no heading above them at all — it never
 *  has footnotes, since an unheaded non-item bullet has nothing to attach
 *  to and is kept in `otherMarkdown` instead. */
export interface DigestAccountSection {
  /** Raw heading text, e.g. "selin.kaya.mail@gmail.com (Personal)". */
  heading: string;
  /** Email address extracted from the heading, if any. */
  email: string | null;
  items: DigestItem[];
  footnotes: string[];
}

export interface ParsedDigest {
  accounts: DigestAccountSection[];
  /** Everything outside a recognized account section — other headings, a
   *  drafts-created note, the closing report paragraph — kept verbatim so
   *  it can still be rendered (as markdown) below the structured sections. */
  otherMarkdown: string;
}

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
// Matches only the opening bold span, not the whole line, so trailing prose
// after the closing "**" (parentheticals, "— 8 messages: ...") doesn't break
// the match. The email must be inside the bold span itself — trailing text
// is appended to the heading but never searched for an email.
const HEADING_RE = /^\*\*(.+?)\*\*(.*)$/;
// Accepts an em dash, an en dash, or a spaced hyphen as the "— " separator —
// emailAgent.ts's system prompt tells the model to avoid em/en dashes, so a
// model that obeys was silently falling through to the plain-markdown
// fallback below (hasDigestShape returning false) instead of parsing.
const ITEM_RE = /^-\s*\*\*(.+?)\*\*(?:\s*[—–]\s*|\s-\s)(.+?)(?:\s*[—–]\s*|\s-\s)(.+)$/;
const URGENT_PREFIX = "⚠️ ";

/** Parses one `- **Sender** — Subject — gist` bullet; null if the line
 *  doesn't fit the item shape (a footnote, or unrelated prose). */
function parseItemBullet(bulletLine: string): DigestItem | null {
  const itemMatch = bulletLine.match(ITEM_RE);
  const sender = itemMatch?.[1];
  const subject = itemMatch?.[2];
  const gistRaw = itemMatch?.[3]?.trim();
  if (!sender || !subject || !gistRaw) return null;
  const urgent = gistRaw.startsWith(URGENT_PREFIX);
  return {
    sender: sender.trim(),
    subject: subject.trim(),
    gist: urgent ? gistRaw.slice(URGENT_PREFIX.length).trim() : gistRaw,
    urgent,
  };
}

/** Parses digest-shaped markdown; anything that doesn't match a recognized
 *  account heading or item bullet is preserved in `otherMarkdown`. */
export function parseDigest(markdown: string): ParsedDigest {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const accounts: DigestAccountSection[] = [];
  const otherLines: string[] = [];
  // The open unlabeled section for item bullets seen with no heading above
  // them. Reset to null after a real heading section so later stray bullets
  // start a new section instead of being appended out of order.
  let implicitSection: DigestAccountSection | null = null;
  let i = 0;

  while (i < lines.length) {
    const rawLine = lines[i] ?? "";
    const trimmed = rawLine.trim();
    const headingMatch = trimmed.match(HEADING_RE);
    const boldContent = headingMatch?.[1];
    const email = boldContent?.match(EMAIL_RE)?.[0];

    if (boldContent && email) {
      const heading = (boldContent + (headingMatch?.[2] ?? "")).trim();
      const items: DigestItem[] = [];
      const footnotes: string[] = [];
      let j = i + 1;
      while (j < lines.length && (lines[j] ?? "").trim().startsWith("-")) {
        const bulletLine = (lines[j] ?? "").trim();
        const item = parseItemBullet(bulletLine);
        if (item) items.push(item);
        else footnotes.push(bulletLine.replace(/^-\s*/, ""));
        j++;
      }
      // No bullets at all means this was prose that merely starts with a
      // bold email-bearing span, not a real section header — an empty
      // section would render nothing and silently delete the line.
      if (items.length === 0 && footnotes.length === 0) {
        otherLines.push(rawLine);
        i++;
        continue;
      }
      accounts.push({ heading, email, items, footnotes });
      implicitSection = null;
      i = j;
      continue;
    }

    if (trimmed.startsWith("-")) {
      const item = parseItemBullet(trimmed);
      if (item) {
        if (!implicitSection) {
          implicitSection = { heading: "", email: null, items: [], footnotes: [] };
          accounts.push(implicitSection);
        }
        implicitSection.items.push(item);
        i++;
        continue;
      }
    }

    otherLines.push(rawLine);
    i++;
  }

  return { accounts, otherMarkdown: otherLines.join("\n").trim() };
}

/** Whether a parsed digest has enough structure to render as one — at least
 *  one account section with at least one recognized item bullet. */
export function hasDigestShape(parsed: ParsedDigest): boolean {
  return parsed.accounts.some((section) => section.items.length > 0);
}

/**
 * Urgent-first ordering for display. The automation prompt already asks the
 * agent to rank by importance, but it is a model and the ⚠️ tier is the one
 * that must not be buried — so re-assert it here. Array#sort is stable, so
 * within each tier the agent's own importance ranking survives untouched.
 */
function urgentFirst<T extends { urgent: boolean }>(items: T[]): T[] {
  return [...items].sort((a, b) => Number(b.urgent) - Number(a.urgent));
}

/** Sections holding an urgent item lead, otherwise the agent's order stands. */
function sectionsByUrgency(sections: DigestAccountSection[]): DigestAccountSection[] {
  const hasUrgent = (s: DigestAccountSection) => s.items.some((item) => item.urgent);
  return [...sections].sort((a, b) => Number(hasUrgent(b)) - Number(hasUrgent(a)));
}

export function DigestView({
  content,
  automationName,
  runDate,
  className,
}: {
  content: string;
  /** Automation name and run date, used to compose the "ask about this" prefill question. */
  automationName?: string | null;
  runDate?: string | null;
  className?: string;
}) {
  const { t, i18n } = useTranslation();
  const [accounts, setAccounts] = React.useState<ConnectedAccount[]>([]);
  const [colors, setColors] = React.useState<AccountColor[]>([]);

  React.useEffect(() => {
    api.pipedreamAccounts().then(setAccounts).catch(() => {});
    api
      .accountColors()
      .then((r) => setColors(r.colors))
      .catch(() => {});
  }, []);

  const parsed = React.useMemo(() => parseDigest(content), [content]);

  if (!hasDigestShape(parsed)) {
    return <Markdown content={content} className={className} />;
  }

  const dateLabel = runDate
    ? new Date(runDate).toLocaleDateString(i18n.language, { day: "numeric", month: "short" })
    : "";

  const askAbout = (item: DigestItem) => {
    const text = t("automations.digest.askAboutPrompt", {
      automation: automationName || t("automations.digest.thisAutomation"),
      date: dateLabel,
      sender: item.sender,
      subject: item.subject,
      gist: item.gist,
    });
    dispatchQuickAction(text);
  };

  const draftReply = (item: DigestItem, section: DigestAccountSection) => {
    const account = section.email || section.heading;
    const text = account
      ? t("automations.digest.draftReplyPrompt", {
          sender: item.sender,
          subject: item.subject,
          account,
          gist: item.gist,
        })
      : t("automations.digest.draftReplyPromptNoAccount", {
          sender: item.sender,
          subject: item.subject,
          gist: item.gist,
        });
    dispatchQuickAction(text);
  };

  return (
    <div className={cn("flex flex-col gap-4", className)}>
      {sectionsByUrgency(parsed.accounts).map((section, sectionIndex) => {
        if (section.items.length === 0 && section.footnotes.length === 0) return null;
        const account = section.email
          ? accounts.find((a) => a.name.toLowerCase() === section.email!.toLowerCase())
          : undefined;
        const hex = account ? colors.find((c) => c.accountId === account.id)?.hex : undefined;
        const items = urgentFirst(section.items);

        return (
          <div key={sectionIndex} className="flex flex-col gap-2">
            {section.heading && (
              <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-muted-foreground">
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: hex || "var(--muted-foreground)" }}
                />
                {section.heading}
              </span>
            )}

            {items.length > 0 && (
              <div className="flex flex-col gap-1">
                {items.map((item, itemIndex) => (
                  <div
                    key={itemIndex}
                    className={cn(
                      "group -mx-2 flex items-start justify-between gap-2 rounded-lg px-2 py-1.5",
                      item.urgent && "tint-warning",
                    )}
                  >
                    <p className="min-w-0 flex-1 text-sm leading-relaxed">
                      {item.urgent && (
                        <AlertTriangle className="mr-1 -mt-0.5 inline-block h-3.5 w-3.5 shrink-0" />
                      )}
                      <span className="font-semibold">{item.sender}</span>{" "}
                      {item.subject}
                      <span className="mx-1.5 text-muted-foreground/50">·</span>
                      <span className={cn(!item.urgent && "text-muted-foreground")}>
                        {item.gist}
                      </span>
                    </p>
                    <div className="flex shrink-0 items-center gap-0.5">
                      <button
                        type="button"
                        onClick={() => draftReply(item, section)}
                        className="shrink-0 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-secondary hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100"
                        data-tooltip={t("automations.digest.draftReply")}
                        aria-label={t("automations.digest.draftReply")}
                      >
                        <PenLine className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => askAbout(item)}
                        className="shrink-0 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-secondary hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100"
                        data-tooltip={t("automations.digest.askAbout")}
                        aria-label={t("automations.digest.askAbout")}
                      >
                        <MessageCircleQuestion className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {section.footnotes.map((note, noteIndex) => (
              <p key={noteIndex} className="px-2 text-xs text-muted-foreground">
                {note}
              </p>
            ))}
          </div>
        );
      })}

      {parsed.otherMarkdown && (
        <Markdown
          content={parsed.otherMarkdown}
          className="border-t border-border pt-3 text-sm text-muted-foreground"
        />
      )}
    </div>
  );
}
