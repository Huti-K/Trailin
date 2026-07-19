import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { SearchResult } from "@trailin/shared";
import {
  CornerDownLeft,
  Database,
  FileText,
  type LucideIcon,
  Mail,
  MessageSquare,
  Newspaper,
  Search,
  X,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { GroupLabel } from "@/components/ui/group-label";
import { Highlight } from "@/components/ui/highlight";
import { IconButton } from "@/components/ui/icon-button";
import { IconChip } from "@/components/ui/icon-chip";
import { Kbd } from "@/components/ui/kbd";
import { api } from "@/lib/api";
import { dateTimeLabel } from "@/lib/dates";
import { visibleNavItems } from "@/lib/nav";
import { setPendingDraftFocus, setPendingKnowledgeFocus } from "@/lib/paletteFocus";
import { dispatchTrailin, subscribeTrailin } from "@/lib/trailinEvents";
import { cn, MOD_LABEL } from "@/lib/utils";

/**
 * Global command palette (Cmd+K / Ctrl+K), mounted once in App.tsx so the
 * shortcut works from any page. An empty query lists the app's pages; typing
 * filters them and searches chats, automation runs (briefings), drafts,
 * library documents and memories. Enter jumps to the highlighted row.
 */

type HitType = SearchResult["type"];

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
/** Shared empty result set: a fresh `[]` per render would retrigger every memo that reads it. */
const NO_HITS: SearchResult[] = [];

/** A page the palette can jump to, its copy already resolved to display strings. */
interface PageItem {
  /** Untranslated match key, so e.g. "settings" hits in any UI language. */
  id: string;
  path: string;
  icon: LucideIcon;
  title: string;
}

type Entry =
  | { kind: "nav"; key: string; nav: PageItem }
  | { kind: "hit"; key: string; hit: SearchResult };

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

export function SearchPalette({ onofficeConfigured }: { onofficeConfigured: boolean }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  /** Results plus the query they belong to, kept together so highlighting can
   *  never disagree with the snippets it is highlighting. */
  const [searched, setSearched] = React.useState<{ query: string; results: SearchResult[] } | null>(
    null,
  );
  const [activeIndex, setActiveIndex] = React.useState(0);
  const listRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  /** Bumped on every dispatched search so a slow early response can't overwrite a newer one. */
  const requestSeq = React.useRef(0);

  const trimmed = query.trim();
  const hits = React.useMemo(
    () => (trimmed && searched ? searched.results : NO_HITS),
    [trimmed, searched],
  );
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
    window.addEventListener("keydown", onKeyDown);
    const unsubscribeOpenSearch = subscribeTrailin("open-search", () => setOpen(true));
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      unsubscribeOpenSearch();
    };
  }, []);

  // Fresh every time it opens — a stale query/result set from last time is never useful.
  React.useEffect(() => {
    if (!open) return;
    requestSeq.current++;
    setQuery("");
    setSearched(null);
    setActiveIndex(0);
  }, [open]);

  // Each query change re-preselects the top row.
  React.useEffect(() => {
    setActiveIndex(0);
    if (!trimmed) {
      requestSeq.current++;
      setSearched(null);
      return;
    }
    const timer = setTimeout(() => {
      const seq = ++requestSeq.current;
      api
        .search(trimmed)
        .then(
          (res) =>
            seq === requestSeq.current && setSearched({ query: trimmed, results: res.results }),
        )
        .catch(() => seq === requestSeq.current && setSearched({ query: trimmed, results: [] }));
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [trimmed]);

  const pages = React.useMemo<PageItem[]>(
    () =>
      visibleNavItems(onofficeConfigured).map((nav) => ({
        id: nav.id,
        path: nav.path,
        icon: nav.icon,
        title: t(`views.${nav.id}.title`),
      })),
    [t, onofficeConfigured],
  );

  /**
   * Everything the list renders, in one pass, with a stable flat index per row.
   * Matching pages first, then hits grouped by type; an empty query lists all pages.
   */
  const sections = React.useMemo<Section[]>(() => {
    let cursor = 0;
    const row = (entry: Entry): Row => ({ entry, index: cursor++ });
    const built: Section[] = [];

    const lower = trimmed.toLowerCase();
    const navRows = pages
      .filter((nav) => !lower || nav.title.toLowerCase().includes(lower) || nav.id.includes(lower))
      .map((nav) => row({ kind: "nav", key: `nav:${nav.id}`, nav }));
    if (navRows.length > 0) built.push({ key: "nav", label: t("search.shortcuts"), rows: navRows });

    for (const type of GROUP_ORDER) {
      const rows = hits
        .filter((hit) => hit.type === type)
        .map((hit) => row({ kind: "hit", key: `hit:${hit.type}:${hit.id}`, hit }));
      if (rows.length > 0) built.push({ key: type, label: t(`search.groups.${type}`), rows });
    }
    return built;
  }, [trimmed, hits, pages, t]);

  const rows = React.useMemo(() => sections.flatMap((section) => section.rows), [sections]);
  const activeRow = rows[activeIndex];

  // Results can shrink under the cursor when a slow query lands.
  React.useEffect(() => {
    if (activeIndex > 0 && activeIndex >= rows.length) setActiveIndex(Math.max(0, rows.length - 1));
  }, [rows.length, activeIndex]);

  React.useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const openHit = (hit: SearchResult) => {
    if (hit.type === "chat" || hit.type === "run") {
      dispatchTrailin("open-chat", hit.id);
      dispatchTrailin("show-chat");
    } else if (hit.type === "draft") {
      // Stashed before navigate: HomePanel may not be mounted yet to catch the
      // CustomEvent below (see lib/paletteFocus.ts).
      if (hit.accountId) setPendingDraftFocus({ accountId: hit.accountId, draftId: hit.id });
      navigate("/");
      // SearchResult.accountId is optional in general, but every draft hit
      // carries one (drafts always belong to an account) — the same
      // invariant the setPendingDraftFocus guard above relies on.
      dispatchTrailin("open-draft", { accountId: hit.accountId as string, draftId: hit.id });
    } else {
      setPendingKnowledgeFocus({ type: hit.type, id: hit.id });
      navigate("/knowledge");
      dispatchTrailin("open-knowledge", { type: hit.type, id: hit.id });
    }
    setOpen(false);
  };

  const activate = (entry: Entry) => {
    if (entry.kind === "nav") {
      navigate(entry.nav.path);
      setOpen(false);
    } else {
      openHit(entry.hit);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) =>
        e.key === "ArrowDown" ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1),
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (activeRow) activate(activeRow.entry);
    }
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="palette-overlay scrim fixed inset-0 z-[110]" />
        <DialogPrimitive.Content
          onKeyDown={onKeyDown}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            inputRef.current?.focus();
          }}
          // Clicks anywhere in the panel (rows, footer) must not pull focus
          // off the input — it owns the whole keyboard contract.
          onMouseDown={(e) => {
            if (!(e.target as HTMLElement).closest("input")) e.preventDefault();
          }}
          className="palette-panel surface fixed left-1/2 top-1/2 z-[120] flex w-[calc(100%-1.75rem)] max-w-xl flex-col overflow-hidden rounded-2xl"
        >
          <DialogPrimitive.Title className="sr-only">{t("search.title")}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            {t("search.hint")}
          </DialogPrimitive.Description>

          <div className="flex shrink-0 items-center gap-3 px-4">
            <Search className="size-4.5 shrink-0 text-muted-foreground" />
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

          {/* Invisible at rest — only the accent sweep shows while a query is in flight,
              so the previous results never blink out to a spinner. */}
          <div className="relative h-px shrink-0 overflow-hidden">
            {loading && <div className="palette-scan absolute inset-y-0 left-0 w-1/3 bg-accent" />}
          </div>

          {/* Fixed height, not max — a centred panel that resized with its content
              would wander vertically on every keystroke. */}
          <div
            id="palette-list"
            ref={listRef}
            role="listbox"
            aria-label={t("search.title")}
            className="scroll-stable h-[min(13rem,50vh)] min-h-0 overflow-y-auto px-2 pb-2"
          >
            {rows.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center px-4 text-center">
                <p className="text-sm text-foreground">{t("search.noResults", { q: trimmed })}</p>
                <p className="mt-1 text-xs text-muted-foreground">{t("search.noResultsHint")}</p>
              </div>
            ) : (
              sections.map((section) => (
                // Groups a run of role="option" rows inside the role="listbox" above
                // (the ARIA listbox grouping pattern) — <fieldset> is a form control
                // grouping and has no place inside a listbox.
                // biome-ignore lint/a11y/useSemanticElements: ARIA listbox option group, not a form fieldset
                <div key={section.key} role="group" aria-label={section.label}>
                  <div className="sticky top-0 z-10 bg-surface px-2.5 pb-1 pt-2.5">
                    <GroupLabel as="p" size="sm" className="text-muted-foreground/70">
                      {section.label}
                    </GroupLabel>
                  </div>
                  {section.rows.map(({ entry, index }) => (
                    <PaletteRow
                      key={entry.key}
                      entry={entry}
                      index={index}
                      active={index === activeIndex}
                      query={hitQuery}
                      language={i18n.language}
                      onPointerMove={() => index !== activeIndex && setActiveIndex(index)}
                      onSelect={() => activate(entry)}
                    />
                  ))}
                </div>
              ))
            )}
          </div>

          <div className="flex h-9 shrink-0 items-center gap-4 bg-surface-2/50 px-4 text-2xs text-muted-foreground/70">
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
  onPointerMove: () => void;
  onSelect: () => void;
}

function PaletteRow({ entry, index, active, query, language, onPointerMove, onSelect }: RowProps) {
  const hit = entry.kind === "hit" ? entry.hit : null;
  const Icon = entry.kind === "nav" ? entry.nav.icon : GROUP_ICON[entry.hit.type];
  const title = entry.kind === "nav" ? entry.nav.title : entry.hit.title;

  return (
    <button
      type="button"
      id={`palette-row-${index}`}
      role="option"
      aria-selected={active}
      data-index={index}
      // Not a tab stop (the input owns keyboard focus), and pointer *movement*
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
      <IconChip tone={active ? "tint-accent" : "tint-neutral"} className="transition-colors">
        <Icon />
      </IconChip>
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
      {hit?.date && (
        <span className="tabular shrink-0 text-2xs text-muted-foreground/70">
          {dateTimeLabel(hit.date, language)}
        </span>
      )}
    </button>
  );
}
