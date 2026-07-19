import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AccountColor, ConnectedAccount, MemoryEntry } from "@trailin/shared";
import { MEMORY_MAX_COUNT } from "@trailin/shared";
import { Brain, ChevronDown, Plus } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DisclosureToggle, ShowMoreButton } from "@/components/ui/disclosure-toggle";
import { Notice } from "@/components/ui/feedback";
import { Input } from "@/components/ui/input";
import { SearchField } from "@/components/ui/search-field";
import { SectionTitle } from "@/components/ui/section-header";
import { Skeleton } from "@/components/ui/skeleton";
import { accountColor, accountName } from "@/lib/accounts";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { usePagedVisible } from "@/lib/usePagedVisible";
import { cn, stagger } from "@/lib/utils";
import { LearnActivity } from "./LearnActivity";
import { MemoryEditor, MemoryRow, ScopeDot, type ScopeKind } from "./MemoryEntry";

/** Collapse state outlives the route, so memory stays folded away for people who don't use it. */
const MEMORY_OPEN_KEY = "trailin:knowledge:memory-open";

/** Which scope groups are unfolded — the strip's default view is just the group header lines. */
const MEMORY_GROUPS_OPEN_KEY = "trailin:knowledge:memory-open-groups";

function readMemoryOpen(): boolean {
  try {
    return localStorage.getItem(MEMORY_OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}

function readOpenGroups(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(MEMORY_GROUPS_OPEN_KEY) ?? "[]");
    return new Set(
      Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : [],
    );
  } catch {
    return new Set();
  }
}

/** Below this the search field is chrome — you can see every memory at once. */
const MEMORY_SEARCH_THRESHOLD = 4;

/** Rows shown before the list asks to be expanded, and how many each press adds. */
const MEMORY_INITIAL_VISIBLE = 20;
const MEMORY_VISIBLE_STEP = 40;

/** At 90% of the hard cap the strip starts nudging the user to prune rarely-used entries. */
const MEMORY_NEAR_CAP = Math.floor(MEMORY_MAX_COUNT * 0.9);
/** The rarely-used example named in the prune notice is truncated to keep the banner one line. */
const PRUNE_EXAMPLE_MAX = 48;

/** One scope group: a collapsible header (unless the list is flat) and its entries. */
type MemoryGroup = {
  key: string;
  /** Header text; null for the single label-less run when there's nothing to slice by. */
  label: string | null;
  /** The account group's dot color; General/Contacts dots are fixed tones. */
  color: string | undefined;
  kind: ScopeKind;
  entries: MemoryEntry[];
};

/** The group a given entry files under — must mirror how groups are bucketed below. */
const groupKeyOf = (entry: MemoryEntry): string =>
  entry.accountId !== null
    ? `account:${entry.accountId}`
    : entry.contactId !== null
      ? "__contacts__"
      : "__general__";

export function MemoryStrip({
  focusId,
  accounts,
  colors,
  emailAccounts,
}: {
  focusId: string | null;
  /** All connected accounts, for resolving a scoped entry's group label/color. */
  accounts: ConnectedAccount[];
  colors: AccountColor[];
  /** Email accounts only — the choices offered by the editor's scope picker. */
  emailAccounts: ConnectedAccount[];
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  // "memories" topic invalidation refetches without blanking the list under
  // the reader — refetches keep the previous data.
  const memoriesQuery = useQuery({ queryKey: ["memories"], queryFn: () => api.memories() });
  const memories = memoriesQuery.data ?? [];
  const loading = memoriesQuery.isPending;
  React.useEffect(() => {
    if (memoriesQuery.error) toast.error(memoriesQuery.error);
  }, [memoriesQuery.error]);
  const [open, setOpen] = React.useState(readMemoryOpen);
  // Whether the single-line composer has expanded into a full MemoryEditor.
  const [composerOpen, setComposerOpen] = React.useState(false);
  const [openGroups, setOpenGroups] = React.useState<Set<string>>(readOpenGroups);
  const [query, setQuery] = React.useState("");
  const [adding, setAdding] = React.useState(false);
  const { visible, showMore, revealIndex } = usePagedVisible(
    MEMORY_INITIAL_VISIBLE,
    MEMORY_VISIBLE_STEP,
    query,
  );
  const listRef = React.useRef<HTMLDivElement>(null);
  // Refocused once the editor collapses back into the single-line composer.
  const composerInputRef = React.useRef<HTMLInputElement>(null);
  // That refocus is programmatic and must not itself reopen the editor via
  // the trigger's onFocus — set right before the one .focus() call below and
  // consumed by the next focus event, whichever it is.
  const suppressComposerOpenRef = React.useRef(false);

  const accountLabel = React.useCallback(
    (accountId: string) => accountName(accounts, accountId),
    [accounts],
  );
  const accountColorOf = React.useCallback(
    (accountId: string) => accountColor(colors, accountId),
    [colors],
  );
  // Contact memories are keyed by the normalized address itself.
  const contactLabel = React.useCallback((address: string) => address, []);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["memories"] });

  React.useEffect(() => {
    try {
      localStorage.setItem(MEMORY_OPEN_KEY, open ? "1" : "0");
    } catch {
      // private mode: the strip just forgets between visits
    }
  }, [open]);

  React.useEffect(() => {
    try {
      localStorage.setItem(MEMORY_GROUPS_OPEN_KEY, JSON.stringify([...openGroups]));
    } catch {
      // private mode: the strip just forgets between visits
    }
  }, [openGroups]);

  // A palette hit can't land on a collapsed strip, behind a text query, or
  // inside a folded group.
  React.useEffect(() => {
    if (!focusId) return;
    setOpen(true);
    setQuery("");
    const hit = memories.find((m) => m.id === focusId);
    if (hit) setOpenGroups((prev) => new Set(prev).add(groupKeyOf(hit)));
  }, [focusId, memories]);

  const searching = query.trim().length > 0;

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return memories;
    return memories.filter(
      (m) =>
        m.content.toLowerCase().includes(q) ||
        (m.accountId !== null && accountLabel(m.accountId).toLowerCase().includes(q)) ||
        (m.contactId !== null &&
          (m.contactId.includes(q) || contactLabel(m.contactId).toLowerCase().includes(q))),
    );
  }, [memories, query, accountLabel, contactLabel]);

  // One group per account with a (filtered) entry, alphabetized; then a
  // single Contacts group (rows carry the person's name — never a group per
  // correspondent, which would scale with the contacts directory); then a
  // trailing General group for fully global entries. With only one bucket in
  // play the list renders flat — a lone collapsible header would just be a
  // click in the way.
  const groups = React.useMemo<MemoryGroup[]>(() => {
    const byAccount = new Map<string, MemoryEntry[]>();
    const contactEntries: MemoryEntry[] = [];
    const general: MemoryEntry[] = [];
    for (const entry of filtered) {
      if (entry.accountId !== null) {
        const list = byAccount.get(entry.accountId);
        if (list) list.push(entry);
        else byAccount.set(entry.accountId, [entry]);
        continue;
      }
      if (entry.contactId !== null) {
        contactEntries.push(entry);
        continue;
      }
      general.push(entry);
    }
    const built: MemoryGroup[] = [...byAccount.entries()]
      .map(([accountId, entries]) => ({
        key: `account:${accountId}`,
        label: accountLabel(accountId),
        color: accountColorOf(accountId),
        kind: "account" as const,
        entries,
      }))
      .sort((a, b) => (a.label ?? "").localeCompare(b.label ?? ""));
    if (contactEntries.length > 0) {
      built.push({
        key: "__contacts__",
        label: t("knowledge.sections.memory.contacts"),
        color: undefined,
        kind: "contact",
        // Same person's facts read together, alphabetized by their label.
        entries: contactEntries.sort((a, b) =>
          contactLabel(a.contactId as string).localeCompare(contactLabel(b.contactId as string)),
        ),
      });
    }
    if (general.length > 0) {
      built.push({
        key: "__general__",
        label: t("knowledge.sections.memory.general"),
        color: undefined,
        kind: "general",
        entries: general,
      });
    }
    if (built.length === 1) {
      const only = built[0] as MemoryGroup;
      return [{ ...only, label: null }];
    }
    return built;
  }, [filtered, accountLabel, accountColorOf, contactLabel, t]);

  const toggleGroup = (key: string) =>
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // A flat list is always unfolded, and a search unfolds every matching group
  // — a hit hidden behind a folded header would read as "no results".
  const isGroupOpen = (group: MemoryGroup): boolean =>
    group.label === null || searching || openGroups.has(group.key);

  // The visible cap is spent across unfolded groups in render order; folded
  // groups still show their header line but contribute no rows. `start` keeps
  // the entrance stagger continuous across group boundaries.
  const shownGroups: { group: MemoryGroup; rows: MemoryEntry[]; start: number; open: boolean }[] =
    [];
  let consumed = 0;
  for (const group of groups) {
    const groupOpen = isGroupOpen(group);
    const rows = groupOpen ? group.entries.slice(0, Math.max(0, visible - consumed)) : [];
    shownGroups.push({ group, rows, start: consumed, open: groupOpen });
    consumed += rows.length;
  }

  // What the cap and a palette hit's position are measured against: the
  // unfolded groups' entries, in render order. Repeats the isGroupOpen
  // predicate inline so the memo depends on plain state, not a per-render
  // function identity.
  const orderedEntries = React.useMemo(
    () =>
      groups
        .filter((g) => g.label === null || searching || openGroups.has(g.key))
        .flatMap((g) => g.entries),
    [groups, openGroups, searching],
  );
  const remaining = orderedEntries.length - consumed;

  // A palette hit may sit past the fold — reach past it rather than hide it.
  React.useEffect(() => {
    if (!focusId) return;
    revealIndex(orderedEntries.findIndex((m) => m.id === focusId));
  }, [focusId, orderedEntries, revealIndex]);

  // `open` is a dependency, not just a guard: opening happens in the effect
  // above, so on the commit where a hit arrives at a collapsed strip the row is
  // still display:none and scrollIntoView is a no-op. Re-run once it unfolds.
  // orderedEntries/visible are likewise re-run triggers, not read here: the
  // effect above can expand `visible` on a later commit, and the target row
  // only exists in the DOM once that happens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: orderedEntries/visible re-trigger the scroll once the row mounts, not read in the body
  React.useEffect(() => {
    if (!focusId || !open) return;
    listRef.current
      ?.querySelector(`[data-memory-id="${focusId}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusId, orderedEntries, visible, open]);

  const add = async (content: string, accountId: string | null, contactId: string | null) => {
    setAdding(true);
    try {
      await api.addMemory(content, accountId, contactId);
      setComposerOpen(false);
      await refresh();
      suppressComposerOpenRef.current = true;
      composerInputRef.current?.focus();
    } catch (err) {
      toast.error(err);
    } finally {
      setAdding(false);
    }
  };

  // Nearing the hard cap, point at the entry the agent leans on least (lowest
  // use count, oldest last-use as the tiebreak) as a concrete prune candidate.
  const leastUsed = React.useMemo(() => {
    if (memories.length < MEMORY_NEAR_CAP) return null;
    return [...memories].sort(
      (a, b) =>
        a.usedCount - b.usedCount ||
        (a.lastUsedAt ?? a.createdAt).localeCompare(b.lastUsedAt ?? b.createdAt),
    )[0];
  }, [memories]);

  return (
    <Card as="section" padding="lg" className="flex flex-col gap-4">
      <SectionTitle
        icon={Brain}
        tone="tint-accent"
        title={t("knowledge.sections.memory.title")}
        count={loading ? null : memories.length}
        // Folded away with the rest of the body below, not the header row it
        // renders alongside — omit rather than let it show through collapsed.
        description={open ? t("knowledge.sections.memory.description") : undefined}
      >
        <Button
          variant="ghost"
          size="icon-sm"
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
      </SectionTitle>

      <div id="knowledge-memory-body" hidden={!open} className="flex flex-col gap-3">
        {/* Nearing the cap, nudge toward pruning and name the least-used entry
            as a candidate — the per-row use counts below make the rest visible. */}
        {leastUsed && (
          <Notice tone="warning">
            {t("memory.nearCap", { count: memories.length, max: MEMORY_MAX_COUNT })}{" "}
            {t("memory.pruneHint", {
              example:
                leastUsed.content.length > PRUNE_EXAMPLE_MAX
                  ? `${leastUsed.content.slice(0, PRUNE_EXAMPLE_MAX)}…`
                  : leastUsed.content,
            })}
          </Notice>
        )}
        {memories.length > MEMORY_SEARCH_THRESHOLD && (
          <SearchField
            value={query}
            onChange={setQuery}
            placeholder={t("memory.searchPlaceholder")}
          />
        )}

        {/* The composer sits right above the list: adding a memory is the whole
            point of the strip. Collapsed it's a single-line trigger; focusing
            it (or the + button) expands it into the full editor card. */}
        {composerOpen ? (
          <MemoryEditor
            initialContent=""
            initialAccountId={null}
            initialContactId={null}
            emailAccounts={emailAccounts}
            accountColor={accountColorOf}
            busy={adding}
            onSave={(content, accountId, contactId) => void add(content, accountId, contactId)}
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
              size="icon-xs"
              variant="ghost"
              className="absolute right-1 top-1/2 -translate-y-1/2"
              onClick={() => setComposerOpen(true)}
              aria-label={t("memory.add")}
            >
              <Plus />
            </Button>
          </div>
        )}

        {loading ? (
          <div className="flex flex-col gap-2.5" role="status" aria-label={t("common.loading")}>
            <Skeleton className="h-9 w-full rounded-lg" />
            <Skeleton className="h-9 w-full rounded-lg" />
          </div>
        ) : filtered.length === 0 ? (
          // Nothing saved at all? The composer above already says what to do.
          memories.length > 0 && (
            <p className="py-2 text-sm text-muted-foreground">
              {t("common.noResultsBody", { query: query.trim() })}
            </p>
          )
        ) : (
          <div className="flex flex-col gap-3">
            <div ref={listRef} className="flex flex-col gap-2">
              {shownGroups.map(({ group, rows, start, open: groupOpen }) => (
                <div key={group.key} className="flex flex-col gap-1">
                  {group.label !== null && (
                    <DisclosureToggle
                      open={groupOpen}
                      onToggle={() => toggleGroup(group.key)}
                      className="px-1 py-0.5"
                    >
                      <ScopeDot kind={group.kind} color={group.color} />
                      <span className="max-w-56 truncate">{group.label}</span>
                      <span className="tabular text-2xs text-muted-foreground/70">
                        {group.entries.length}
                      </span>
                    </DisclosureToggle>
                  )}
                  {rows.length > 0 && (
                    <ul className="flex flex-col gap-0.5">
                      {rows.map((entry, j) => (
                        <li key={entry.id} className="animate-in-up" style={stagger(start + j)}>
                          <MemoryRow
                            entry={entry}
                            onChanged={refresh}
                            highlighted={entry.id === focusId}
                            contactLabel={entry.contactId ? contactLabel(entry.contactId) : null}
                            resolveColor={accountColorOf}
                            emailAccounts={emailAccounts}
                          />
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
            {remaining > 0 && <ShowMoreButton count={remaining} onClick={showMore} />}
          </div>
        )}

        <LearnActivity />
      </div>
    </Card>
  );
}
