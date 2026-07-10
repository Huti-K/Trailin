import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  Clock,
  CornerDownLeft,
  Database,
  FileText,
  Mail,
  MessageSquare,
  Newspaper,
  Search,
  X,
  type LucideIcon,
} from "lucide-react";
import type { AccountColor, ConnectedAccount, SearchResult } from "@trailin/shared";
import { api } from "@/lib/api";
import { dateTimeLabel } from "@/lib/dates";
import { NAV_ITEMS, type NavItem } from "@/lib/nav";
import { setPendingDraftFocus, setPendingKnowledgeFocus } from "@/lib/paletteFocus";
import { Chip } from "@/components/ui/chip";
import { IconButton } from "@/components/ui/icon-button";
import { cn, MOD_LABEL } from "@/lib/utils";

/**
 * Global command palette (Cmd+K / Ctrl+K), mounted once in App.tsx so the
 * shortcut works from any page. Searches chats, automation runs (briefings),
 * drafts, library documents and memories, previews the highlighted hit beside
 * the list, and jumps straight to it.
 */

type HitType = SearchResult["type"];
type Scope = HitType | "all";

/** Fixed grouping order the server already returns hits in. */
const GROUP_ORDER: HitType[] = ["run", "chat", "draft", "document", "memory"];

const GROUP_ICON: Record<HitType, LucideIcon> = {
  run: Newspaper,
  chat: MessageSquare,
  draft: Mail,
  document: FileText,
  memory: Database,
};

const DEBOUNCE_MS = 170;
const RECENTS_KEY = "trailin-recent-searches";
const RECENTS_MAX = 5;
/** A hit needs at least a substring match in its *title* to be promoted to "Top hit". */
const TOP_HIT_MIN_SCORE = 40;
/** Shared empty result set: a fresh `[]` per render would retrigger every memo that reads it. */
const NO_HITS: SearchResult[] = [];

/** Nudges hits of equal textual relevance apart. Deliberately sub-1 so text always wins. */
const TYPE_BIAS: Record<HitType, number> = { draft: 0.5, chat: 0.4, run: 0.3, document: 0.2, memory: 0.1 };

/** 100 exact · 80 prefix · 60 word-start · 40 substring · 0 miss. `query` must already be lowercase. */
function matchScore(text: string, query: string): number {
  const haystack = text.toLowerCase();
  if (haystack === query) return 100;
  if (haystack.startsWith(query)) return 80;
  const at = haystack.indexOf(query);
  if (at === -1) return 0;
  return /[\s\-–—:·/(]/.test(haystack[at - 1] ?? "") ? 60 : 40;
}

/**
 * Wraps every occurrence of `query` in `text`. A single character matches so
 * often that marking it up turns every snippet into confetti, so highlighting
 * only starts at two.
 */
function Highlight({ text, query }: { text: string; query: string }) {
  const trimmed = query.trim();
  if (trimmed.length < 2) return <>{text}</>;
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "ig"));
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="palette-mark">
            {part}
          </mark>
        ) : (
          <React.Fragment key={i}>{part}</React.Fragment>
        ),
      )}
    </>
  );
}

function loadRecents(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string").slice(0, RECENTS_MAX)
      : [];
  } catch {
    return [];
  }
}

/** Records a query that actually led somewhere. Case-insensitively de-duped, newest first. */
function rememberRecent(query: string): string[] {
  const lower = query.toLowerCase();
  const next = [query, ...loadRecents().filter((entry) => entry.toLowerCase() !== lower)].slice(0, RECENTS_MAX);
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    /* private mode / quota — recents are a nicety, never a failure. */
  }
  return next;
}

type Entry =
  | { kind: "nav"; key: string; nav: NavItem }
  | { kind: "hit"; key: string; hit: SearchResult }
  | { kind: "recent"; key: string; query: string };

interface Row {
  entry: Entry;
  /** Flat position the arrow keys move through, stable across group boundaries. */
  index: number;
}

interface Section {
  key: string;
  label: string;
  rows: Row[];
}

export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded bg-surface-2 px-1 font-sans text-[10px] font-medium text-muted-foreground",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

export function SearchPalette() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  /** Results plus the query they belong to, kept together so highlighting can
   *  never disagree with the snippets it is highlighting. */
  const [searched, setSearched] = React.useState<{ query: string; results: SearchResult[] } | null>(null);
  const [scope, setScope] = React.useState<Scope>("all");
  const [activeIndex, setActiveIndex] = React.useState(0);
  const [recents, setRecents] = React.useState<string[]>([]);
  const [accounts, setAccounts] = React.useState<ConnectedAccount[]>([]);
  const [colors, setColors] = React.useState<AccountColor[]>([]);
  const listRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  /** Bumped on every dispatched search so a slow early response can't overwrite a newer one. */
  const requestSeq = React.useRef(0);

  const trimmed = query.trim();
  const hits = React.useMemo(() => (trimmed && searched ? searched.results : NO_HITS), [trimmed, searched]);
  const hitQuery = searched?.query ?? "";
  // Results stay on screen while the next query is in flight; only the sweep line animates.
  const loading = trimmed !== "" && searched?.query !== trimmed;

  // Global shortcut, plus the header search buttons dispatching this event.
  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpenRequest = () => setOpen(true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("trailin:open-search", onOpenRequest);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("trailin:open-search", onOpenRequest);
    };
  }, []);

  // Fresh every time it opens — a stale query/result set from last time is never useful.
  React.useEffect(() => {
    if (!open) return;
    requestSeq.current++;
    setQuery("");
    setSearched(null);
    setScope("all");
    setActiveIndex(0);
    setRecents(loadRecents());
  }, [open]);

  // Lazily loaded once per session — only drafts need it, for the account colour dot.
  React.useEffect(() => {
    if (!open || accounts.length > 0) return;
    void Promise.all([
      api.pipedreamAccounts().catch(() => [] as ConnectedAccount[]),
      api.accountColors().catch(() => ({ colors: [] as AccountColor[] })),
    ]).then(([accts, colorRes]) => {
      setAccounts(accts);
      setColors(colorRes.colors);
    });
  }, [open, accounts.length]);

  React.useEffect(() => {
    if (!trimmed) {
      requestSeq.current++;
      setSearched(null);
      return;
    }
    const timer = setTimeout(() => {
      const seq = ++requestSeq.current;
      api
        .search(trimmed)
        .then((res) => seq === requestSeq.current && setSearched({ query: trimmed, results: res.results }))
        .catch(() => seq === requestSeq.current && setSearched({ query: trimmed, results: [] }));
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [trimmed]);

  const counts = React.useMemo(() => {
    const tally = {} as Record<HitType, number>;
    for (const hit of hits) tally[hit.type] = (tally[hit.type] ?? 0) + 1;
    return tally;
  }, [hits]);

  const availableScopes = React.useMemo(() => GROUP_ORDER.filter((type) => counts[type]), [counts]);

  // A new result set re-preselects the top hit, and drops a scope that no longer has any hits.
  React.useEffect(() => {
    setActiveIndex(0);
    setScope((current) => (current === "all" || hits.some((hit) => hit.type === current) ? current : "all"));
  }, [hits]);

  const navTitle = React.useCallback((nav: NavItem) => t(`views.${nav.id}.title` as any) as string, [t]);

  /**
   * Everything the list renders, in one pass, with a stable flat index per row.
   * Empty query → recents + every page. Otherwise → the single best match, then
   * matching pages, then hits grouped by type.
   */
  const sections = React.useMemo<Section[]>(() => {
    let cursor = 0;
    const row = (entry: Entry): Row => ({ entry, index: cursor++ });
    const built: Section[] = [];

    if (!trimmed) {
      if (recents.length > 0) {
        built.push({
          key: "recent",
          label: t("search.recent"),
          rows: recents.map((value) => row({ kind: "recent", key: `recent:${value}`, query: value })),
        });
      }
      built.push({
        key: "nav",
        label: t("search.shortcuts"),
        rows: NAV_ITEMS.map((nav) => row({ kind: "nav", key: `nav:${nav.id}`, nav })),
      });
      return built;
    }

    const lower = trimmed.toLowerCase();
    const navMatches = NAV_ITEMS.map((nav) => ({
      nav,
      score: Math.max(matchScore(navTitle(nav), lower), matchScore(nav.id, lower)),
    })).filter((candidate) => candidate.score > 0);

    // Narrowed to one type: the scope *is* the intent, so no top hit and no pages.
    let topHitKey: string | null = null;
    if (scope === "all") {
      // Pages get a small edge: a page is a cheap, predictable destination, so
      // "settings" should land on Settings, not on a document about settings.
      const ranked = [
        ...navMatches.map(({ nav, score }) => ({
          entry: { kind: "nav", key: `nav:${nav.id}`, nav } as Entry,
          score: score + 5,
        })),
        ...hits.map((hit) => ({
          entry: { kind: "hit", key: `hit:${hit.type}:${hit.id}`, hit } as Entry,
          score:
            Math.max(matchScore(hit.title, lower), hit.snippet.toLowerCase().includes(lower) ? 20 : 0) +
            TYPE_BIAS[hit.type],
        })),
      ].sort((a, b) => b.score - a.score);

      const best = ranked[0];
      // A snippet-only match is not a confident enough answer to promote.
      if (best && best.score >= TOP_HIT_MIN_SCORE) {
        topHitKey = best.entry.key;
        built.push({ key: "top", label: t("search.topHit"), rows: [row(best.entry)] });
      }

      const pages = navMatches.filter(({ nav }) => `nav:${nav.id}` !== topHitKey);
      if (pages.length > 0) {
        built.push({
          key: "nav",
          label: t("search.shortcuts"),
          rows: pages.map(({ nav }) => row({ kind: "nav", key: `nav:${nav.id}`, nav })),
        });
      }
    }

    const scopedHits = scope === "all" ? hits : hits.filter((hit) => hit.type === scope);
    for (const type of GROUP_ORDER) {
      const rows = scopedHits
        .filter((hit) => hit.type === type && `hit:${hit.type}:${hit.id}` !== topHitKey)
        .map((hit) => row({ kind: "hit", key: `hit:${hit.type}:${hit.id}`, hit }));
      if (rows.length > 0) built.push({ key: type, label: t(`search.groups.${type}` as any) as string, rows });
    }
    return built;
  }, [trimmed, hits, scope, recents, navTitle, t]);

  const rows = React.useMemo(() => sections.flatMap((section) => section.rows), [sections]);
  const activeRow = rows[activeIndex];

  // Results can shrink under the cursor (a scope narrows, a slow query lands).
  React.useEffect(() => {
    if (activeIndex > 0 && activeIndex >= rows.length) setActiveIndex(Math.max(0, rows.length - 1));
  }, [rows.length, activeIndex]);

  React.useEffect(() => {
    listRef.current?.querySelector(`[data-index="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const openHit = (hit: SearchResult) => {
    if (hit.type === "chat" || hit.type === "run") {
      window.dispatchEvent(new CustomEvent("trailin:open-chat", { detail: hit.id }));
      window.dispatchEvent(new CustomEvent("trailin:show-chat"));
    } else if (hit.type === "draft") {
      // Stashed before navigate: HomePanel may not be mounted yet to catch the
      // CustomEvent below (see lib/paletteFocus.ts).
      if (hit.accountId) setPendingDraftFocus({ accountId: hit.accountId, draftId: hit.id });
      navigate("/");
      window.dispatchEvent(
        new CustomEvent("trailin:open-draft", { detail: { accountId: hit.accountId, draftId: hit.id } }),
      );
    } else {
      setPendingKnowledgeFocus({ type: hit.type, id: hit.id });
      navigate("/knowledge");
      window.dispatchEvent(new CustomEvent("trailin:open-knowledge", { detail: { type: hit.type, id: hit.id } }));
    }
    setOpen(false);
  };

  const activate = (entry: Entry) => {
    if (entry.kind === "recent") {
      setQuery(entry.query);
      inputRef.current?.focus();
    } else if (entry.kind === "nav") {
      navigate(entry.nav.path);
      setOpen(false);
    } else {
      // Only a query that led somewhere is worth offering back next time.
      setRecents(rememberRecent(hitQuery));
      openHit(entry.hit);
    }
  };

  const cycleScope = (direction: 1 | -1) => {
    const wheel: Scope[] = ["all", ...availableScopes];
    const at = wheel.indexOf(scope);
    setScope(wheel[(at + direction + wheel.length) % wheel.length] ?? "all");
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const down = e.key === "ArrowDown" || (e.ctrlKey && e.key.toLowerCase() === "n");
    const up = e.key === "ArrowUp" || (e.ctrlKey && e.key.toLowerCase() === "p");
    if (down || up) {
      e.preventDefault();
      setActiveIndex((i) => (down ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1)));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (activeRow) activate(activeRow.entry);
    } else if (e.key === "Tab") {
      // Swallowed even with nothing to cycle: the input is the palette's only
      // tab stop, so the focus trap must never move focus off it.
      e.preventDefault();
      if (availableScopes.length > 1) cycleScope(e.shiftKey ? -1 : 1);
    } else if (e.key === "Backspace" && !query && scope !== "all") {
      setScope("all");
    }
  };

  const clearRecents = () => {
    try {
      localStorage.removeItem(RECENTS_KEY);
    } catch {
      /* ignore */
    }
    setRecents([]);
  };

  const colorFor = (accountId?: string) => colors.find((c) => c.accountId === accountId)?.hex;
  const accountName = (accountId?: string) => accounts.find((a) => a.id === accountId)?.name ?? accountId ?? "";

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="palette-overlay scrim fixed inset-0 z-[110]" />
        <DialogPrimitive.Content
          onKeyDown={onKeyDown}
          // Esc clears a typed query first, and only closes an empty palette.
          onEscapeKeyDown={(e) => {
            if (query) {
              e.preventDefault();
              setQuery("");
              inputRef.current?.focus();
            }
          }}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            inputRef.current?.focus();
          }}
          // Clicks anywhere in the panel (rows, chips, footer) must not pull
          // focus off the input — it owns the whole keyboard contract.
          onMouseDown={(e) => {
            if (!(e.target as HTMLElement).closest("input")) e.preventDefault();
          }}
          className="palette-panel fixed left-1/2 top-1/2 z-[120] flex w-[calc(100%-1.75rem)] max-w-xl flex-col overflow-hidden rounded-2xl bg-surface md:max-w-3xl"
        >
          <DialogPrimitive.Title className="sr-only">{t("search.title")}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">{t("search.hint")}</DialogPrimitive.Description>

          <div className="flex shrink-0 items-center gap-3 px-4">
            <Search className="h-[18px] w-[18px] shrink-0 text-muted-foreground" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("search.placeholder")}
              role="combobox"
              aria-expanded={rows.length > 0}
              aria-controls="palette-list"
              aria-activedescendant={activeRow ? `palette-row-${activeRow.index}` : undefined}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              className="h-14 w-full min-w-0 bg-transparent text-base outline-none placeholder:text-muted-foreground"
            />
            {query ? (
              <IconButton
                tabIndex={-1}
                onClick={() => {
                  setQuery("");
                  inputRef.current?.focus();
                }}
                aria-label={t("common.clearSearch")}
              >
                <X className="h-4 w-4" />
              </IconButton>
            ) : (
              <Kbd className="hidden px-1.5 sm:inline-flex">{MOD_LABEL}K</Kbd>
            )}
          </div>

          {/* Reserved (not conditional) while a query is active: the panel is centred
              on the viewport, so its height must never change mid-typing. */}
          {trimmed !== "" && (
            <div className="flex h-10 shrink-0 items-center gap-1.5 overflow-x-auto px-4">
              {availableScopes.length > 1 &&
                (["all", ...availableScopes] as Scope[]).map((value) => (
                  <Chip key={value} tabIndex={-1} active={scope === value} onClick={() => setScope(value)}>
                    {value === "all" ? t("search.scopeAll") : (t(`search.groups.${value}` as any) as string)}
                    {value !== "all" && <span className="tabular opacity-60">{counts[value]}</span>}
                  </Chip>
                ))}
            </div>
          )}

          {/* Invisible at rest — only the accent sweep shows while a query is in flight,
              so the previous results never blink out to a spinner. */}
          <div className="relative h-px shrink-0 overflow-hidden">
            {loading && <div className="palette-scan absolute inset-y-0 left-0 w-1/3 bg-accent" />}
          </div>

          {/* Fixed height, not max — a centred panel that resized with its content
              would wander vertically on every keystroke. */}
          <div className="flex h-[min(13rem,50vh)] min-h-0">
            <div
              id="palette-list"
              ref={listRef}
              role="listbox"
              aria-label={t("search.title")}
              className="scroll-stable min-w-0 flex-1 overflow-y-auto px-2 pb-2"
            >
              {rows.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center px-4 text-center">
                  <p className="text-sm text-foreground">{t("search.noResults", { q: trimmed })}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{t("search.noResultsHint")}</p>
                </div>
              ) : (
                sections.map((section) => (
                  <div key={section.key} role="group" aria-label={section.label}>
                    <div className="sticky top-0 z-10 flex items-center justify-between bg-surface px-2.5 pb-1 pt-2.5">
                      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
                        {section.label}
                      </p>
                      {section.key === "recent" && (
                        <button
                          type="button"
                          tabIndex={-1}
                          onClick={clearRecents}
                          className="text-[11px] font-medium text-muted-foreground/70 transition-colors hover:text-foreground"
                        >
                          {t("search.clearRecents")}
                        </button>
                      )}
                    </div>
                    {section.rows.map(({ entry, index }) => (
                      <PaletteRow
                        key={entry.key}
                        entry={entry}
                        index={index}
                        active={index === activeIndex}
                        query={hitQuery}
                        navTitle={navTitle}
                        colorFor={colorFor}
                        language={i18n.language}
                        onPointerMove={() => index !== activeIndex && setActiveIndex(index)}
                        onSelect={() => activate(entry)}
                      />
                    ))}
                  </div>
                ))
              )}
            </div>

            {/* Recessed tone separates the preview from the list — no divider line. */}
            <aside className="scroll-stable hidden w-[17rem] shrink-0 overflow-y-auto bg-surface-2/50 md:block">
              <PalettePreview
                entry={activeRow?.entry}
                query={hitQuery}
                navTitle={navTitle}
                accountName={accountName}
                colorFor={colorFor}
                language={i18n.language}
              />
            </aside>
          </div>

          <div className="flex h-9 shrink-0 items-center gap-4 bg-surface-2/50 px-4 text-[11px] text-muted-foreground/70">
            <span className="flex items-center gap-1.5">
              <span className="flex gap-0.5">
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd>
              </span>
              {t("search.hintNavigate")}
            </span>
            <span className="flex items-center gap-1.5">
              <Kbd>
                <CornerDownLeft className="h-2.5 w-2.5" />
              </Kbd>
              {t("search.hintOpen")}
            </span>
            {availableScopes.length > 1 && (
              <span className="hidden items-center gap-1.5 sm:flex">
                <Kbd className="px-1.5">tab</Kbd>
                {t("search.hintFilter")}
              </span>
            )}
            <span className="ml-auto flex items-center gap-1.5">
              <Kbd className="px-1.5">esc</Kbd>
              {t("search.hintClose")}
            </span>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

interface RowProps {
  entry: Entry;
  index: number;
  active: boolean;
  query: string;
  language: string;
  navTitle: (nav: NavItem) => string;
  colorFor: (accountId?: string) => string | undefined;
  onPointerMove: () => void;
  onSelect: () => void;
}

function PaletteRow({ entry, index, active, query, language, navTitle, colorFor, onPointerMove, onSelect }: RowProps) {
  const Icon = entry.kind === "nav" ? entry.nav.icon : entry.kind === "recent" ? Clock : GROUP_ICON[entry.hit.type];
  const title = entry.kind === "nav" ? navTitle(entry.nav) : entry.kind === "recent" ? entry.query : entry.hit.title;
  const hit = entry.kind === "hit" ? entry.hit : null;
  const dot = hit?.type === "draft" ? colorFor(hit.accountId) : undefined;

  return (
    <button
      type="button"
      id={`palette-row-${index}`}
      role="option"
      aria-selected={active}
      data-index={index}
      // Not a tab stop (see the Tab note in onKeyDown), and pointer *movement*
      // rather than enter — a stationary cursor must not steal the selection
      // from the arrow keys when the list scrolls underneath it.
      tabIndex={-1}
      onPointerMove={onPointerMove}
      onClick={onSelect}
      className={cn(
        "flex w-full scroll-mb-2 scroll-mt-9 items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors",
        active ? "bg-accent/10" : "hover:bg-secondary",
      )}
    >
      <span
        className={cn(
          "flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors",
          active ? "tint-accent" : "tint-neutral",
        )}
      >
        <Icon className="h-[15px] w-[15px]" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">
          {hit ? <Highlight text={title} query={query} /> : title}
        </span>
        {hit?.snippet && (
          <span className="block truncate text-xs text-muted-foreground">
            <Highlight text={hit.snippet} query={query} />
          </span>
        )}
      </span>
      {dot && <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: dot }} />}
      {hit?.date && (
        <span className="tabular shrink-0 text-[11px] text-muted-foreground/70">
          {dateTimeLabel(hit.date, language)}
        </span>
      )}
    </button>
  );
}

interface PreviewProps {
  entry: Entry | undefined;
  query: string;
  language: string;
  navTitle: (nav: NavItem) => string;
  accountName: (accountId?: string) => string;
  colorFor: (accountId?: string) => string | undefined;
}

/** Icon + type label, title, optional meta line and body, and the action Enter performs. */
function PreviewShell({
  icon: Icon,
  label,
  title,
  meta,
  body,
  action,
}: {
  icon: LucideIcon;
  label: string;
  title: React.ReactNode;
  meta?: React.ReactNode;
  body?: React.ReactNode;
  action: string;
}) {
  return (
    <div className="flex h-full flex-col p-4">
      <div className="flex items-center gap-2 text-muted-foreground/70">
        <Icon className="h-4 w-4 shrink-0" />
        <span className="text-[11px] font-medium uppercase tracking-wide">{label}</span>
      </div>
      <h3 className="mt-3 line-clamp-2 text-sm font-semibold leading-snug text-foreground">{title}</h3>
      {meta && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
          {meta}
        </div>
      )}
      {body && <p className="mt-3 line-clamp-3 text-xs leading-relaxed text-muted-foreground">{body}</p>}
      <div className="mt-auto flex items-center gap-1.5 pt-4 text-[11px] font-medium text-muted-foreground">
        <Kbd>
          <CornerDownLeft className="h-2.5 w-2.5" />
        </Kbd>
        {action}
      </div>
    </div>
  );
}

function PalettePreview({ entry, query, language, navTitle, accountName, colorFor }: PreviewProps) {
  const { t } = useTranslation();

  if (!entry) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <Search className="h-5 w-5 text-muted-foreground" />
        <p className="text-sm font-medium text-foreground">{t("search.title")}</p>
        <p className="text-xs leading-relaxed text-muted-foreground">{t("search.hint")}</p>
      </div>
    );
  }

  if (entry.kind === "recent") {
    return (
      <PreviewShell
        icon={Clock}
        label={t("search.recent")}
        title={entry.query}
        body={t("search.recentHint")}
        action={t("search.actionSearch")}
      />
    );
  }

  if (entry.kind === "nav") {
    return (
      <PreviewShell
        icon={entry.nav.icon}
        label={t("search.shortcuts")}
        title={navTitle(entry.nav)}
        body={t(`views.${entry.nav.id}.description` as any) as string}
        action={t("search.actionPage")}
      />
    );
  }

  const { hit } = entry;
  const color = hit.type === "draft" ? colorFor(hit.accountId) : undefined;
  return (
    <PreviewShell
      icon={GROUP_ICON[hit.type]}
      label={t(`search.groups.${hit.type}` as any) as string}
      title={<Highlight text={hit.title} query={query} />}
      meta={
        (hit.date || hit.accountId) && (
          <>
            {hit.date && <time className="tabular">{dateTimeLabel(hit.date, language)}</time>}
            {hit.type === "draft" && hit.accountId && (
              <span className="flex min-w-0 items-center gap-1.5">
                {color && <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />}
                <span className="truncate">{accountName(hit.accountId)}</span>
              </span>
            )}
          </>
        )
      }
      body={hit.snippet ? <Highlight text={hit.snippet} query={query} /> : undefined}
      action={t(`search.actions.${hit.type}` as any) as string}
    />
  );
}
