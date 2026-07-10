import * as React from "react";
import {
  Brain,
  Check,
  ChevronDown,
  ExternalLink,
  File,
  FileCode2,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  Loader2,
  Plus,
  Search,
  SearchX,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
  AccountColor,
  ConnectedAccount,
  LibraryDocument,
  LibraryStatus,
  MemoryEntry,
} from "@trailin/shared";
import { formatFileSize, MEMORY_MAX_LENGTH } from "@trailin/shared";
import { api, type LibrarySearchHit } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorBanner } from "@/components/ui/feedback";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { relativeTime } from "@/lib/dates";
import { takePendingKnowledgeFocus } from "@/lib/paletteFocus";
import { toast } from "@/lib/toast";
import { useServerEvents } from "@/lib/serverEvents";
import { cn, errorMessage, UNASSIGNED_ACCOUNT_COLOR } from "@/lib/utils";

/** Connected accounts whose name looks like an email address — the only ones
 *  relevant to memory scoping (a Notion or Slack connection has no sent mail
 *  to scope facts to). */
const isEmailAccount = (account: ConnectedAccount) => account.name.includes("@");

/**
 * Knowledge: the documents the agent can look up, and the handful of facts it
 * carries around. Documents are the body of the page; memory rides above them
 * as a collapsible strip, because there are usually three of the latter and
 * twenty of the former.
 *
 * Nothing here scrolls on its own — the page flows into the app's single
 * content scroller, like Automations and Settings.
 */

/** How long a search-palette hit stays highlighted before it fades back. */
const HIGHLIGHT_MS = 2400;

/** Cap the cascade so a full page of rows doesn't take a second to finish arriving. */
const stagger = (i: number) => ({ animationDelay: `${Math.min(i, 8) * 45}ms` });

export function KnowledgePanel() {
  // Set by the search palette (see SearchPalette.tsx) when a document/memory hit is opened.
  const [focusMemoryId, setFocusMemoryId] = React.useState<string | null>(null);
  const [focusDocumentId, setFocusDocumentId] = React.useState<string | null>(null);

  // Connected accounts + their colors, feeding the memory scope picker and
  // account filter chips. `null` while the first fetch is in flight; both
  // fetches tolerate failure (memory just falls back to plain ids).
  const [accounts, setAccounts] = React.useState<ConnectedAccount[] | null>(null);
  const [accountColors, setAccountColors] = React.useState<AccountColor[]>([]);

  React.useEffect(() => {
    void Promise.all([
      api.pipedreamAccounts().catch(() => [] as ConnectedAccount[]),
      api.accountColors().catch(() => ({ colors: [] as AccountColor[] })),
    ]).then(([accts, colorRes]) => {
      setAccounts(accts);
      setAccountColors(colorRes.colors);
    });
  }, []);

  const emailAccounts = React.useMemo(
    () => (accounts ?? []).filter(isEmailAccount),
    [accounts],
  );

  // The search palette navigates here, then dispatches this with the hit's
  // id — but only once this effect's listener is attached, which loses the
  // race when Knowledge wasn't already mounted. Catch that case by also
  // reading the same payload stashed just before navigate (lib/paletteFocus.ts).
  React.useEffect(() => {
    const applyFocus = (detail: { type: "document" | "memory"; id: string }) => {
      if (detail.type === "memory") setFocusMemoryId(detail.id);
      else setFocusDocumentId(detail.id);
    };
    const pending = takePendingKnowledgeFocus();
    if (pending) applyFocus(pending);
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<{ type: "document" | "memory"; id: string }>).detail;
      if (!detail) return;
      applyFocus(detail);
      // Already handled live — discard so a later remount doesn't replay it.
      takePendingKnowledgeFocus();
    };
    window.addEventListener("trailin:open-knowledge", onOpen);
    return () => window.removeEventListener("trailin:open-knowledge", onOpen);
  }, []);

  // Let the highlight fade once it has done its job. Clearing it also means
  // re-opening the same hit registers as a change and scrolls to it again.
  React.useEffect(() => {
    if (!focusMemoryId) return;
    const timer = setTimeout(() => setFocusMemoryId(null), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [focusMemoryId]);

  React.useEffect(() => {
    if (!focusDocumentId) return;
    const timer = setTimeout(() => setFocusDocumentId(null), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [focusDocumentId]);

  return (
    <div className="flex flex-col gap-8 pb-4 pt-2">
      <MemoryStrip
        focusId={focusMemoryId}
        accounts={accounts ?? []}
        colors={accountColors}
        emailAccounts={emailAccounts}
      />
      <LibrarySection focusId={focusDocumentId} />
    </div>
  );
}

/* ---------------- Shared ---------------- */

/** Icon tile, title, live count, and a slot for the section's own controls. */
function SectionHead({
  icon: Icon,
  tone,
  title,
  count,
  children,
}: {
  icon: typeof Brain;
  /** Accent for memory, ink for documents — the two tones already paired on Home. */
  tone: string;
  title: string;
  /** `null` while the first fetch is in flight, so the badge doesn't flash a zero. */
  count: number | null;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <span className={cn("grid h-7 w-7 shrink-0 place-items-center rounded-md", tone)}>
        <Icon className="h-4 w-4" />
      </span>
      <h2 className="text-base font-semibold tracking-tight">{title}</h2>
      {count !== null && count > 0 && (
        <Badge variant="muted" className="tabular">
          {count}
        </Badge>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-1">{children}</div>
    </div>
  );
}

/** Leading magnifier, trailing clear — the same shape as the chat history search. */
function SearchField({
  value,
  onChange,
  placeholder,
  className,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className={cn("relative", className)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="pl-9 pr-8"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label={t("common.clearSearch")}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

/** The document grid's own shape — thumbnail, title, meta line. */
const DOC_GRID = "grid grid-cols-2 gap-1.5 sm:grid-cols-4 lg:grid-cols-5";

function TileSkeleton({ tiles }: { tiles: number }) {
  const { t } = useTranslation();
  return (
    <div role="status" aria-label={t("common.loading")} className={DOC_GRID}>
      {Array.from({ length: tiles }, (_, i) => (
        <div key={i} className="flex flex-col gap-2 p-2">
          <Skeleton className="aspect-[4/3] w-full rounded-lg" />
          <Skeleton className="h-3.5 w-2/3" />
          <Skeleton className="h-3 w-1/3" />
        </div>
      ))}
    </div>
  );
}

/* ---------------- Memory ---------------- */

/** Collapse state outlives the route, so memory stays folded away for people who don't use it. */
const MEMORY_OPEN_KEY = "trailin:knowledge:memory-open";

function readMemoryOpen(): boolean {
  try {
    return localStorage.getItem(MEMORY_OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}

/** Below this the search field is chrome — you can see every memory at once. */
const MEMORY_SEARCH_THRESHOLD = 4;

/** Rows shown before the list asks to be expanded, and how many each press adds. */
const MEMORY_INITIAL_VISIBLE = 20;
const MEMORY_VISIBLE_STEP = 40;

/** The three states of the account filter: everything, global-only, or one account. */
type MemoryFilter = "all" | "general" | string;

/** What the composer's own scope picker should default to for a given filter. */
const scopeForFilter = (filter: MemoryFilter) =>
  filter === "all" || filter === "general" ? "" : filter;

function MemoryStrip({
  focusId,
  accounts,
  colors,
  emailAccounts,
}: {
  focusId: string | null;
  /** All connected accounts, for resolving a scoped entry's chip label/color. */
  accounts: ConnectedAccount[];
  colors: AccountColor[];
  /** Email accounts only — the choices offered by the scope picker and filter chips. */
  emailAccounts: ConnectedAccount[];
}) {
  const { t } = useTranslation();
  const [memories, setMemories] = React.useState<MemoryEntry[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [open, setOpen] = React.useState(readMemoryOpen);
  // Whether the single-line composer has expanded into a full MemoryEditor.
  const [composerOpen, setComposerOpen] = React.useState(false);
  const [filter, setFilter] = React.useState<MemoryFilter>("all");
  const [query, setQuery] = React.useState("");
  const [adding, setAdding] = React.useState(false);
  const [visible, setVisible] = React.useState(MEMORY_INITIAL_VISIBLE);
  const listRef = React.useRef<HTMLDivElement>(null);
  // Refocused once the editor collapses back into the single-line composer.
  const composerInputRef = React.useRef<HTMLInputElement>(null);
  // That refocus is programmatic and must not itself reopen the editor via
  // the trigger's onFocus — set right before the one .focus() call below and
  // consumed by the next focus event, whichever it is.
  const suppressComposerOpenRef = React.useRef(false);

  const accountLabel = React.useCallback(
    (accountId: string) => accounts.find((a) => a.id === accountId)?.name ?? accountId,
    [accounts],
  );
  const accountColor = React.useCallback(
    (accountId: string) => colors.find((c) => c.accountId === accountId)?.hex,
    [colors],
  );

  const refresh = React.useCallback(async () => {
    setLoading(true);
    try {
      setMemories(await api.memories());
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  useServerEvents(["memories"], () => {
    void api.memories().then(setMemories).catch(() => {});
  });

  React.useEffect(() => {
    try {
      localStorage.setItem(MEMORY_OPEN_KEY, open ? "1" : "0");
    } catch {
      // private mode: the strip just forgets between visits
    }
  }, [open]);

  // A palette hit can't land on a collapsed strip, behind a text query, or
  // hidden by an active account filter.
  React.useEffect(() => {
    if (!focusId) return;
    setOpen(true);
    setQuery("");
    setFilter("all");
  }, [focusId]);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = memories;
    if (q) {
      list = list.filter(
        (m) =>
          m.content.toLowerCase().includes(q) ||
          (m.accountId !== null && accountLabel(m.accountId).toLowerCase().includes(q)),
      );
    }
    if (filter === "general") list = list.filter((m) => m.accountId === null);
    else if (filter !== "all") list = list.filter((m) => m.accountId === filter);
    return list;
  }, [memories, query, filter, accountLabel]);

  // Reset the cap whenever the visible set changes shape, so a narrower
  // filter or search doesn't leave "show more" sitting past the end.
  React.useEffect(() => {
    setVisible(MEMORY_INITIAL_VISIBLE);
  }, [query, filter]);

  const toggleAccountFilter = (accountId: string) => {
    setFilter((f) => (f === accountId ? "all" : accountId));
  };

  const toggleGeneralFilter = () => {
    setFilter((f) => (f === "general" ? "all" : "general"));
  };

  // Doubles as the dot-column/group-header gate below: both only earn their
  // keep once there's something to slice by — an account already used to
  // scope a memory, or one available to pick.
  const showFilterRow =
    emailAccounts.length > 0 || memories.some((m) => m.accountId !== null);

  // One group per account with a (filtered) entry, alphabetized, then a
  // trailing General group for global entries — mirrors the chip row above,
  // account color first, catch-all last. `null` when there's nothing to slice
  // by, so the list below falls back to one flat run with no headers or dots.
  const groups = React.useMemo(() => {
    if (!showFilterRow) return null;
    const byAccount = new Map<string, MemoryEntry[]>();
    const general: MemoryEntry[] = [];
    for (const entry of filtered) {
      if (entry.accountId === null) {
        general.push(entry);
        continue;
      }
      const list = byAccount.get(entry.accountId);
      if (list) list.push(entry);
      else byAccount.set(entry.accountId, [entry]);
    }
    const accountGroups = [...byAccount.entries()]
      .map(([accountId, entries]) => ({
        key: accountId,
        label: accountLabel(accountId),
        color: accountColor(accountId) ?? UNASSIGNED_ACCOUNT_COLOR,
        general: false as const,
        entries,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
    return general.length > 0
      ? [
          ...accountGroups,
          {
            key: "__general__",
            label: t("knowledge.sections.memory.general"),
            color: undefined,
            general: true as const,
            entries: general,
          },
        ]
      : accountGroups;
  }, [filtered, showFilterRow, accountLabel, accountColor, t]);

  // Same order the groups above render in, flattened — what "visible" counts
  // against, and what a palette hit's position is measured against, so the
  // cap opens exactly as far as grouping actually requires.
  const orderedEntries = React.useMemo(
    () => (groups ? groups.flatMap((g) => g.entries) : filtered),
    [groups, filtered],
  );

  // A palette hit may sit past the fold — reach past it rather than hide it.
  // Measured against the grouped order, not `filtered`'s raw order, so the
  // cap opens exactly as far as the rendered groups actually need.
  React.useEffect(() => {
    if (!focusId) return;
    const index = orderedEntries.findIndex((m) => m.id === focusId);
    if (index >= 0 && index >= visible) setVisible(index + 1);
  }, [focusId, orderedEntries, visible]);

  // `open` is a dependency, not just a guard: opening happens in the effect
  // above, so on the commit where a hit arrives at a collapsed strip the row is
  // still display:none and scrollIntoView is a no-op. Re-run once it unfolds.
  React.useEffect(() => {
    if (!focusId || !open) return;
    listRef.current
      ?.querySelector(`[data-memory-id="${focusId}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusId, orderedEntries, visible, open]);

  const add = async (content: string, accountId: string | null) => {
    setAdding(true);
    try {
      await api.addMemory(content, accountId);
      setComposerOpen(false);
      await refresh();
      suppressComposerOpenRef.current = true;
      composerInputRef.current?.focus();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setAdding(false);
    }
  };

  const shown = orderedEntries.slice(0, visible);
  const remaining = orderedEntries.length - shown.length;

  return (
    <Card as="section" padding="lg" className="flex flex-col gap-4">
      <SectionHead
        icon={Brain}
        tone="tint-accent"
        title={t("knowledge.sections.memory.title")}
        count={loading ? null : memories.length}
      >
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls="knowledge-memory-body"
          aria-label={open ? t("memory.collapse") : t("memory.expand")}
          data-tooltip={open ? t("memory.collapse") : t("memory.expand")}
        >
          <ChevronDown
            className={cn("h-4 w-4 transition-transform duration-200", open && "rotate-180")}
          />
        </Button>
      </SectionHead>

      <div id="knowledge-memory-body" hidden={!open} className="flex flex-col gap-3">
        <p className="max-w-prose text-pretty text-sm text-muted-foreground">
          {t("knowledge.sections.memory.description")}
        </p>

        {/* Top row: search only — scope assignment now lives inside the
            editor card itself, both for the composer and for row edits. */}
        {memories.length > MEMORY_SEARCH_THRESHOLD && (
          <SearchField
            value={query}
            onChange={setQuery}
            placeholder={t("memory.searchPlaceholder")}
          />
        )}

        {/* Filter chips on their own line beneath the search row. */}
        {showFilterRow && (
          <div className="flex flex-wrap items-center gap-1.5">
            <MemoryFilterChip active={filter === "all"} onClick={() => setFilter("all")}>
              {t("knowledge.sections.memory.filterAll")}
            </MemoryFilterChip>
            <MemoryFilterChip active={filter === "general"} onClick={() => setFilter("general")}>
              {t("knowledge.sections.memory.general")}
            </MemoryFilterChip>
            {emailAccounts.map((a) => (
              <MemoryFilterChip
                key={a.id}
                active={filter === a.id}
                // Same grey the row dot and ColorPicker fall back to for an
                // account with no color assigned — never no dot at all.
                color={accountColor(a.id) ?? UNASSIGNED_ACCOUNT_COLOR}
                onClick={() => toggleAccountFilter(a.id)}
                // Group sub-headers carry the full address, so the chip can
                // afford the short local part.
                title={a.name}
              >
                {a.name.split("@")[0]}
              </MemoryFilterChip>
            ))}
          </div>
        )}

        {/* The composer sits right above the list: adding a memory is the whole
            point of the strip. Collapsed it's a single-line trigger; focusing
            it (or the + button) expands it into the full editor card, scope
            preset from the active filter. */}
        {composerOpen ? (
          <MemoryEditor
            initialContent=""
            initialScope={scopeForFilter(filter)}
            emailAccounts={emailAccounts}
            accountColor={accountColor}
            busy={adding}
            onSave={(content, accountId) => void add(content, accountId)}
            onCancel={() => setComposerOpen(false)}
            ariaLabel={t("memory.addPlaceholder")}
            placeholder={t("memory.addPlaceholder")}
          />
        ) : (
          <div className="relative">
            <Input
              ref={composerInputRef}
              value=""
              onFocus={() => {
                if (suppressComposerOpenRef.current) {
                  suppressComposerOpenRef.current = false;
                  return;
                }
                setComposerOpen(true);
              }}
              readOnly
              placeholder={t("memory.addPlaceholder")}
              aria-label={t("memory.addPlaceholder")}
              className="cursor-text pr-10"
            />
            <Button
              size="icon"
              variant="ghost"
              className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2"
              onClick={() => setComposerOpen(true)}
              aria-label={t("memory.add")}
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        )}

        {loading ? (
          <div className="flex flex-col gap-2.5" role="status" aria-label={t("common.loading")}>
            <Skeleton className="h-11 w-full rounded-lg" />
            <Skeleton className="h-11 w-full rounded-lg" />
          </div>
        ) : filtered.length === 0 ? (
          // Nothing saved at all? The composer above already says what to do.
          memories.length > 0 && (
            <p className="py-2 text-sm text-muted-foreground">
              {t("common.noResultsBody", {
                query:
                  query.trim() ||
                  (filter === "general" ? t("knowledge.sections.memory.general") : accountLabel(filter)),
              })}
            </p>
          )
        ) : (
          <div className="flex flex-col gap-3">
            <div ref={listRef} className="flex flex-col gap-3">
              {groups
                ? // Grouped: an account's rows under its own sub-header, sorted by
                  // name, General trailing. The visible cap is spent across groups
                  // in that same order, so a group only appears once it actually
                  // has a row to show.
                  (() => {
                    let consumed = 0;
                    let position = 0;
                    return groups.map((group) => {
                      const budget = visible - consumed;
                      if (budget <= 0) return null;
                      const rows = group.entries.slice(0, budget);
                      if (rows.length === 0) return null;
                      consumed += rows.length;
                      return (
                        <div key={group.key} className="flex flex-col gap-1.5">
                          <p className="flex items-center gap-2 px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
                            <span
                              aria-hidden
                              className={cn(
                                "h-1.5 w-1.5 shrink-0 rounded-full",
                                group.general && "bg-foreground/80",
                              )}
                              style={group.general ? undefined : { backgroundColor: group.color }}
                            />
                            {group.label}
                          </p>
                          <ul className="flex flex-col gap-1.5">
                            {rows.map((entry) => {
                              const i = position++;
                              return (
                                <li key={entry.id} className="animate-in-up" style={stagger(i)}>
                                  <MemoryRow
                                    entry={entry}
                                    onChanged={refresh}
                                    highlighted={entry.id === focusId}
                                    accountLabel={entry.accountId ? accountLabel(entry.accountId) : null}
                                    resolveColor={accountColor}
                                    emailAccounts={emailAccounts}
                                    filterActive={
                                      entry.accountId !== null
                                        ? filter === entry.accountId
                                        : filter === "general"
                                    }
                                    onToggleFilter={
                                      entry.accountId
                                        ? () => toggleAccountFilter(entry.accountId as string)
                                        : toggleGeneralFilter
                                    }
                                    // Same gate as the filter chip row: reserve the dot
                                    // column for every row once any account is in play,
                                    // so global rows' text still lines up with scoped
                                    // rows' text.
                                    showDotColumn={showFilterRow}
                                  />
                                </li>
                              );
                            })}
                          </ul>
                        </div>
                      );
                    });
                  })()
                : // Nothing to group by — the flat list this always was.
                  <ul className="flex flex-col gap-1.5">
                    {shown.map((entry, i) => (
                      <li key={entry.id} className="animate-in-up" style={stagger(i)}>
                        <MemoryRow
                          entry={entry}
                          onChanged={refresh}
                          highlighted={entry.id === focusId}
                          accountLabel={entry.accountId ? accountLabel(entry.accountId) : null}
                          resolveColor={accountColor}
                          emailAccounts={emailAccounts}
                          filterActive={
                            entry.accountId !== null ? filter === entry.accountId : filter === "general"
                          }
                          onToggleFilter={
                            entry.accountId
                              ? () => toggleAccountFilter(entry.accountId as string)
                              : toggleGeneralFilter
                          }
                          // showFilterRow is false here by construction (that's
                          // why `groups` is null) — no dot column at all.
                          showDotColumn={showFilterRow}
                        />
                      </li>
                    ))}
                  </ul>}
            </div>
            {remaining > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="self-start"
                onClick={() => setVisible((v) => v + MEMORY_VISIBLE_STEP)}
              >
                <ChevronDown />
                {t("library.showMore", { count: remaining })}
              </Button>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

/** One filter pill in the memory strip's account/scope row — same shape as the
 *  weekday toggle in Automations, the app's one existing pill-filter pattern.
 *  Doubles as the single-select scope chip inside MemoryEditor. */
function MemoryFilterChip({
  active,
  color,
  general,
  onClick,
  title,
  children,
}: {
  active: boolean;
  /** Account color dot, omitted for "All"/"General" in the filter row. */
  color?: string;
  /** Theme-aware "black" dot for the General scope in MemoryEditor's scope picker. */
  general?: boolean;
  onClick: () => void;
  /** Full account address, shown on hover when the label is the short local part. */
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={title}
      className={cn(
        "flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium transition-colors",
        active
          ? "bg-primary text-primary-foreground"
          : "bg-surface-2 text-muted-foreground hover:text-foreground",
      )}
    >
      {general ? (
        <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-foreground/80" />
      ) : (
        color && (
          <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
        )
      )}
      <span className="max-w-[9rem] truncate">{children}</span>
    </button>
  );
}

/**
 * The one shared editor for adding and editing a memory: an auto-growing
 * textarea plus a footer of scope chips (left) and Cancel/Save (right).
 * Used both by the composer (expanded, empty content) and by a row in edit
 * mode (prefilled) — no more separate blur-commit textarea+Select per row.
 */
function MemoryEditor({
  initialContent,
  initialScope,
  emailAccounts,
  accountColor,
  busy,
  onSave,
  onCancel,
  ariaLabel,
  placeholder,
}: {
  /** "" for a fresh composer. */
  initialContent: string;
  /** "" stands for General/global. */
  initialScope: string;
  emailAccounts: ConnectedAccount[];
  accountColor: (accountId: string) => string | undefined;
  /** True while a save is in flight — disables every control. */
  busy: boolean;
  onSave: (content: string, accountId: string | null) => void;
  onCancel: () => void;
  ariaLabel: string;
  placeholder: string;
}) {
  const { t } = useTranslation();
  const [value, setValue] = React.useState(initialContent);
  const [scope, setScope] = React.useState(initialScope);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  // autoFocus alone doesn't guarantee the caret lands at the end of prefilled
  // content in every browser — place it explicitly, once, on mount.
  React.useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, []);

  const trimmed = value.trim();
  const unchanged = trimmed === initialContent.trim() && scope === initialScope;
  const canSave = trimmed.length > 0 && !unchanged && !busy;

  const save = () => {
    if (!canSave) return;
    onSave(trimmed, scope ? scope : null);
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg bg-surface-2 p-3 focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-surface">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            save();
          }
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        disabled={busy}
        maxLength={MEMORY_MAX_LENGTH}
        aria-label={ariaLabel}
        placeholder={placeholder}
        rows={Math.max(2, value.split("\n").length)}
        className="w-full resize-none bg-transparent text-sm leading-relaxed text-foreground placeholder:text-muted-foreground focus:outline-none disabled:opacity-50"
      />
      <div className="flex flex-wrap items-center gap-2">
        <div
          role="group"
          aria-label={t("knowledge.sections.memory.scopeLabel")}
          aria-disabled={busy}
          className={cn(
            "flex min-w-0 flex-1 flex-wrap items-center gap-1.5",
            busy && "pointer-events-none opacity-60",
          )}
        >
          <MemoryFilterChip active={scope === ""} general onClick={() => setScope("")}>
            {t("knowledge.sections.memory.general")}
          </MemoryFilterChip>
          {emailAccounts.map((a) => (
            <MemoryFilterChip
              key={a.id}
              active={scope === a.id}
              color={accountColor(a.id) ?? UNASSIGNED_ACCOUNT_COLOR}
              onClick={() => setScope(a.id)}
              title={a.name}
            >
              {a.name.split("@")[0]}
            </MemoryFilterChip>
          ))}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {value.length >= 240 && (
            <span
              className={cn(
                "tabular-nums text-[11px]",
                value.length >= MEMORY_MAX_LENGTH ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {value.length}/{MEMORY_MAX_LENGTH}
            </span>
          )}
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button size="sm" onClick={save} disabled={!canSave}>
            {busy && <Loader2 className="animate-spin" />}
            {t("memory.save")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function MemoryRow({
  entry,
  onChanged,
  highlighted,
  accountLabel,
  resolveColor,
  emailAccounts,
  filterActive,
  onToggleFilter,
  showDotColumn,
}: {
  entry: MemoryEntry;
  onChanged: () => Promise<void>;
  /** True when opened via the search palette — draws attention with a soft accent fill. */
  highlighted?: boolean;
  /** Precomputed display name for `entry.accountId`, or null for a global entry. */
  accountLabel: string | null;
  /** Resolves any account's dot color (falls back to grey) — feeds both this
   *  row's own dot and the edit card's per-account scope chips. */
  resolveColor: (accountId: string) => string | undefined;
  /** Choices for the edit card's scope chips: one per email account (plus General, always offered). */
  emailAccounts: ConnectedAccount[];
  /** True when this row's account (or, for a global row, "general") is the strip's active filter. */
  filterActive?: boolean;
  /** Toggles the strip's filter to this row's account, or to "general" for a global entry. */
  onToggleFilter?: () => void;
  /** True once any row on the strip is scoped (or an account could be) — draws
   *  a dot on every row (colored for an account, black for General) so the
   *  filterable ones are told apart from a strip with nothing to filter by. */
  showDotColumn: boolean;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);

  const save = async (content: string, accountId: string | null) => {
    setSaving(true);
    try {
      await api.updateMemory(entry.id, content, accountId);
      setEditing(false);
      await onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setDeleting(true);
    try {
      await api.deleteMemory(entry.id);
      await onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
      setDeleting(false);
    } finally {
      setConfirmOpen(false);
    }
  };

  return (
    // No per-row icon tile: the same Brain glyph twenty times over says
    // nothing the section head hasn't already said. This wrapper carries no
    // styling of its own — the editor card and the display row each draw
    // their own background, so the two never nest.
    <div data-memory-id={entry.id}>
      {editing ? (
        <MemoryEditor
          initialContent={entry.content}
          initialScope={entry.accountId ?? ""}
          emailAccounts={emailAccounts}
          accountColor={resolveColor}
          busy={saving}
          onSave={(content, accountId) => void save(content, accountId)}
          onCancel={() => setEditing(false)}
          ariaLabel={t("memory.edit")}
          placeholder={t("memory.addPlaceholder")}
        />
      ) : (
        <div
          className={cn(
            // Recessed grey item inside the white card — one step down, never a nested card.
            "group flex items-center gap-3 rounded-lg bg-surface-2 px-3 py-2.5 transition-colors hover:bg-secondary",
            highlighted && "bg-accent/10",
          )}
        >
          {accountLabel !== null ? (
            // The dot is the row's only account tell now — no more name pill —
            // and doubles as the filter chip's click target: same toggle as
            // the account's chip above.
            <button
              type="button"
              onClick={onToggleFilter}
              aria-pressed={filterActive}
              aria-label={t("knowledge.sections.memory.filterAccountHint", { name: accountLabel })}
              data-tooltip={t("knowledge.sections.memory.filterAccountHint", { name: accountLabel })}
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: (entry.accountId && resolveColor(entry.accountId)) ?? UNASSIGNED_ACCOUNT_COLOR }}
            />
          ) : (
            // Global entry, but others on the strip are scoped — give it a real
            // (theme-aware "black") dot rather than a blank placeholder, and let
            // it toggle the General filter same as an account dot toggles its own.
            showDotColumn && (
              <button
                type="button"
                onClick={onToggleFilter}
                aria-pressed={filterActive}
                aria-label={t("knowledge.sections.memory.general")}
                data-tooltip={t("knowledge.sections.memory.general")}
                className="h-2.5 w-2.5 shrink-0 rounded-full bg-foreground/80"
              />
            )
          )}
          <div
            role="button"
            tabIndex={0}
            onClick={() => setEditing(true)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setEditing(true);
              }
            }}
            data-tooltip={t("memory.edit")}
            className="min-w-0 flex-1 cursor-text truncate rounded-md text-sm leading-relaxed text-foreground/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-2"
          >
            {entry.content}
          </div>
          {/* Quick path that skips the edit card entirely — harmless next to
              the edit card's own delete button, since only one is ever on
              screen for a given row at a time. */}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setConfirmOpen(true)}
            aria-label={t("memory.delete")}
            className="h-8 w-8 shrink-0 hover:bg-destructive/10 hover:text-destructive sm:opacity-0 sm:transition-opacity sm:focus-visible:opacity-100 sm:group-hover:opacity-100"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t("memory.delete")}
        description={t("memory.deleteConfirm")}
        confirmLabel={t("memory.delete")}
        variant="destructive"
        busy={deleting}
        onConfirm={() => void remove()}
      />
    </div>
  );
}

/* ---------------- Library ---------------- */

/** Rows shown before the list asks to be expanded, and how many each press adds. */
const INITIAL_VISIBLE = 12;
const VISIBLE_STEP = 24;

/** A search field is chrome until there's enough here to lose track of. */
const SEARCH_THRESHOLD = 8;

function LibrarySection({ focusId }: { focusId: string | null }) {
  const { t } = useTranslation();
  const [status, setStatus] = React.useState<LibraryStatus | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const [dragging, setDragging] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [visible, setVisible] = React.useState(INITIAL_VISIBLE);
  const [docToDelete, setDocToDelete] = React.useState<LibraryDocument | null>(null);
  const [deleting, setDeleting] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const listRef = React.useRef<HTMLUListElement>(null);
  // dragenter/dragleave fire for every child element, so count depth rather
  // than toggling — otherwise the overlay flickers as the pointer crosses rows.
  const dragDepth = React.useRef(0);

  const refresh = React.useCallback(async () => {
    try {
      setStatus(await api.library());
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  React.useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  useServerEvents(["library"], () => void refresh());

  // Content search (FTS) runs alongside the client-side title filter below —
  // debounced, and stale responses (query changed since the request went
  // out) are dropped. Previous hits stay on screen while a fetch is in
  // flight, so there's no spinner flash.
  const [contentHits, setContentHits] = React.useState<LibrarySearchHit[]>([]);
  const lastSearchedRef = React.useRef("");

  React.useEffect(() => {
    const trimmed = query.trim();
    // Set synchronously, not just inside the timeout below: this is also what
    // invalidates a still-in-flight older request the instant the query moves
    // on, whether it moves on to a new query or back to empty.
    lastSearchedRef.current = trimmed;
    if (!trimmed) {
      setContentHits([]);
      return;
    }
    const timer = setTimeout(() => {
      api
        .searchLibrary(trimmed)
        .then((res) => {
          if (lastSearchedRef.current === trimmed) setContentHits(res.results);
        })
        .catch(() => {
          // content search is a bonus signal — title filtering still works
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  const snippetByDocId = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const hit of contentHits) map.set(hit.id, hit.snippet);
    return map;
  }, [contentHits]);

  const upload = async (fileList: FileList | null) => {
    const files = fileList ? Array.from(fileList) : [];
    if (files.length === 0 || uploading) return;
    setUploading(true);
    let last: LibraryStatus | null = null;
    let added = 0;
    for (const file of files) {
      try {
        last = await api.uploadLibraryFile(file);
        added += 1;
      } catch (err) {
        toast.error(errorMessage(err));
      }
    }
    if (last) setStatus(last);
    if (added > 0) toast.success(t("library.uploaded", { count: added }));
    setUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const confirmRemove = async () => {
    if (!docToDelete) return;
    setDeleting(true);
    try {
      setStatus(await api.deleteLibraryDocument(docToDelete.id));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setDeleting(false);
      setDocToDelete(null);
    }
  };

  const documents = React.useMemo(() => {
    if (!status) return [];
    const q = query.trim().toLowerCase();
    // No query: most recently touched first, which is what you came back for.
    if (!q) {
      return [...status.documents].sort(
        (a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime(),
      );
    }
    // With one: relevance order. Title hits first, then documents whose
    // *contents* matched — the extension is searchable too, so "pdf" still
    // narrows the list now that the type chips are gone.
    const titleMatches = status.documents.filter(
      (doc) => doc.title.toLowerCase().includes(q) || doc.ext.toLowerCase().includes(q),
    );
    if (snippetByDocId.size === 0) return titleMatches;
    const matched = new Set(titleMatches.map((doc) => doc.id));
    const contentMatches = status.documents.filter(
      (doc) => !matched.has(doc.id) && snippetByDocId.has(doc.id),
    );
    return [...titleMatches, ...contentMatches];
  }, [status, query, snippetByDocId]);

  React.useEffect(() => {
    setVisible(INITIAL_VISIBLE);
  }, [query]);

  // Opened from the search palette: a live query might be hiding it, and it may
  // sit past the fold. Clear the one, reach past the other.
  React.useEffect(() => {
    if (!focusId || !status) return;
    const doc = status.documents.find((d) => d.id === focusId);
    if (!doc) return;
    const q = query.trim().toLowerCase();
    if (q && !doc.title.toLowerCase().includes(q) && !snippetByDocId.has(doc.id)) setQuery("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, status]);

  React.useEffect(() => {
    if (!focusId) return;
    const index = documents.findIndex((d) => d.id === focusId);
    if (index >= 0 && index >= visible) setVisible(index + 1);
  }, [focusId, documents, visible]);

  React.useEffect(() => {
    if (!focusId) return;
    listRef.current
      ?.querySelector(`[data-doc-id="${focusId}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusId, documents, visible]);

  const dragHasFiles = (e: React.DragEvent) => e.dataTransfer.types.includes("Files");

  if (!status) {
    return loadError ? (
      <section className="flex flex-col items-start gap-2">
        <ErrorBanner>{loadError}</ErrorBanner>
        <Button variant="ghost" size="sm" onClick={() => void refresh()}>
          {t("common.retry")}
        </Button>
      </section>
    ) : (
      <Card as="section" padding="lg" className="flex flex-col gap-5">
        <Skeleton className="h-7 w-44" />
        <Skeleton className="h-4 w-3/4" />
        <TileSkeleton tiles={10} />
      </Card>
    );
  }

  const empty = status.documents.length === 0;
  const shown = documents.slice(0, visible);
  const remaining = documents.length - shown.length;

  return (
    <Card
      as="section"
      padding="lg"
      className="relative flex flex-col gap-5"
      onDragEnter={(e) => {
        if (!dragHasFiles(e)) return;
        e.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(e) => {
        if (!dragHasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(e) => {
        if (!dragHasFiles(e)) return;
        dragDepth.current -= 1;
        if (dragDepth.current <= 0) {
          dragDepth.current = 0;
          setDragging(false);
        }
      }}
      onDrop={(e) => {
        if (!dragHasFiles(e)) return;
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        void upload(e.dataTransfer.files);
      }}
    >
      {dragging && (
        <div className="tint-accent pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-lg">
          <div className="flex flex-col items-center gap-2">
            <Upload className="h-6 w-6" />
            <p className="text-sm font-medium">{t("library.dropTitle")}</p>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-4">
        <SectionHead
          icon={FolderOpen}
          tone="bg-primary/10 text-primary"
          title={t("knowledge.sections.library.title")}
          count={status.documents.length}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".pdf,.md,.markdown,.txt,.docx,.csv,.html,.htm"
            className="hidden"
            onChange={(e) => void upload(e.target.files)}
          />
          <Button size="sm" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
            {uploading ? <Loader2 className="animate-spin" /> : <Upload />}
            {uploading ? t("library.uploading") : t("library.upload")}
          </Button>
        </SectionHead>

        <p className="max-w-prose text-pretty text-sm text-muted-foreground">
          {t("knowledge.sections.library.description")}
        </p>

        <LibraryFolderControl folder={status.folder} onStatus={setStatus} />
      </div>

      {status.documents.length >= SEARCH_THRESHOLD && (
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder={t("library.searchPlaceholder")}
        />
      )}

      {empty ? (
        <EmptyState
          icon={FolderOpen}
          title={t("library.emptyTitle")}
          description={t("library.emptyBody")}
          action={
            <Button size="sm" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
              <Upload />
              {t("library.upload")}
            </Button>
          }
        />
      ) : documents.length === 0 ? (
        <EmptyState
          icon={SearchX}
          title={t("common.noResults")}
          description={t("common.noResultsBody", { query })}
          action={
            <Button variant="outline" size="sm" onClick={() => setQuery("")}>
              {t("common.clearSearch")}
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col gap-3">
          <ul ref={listRef} className={DOC_GRID}>
            {shown.map((doc, i) => (
              <li key={doc.id} className="animate-in-up" style={stagger(i)}>
                <DocumentTile
                  doc={doc}
                  snippet={snippetByDocId.get(doc.id)}
                  onDelete={() => setDocToDelete(doc)}
                  highlighted={doc.id === focusId}
                />
              </li>
            ))}
          </ul>
          {remaining > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="self-start"
              onClick={() => setVisible((v) => v + VISIBLE_STEP)}
            >
              <ChevronDown />
              {t("library.showMore", { count: remaining })}
            </Button>
          )}
        </div>
      )}

      <ConfirmDialog
        open={!!docToDelete}
        onOpenChange={(open) => !open && setDocToDelete(null)}
        title={t("library.delete")}
        description={docToDelete ? t("library.deleteConfirm", { title: docToDelete.title }) : ""}
        confirmLabel={t("library.delete")}
        variant="destructive"
        busy={deleting}
        onConfirm={() => void confirmRemove()}
      />
    </Card>
  );
}

function LibraryFolderControl({
  folder,
  onStatus,
}: {
  folder: string;
  onStatus: (status: LibraryStatus) => void;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = React.useState<"display" | "edit">("display");
  const [draft, setDraft] = React.useState(folder);
  const [state, setState] = React.useState<"idle" | "saving" | "saved">("idle");
  const [picking, setPicking] = React.useState(false);
  const busy = React.useRef(false);

  React.useEffect(() => setDraft(folder), [folder]);

  const startEdit = () => {
    setDraft(folder);
    setState("idle");
    setMode("edit");
  };

  const pick = async () => {
    if (busy.current) return;
    busy.current = true;
    setPicking(true);
    try {
      const next = await api.pickLibraryFolder();
      if ("canceled" in next) return;
      onStatus(next);
      setDraft(next.folder);
      setState("saved");
      setTimeout(() => setState("idle"), 500);
    } catch (err) {
      toast.error(errorMessage(err));
      startEdit();
    } finally {
      setPicking(false);
      busy.current = false;
    }
  };

  const revert = () => {
    setDraft(folder);
    setState("idle");
    setMode("display");
  };

  const commit = async () => {
    if (busy.current) return;
    const trimmed = draft.trim();
    if (!trimmed || trimmed === folder) {
      revert();
      return;
    }
    busy.current = true;
    setState("saving");
    try {
      const next = await api.setLibraryFolder(trimmed);
      onStatus(next);
      setDraft(next.folder);
      setState("saved");
      setTimeout(() => {
        setMode("display");
        setState("idle");
      }, 500);
    } catch (err) {
      toast.error(errorMessage(err));
      setState("idle");
    } finally {
      busy.current = false;
    }
  };

  const statusNote =
    state === "saving" ? (
      <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("common.saving")}
      </span>
    ) : state === "saved" ? (
      <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
        <Check className="h-3.5 w-3.5 text-success" /> {t("common.saved")}
      </span>
    ) : null;

  if (mode === "edit") {
    return (
      <div className="flex items-center gap-2">
        <Input
          autoFocus
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setState((s) => (s === "saving" ? s : "idle"));
          }}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void commit();
            }
            if (e.key === "Escape") {
              e.preventDefault();
              revert();
            }
          }}
          aria-label={t("library.folderLabel")}
          className="font-mono text-xs"
          disabled={state === "saving"}
        />
        {statusNote}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {/* dir="rtl" truncates from the left, keeping the meaningful tail of the path visible. */}
      <button
        type="button"
        dir="rtl"
        onClick={startEdit}
        disabled={picking}
        aria-label={`${t("library.editPath")}: ${folder}`}
        data-tooltip={folder}
        className="min-w-0 flex-1 cursor-text truncate rounded-md text-left font-mono text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        {folder}
      </button>
      {statusNote}
      <Button
        variant="ghost"
        size="sm"
        className="shrink-0"
        onClick={() => void pick()}
        disabled={picking}
      >
        {picking && <Loader2 className="animate-spin" />}
        {t("library.changeFolder")}
      </Button>
    </div>
  );
}

/**
 * Shape carries the file type; color is reserved for status. index.css calls the
 * `tint-*` fills "status tints", and an extension is not a status — so a PDF
 * gets a page glyph rather than a red one, and only a failed extraction earns a
 * colored tile.
 */
function fileTypeIcon(ext: string): typeof File {
  switch (ext.toLowerCase()) {
    case "pdf":
    case "docx":
    case "txt":
      return FileText;
    case "md":
    case "markdown":
    case "html":
    case "htm":
      return FileCode2;
    case "csv":
      return FileSpreadsheet;
    default:
      return File;
  }
}

/** Formats that mean the same thing should wear the same colour. */
const EXT_ALIAS: Record<string, string> = { markdown: "md", htm: "html" };

/**
 * The formats the library indexes get the hues people already expect — red PDF,
 * green spreadsheet, blue document. Everything else derives a hue from its own
 * characters, so an unknown extension picks a colour once and keeps it forever
 * without anyone maintaining a table.
 */
const EXT_HUE: Record<string, number> = {
  pdf: 27,
  html: 70,
  csv: 155,
  txt: 195,
  docx: 250,
  md: 315,
};

function extHue(ext: string): number {
  const key = EXT_ALIAS[ext.toLowerCase()] ?? ext.toLowerCase();
  const known = EXT_HUE[key];
  if (known !== undefined) return known;
  // djb2, snapped to 24 steps so no two formats land a few degrees apart.
  let hash = 5381;
  for (let i = 0; i < key.length; i++) hash = (hash * 33 + key.charCodeAt(i)) >>> 0;
  return (hash % 24) * 15;
}

/** Feeds `.tint-file` (index.css) the one value it needs. */
const hueStyle = (ext: string) =>
  ({ "--filetype-h": String(extHue(ext)) }) as React.CSSProperties;

/**
 * A folder-style tile: colour block on top, name and metadata beneath. No fill
 * at rest — the thumbnail carries the weight, and the tile only takes a fill
 * under the cursor, so a wall of these reads as files rather than as cards.
 */
function DocumentTile({
  doc,
  snippet,
  onDelete,
  highlighted,
}: {
  doc: LibraryDocument;
  snippet?: string;
  onDelete: () => void;
  /** True when opened via the search palette — draws attention with a soft accent fill. */
  highlighted?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const Icon = fileTypeIcon(doc.ext);
  const failed = doc.status === "error";
  const canOpen = !failed;

  return (
    <div
      data-doc-id={doc.id}
      className={cn(
        "group relative flex flex-col rounded-lg p-1.5 transition-colors hover:bg-surface-2",
        highlighted && "bg-accent/10",
      )}
    >
      <button
        type="button"
        className={cn(
          "flex min-w-0 flex-col gap-1.5 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface",
          canOpen ? "cursor-pointer" : "cursor-default",
        )}
        onClick={() => canOpen && api.openLibraryDocument(doc.id)}
        // Not aria-label: that would replace the title as the accessible name.
        data-tooltip={canOpen ? t("library.openDocument") : undefined}
      >
        <span
          className={cn(
            "grid aspect-[4/3] w-full place-items-center rounded-md transition-transform",
            failed ? "tint-danger" : "tint-file",
            canOpen && "group-hover:scale-[1.02]",
          )}
          style={failed ? undefined : hueStyle(doc.ext)}
        >
          <Icon className="h-6 w-6" />
        </span>

        <span className="flex min-w-0 flex-col gap-0.5 px-0.5 pb-0.5">
          <span
            className={cn(
              "truncate text-[13px] font-medium leading-snug",
              canOpen && "group-hover:text-accent",
            )}
          >
            {doc.title}
          </span>

          {failed ? (
            // The tile has no room for the reason — keep it a hover away.
            <Badge
              variant="destructive"
              className="h-4 self-start px-1 py-0 text-[10px]"
              data-tooltip={doc.error ?? undefined}
            >
              {t("library.error")}
            </Badge>
          ) : (
            <span className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
              <span
                className="tint-file shrink-0 rounded px-1 py-0.5 font-mono text-[9px] uppercase leading-none"
                style={hueStyle(doc.ext)}
              >
                {doc.ext}
              </span>
              <time
                dateTime={doc.modifiedAt}
                className="min-w-0 truncate"
                data-tooltip={`${new Date(doc.modifiedAt).toLocaleString(i18n.language)} · ${formatFileSize(doc.size)} · ${t("library.sectionCount", { count: doc.chunkCount })}`}
              >
                {relativeTime(doc.modifiedAt, i18n.language)}
              </time>
            </span>
          )}

          {snippet && !failed && (
            <span className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-muted-foreground/70">
              {snippet}
            </span>
          )}
        </span>
      </button>

      {/* Float over the thumbnail's corner rather than stealing a column of the tile. */}
      <div className="absolute right-2 top-2 flex items-center gap-1 sm:opacity-0 sm:transition-opacity sm:focus-within:opacity-100 sm:group-hover:opacity-100">
        {canOpen && (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => api.openLibraryDocument(doc.id)}
            aria-label={t("library.openDocument")}
            className="h-6 w-6 bg-surface shadow-sm hover:text-foreground"
          >
            <ExternalLink className="h-3 w-3" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          onClick={onDelete}
          aria-label={t("library.delete")}
          className="h-6 w-6 bg-surface shadow-sm hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}
