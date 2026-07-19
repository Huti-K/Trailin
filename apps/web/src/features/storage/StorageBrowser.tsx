import { formatFileSize } from "@trailin/shared";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Clock,
  Files,
  Folder,
  FolderOpen,
  LayoutGrid,
  List as ListIcon,
  type LucideIcon,
  Search,
  Trash2,
  X,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { EmptyState } from "@/components/ui/empty-state";
import { GroupLabel } from "@/components/ui/group-label";
import { IconButton } from "@/components/ui/icon-button";
import { OptionRow } from "@/components/ui/option-row";
import { SearchField } from "@/components/ui/search-field";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { type NodeActions, NodeRows, NodeTiles, type StorageNode } from "./listing";

export type { StorageNode } from "./listing";

/**
 * File browser over caller-supplied nodes: saved views and folder tree in the
 * rail, breadcrumb toolbar with search/sort/layout, the listing as rows or
 * tiles. Search is controlled by the caller (`query`/`onQueryChange`) so it
 * can feed a content-search backend; a file id present in `searchHits` counts
 * as a match, and its hit snippet overrides the node's standing one in list
 * mode. Searching lists flat across folders. Actions exist only where the
 * caller wires them.
 */

type StorageView = "folder" | "recent";
type SortBy = "name" | "updatedAt" | "sizeBytes";
type DisplayMode = "list" | "grid";

const VIEWS: StorageView[] = ["folder", "recent"];

const VIEW_ICON: Record<StorageView, LucideIcon> = {
  folder: Files,
  recent: Clock,
};

const EMPTY_ICON: Record<StorageView, LucideIcon> = {
  folder: FolderOpen,
  recent: Clock,
};

const SORT_FIELDS: SortBy[] = ["name", "updatedAt", "sizeBytes"];

/** The "recent" view keeps only the latest files, mirroring a last-opened feed. */
const RECENT_LIMIT = 12;

export function StorageBrowser({
  nodes,
  query,
  onQueryChange,
  searchHits,
  focusId,
  onOpenFile,
  onDelete,
  onDownload,
  onDeleteMany,
  onFolderChange,
  actions,
  railNote,
  className,
}: {
  nodes: StorageNode[];
  query: string;
  onQueryChange: (value: string) => void;
  /** Content-search snippets by file id; membership counts as a search match and overrides node.snippet. */
  searchHits?: Map<string, string>;
  /** File to navigate to and highlight (e.g. from the search palette). */
  focusId?: string | null;
  onOpenFile?: (node: StorageNode) => void;
  onDelete?: (node: StorageNode) => void;
  /** Wired only where nodes carry `downloadable` (library documents). */
  onDownload?: (node: StorageNode) => void;
  /** Enables multi-select; receives every selected node for one bulk delete. */
  onDeleteMany?: (nodes: StorageNode[]) => void;
  /** Reports folder navigation so the caller can target uploads and new files. */
  onFolderChange?: (folderId: string | null) => void;
  /** Caller controls rendered at the toolbar's right end (e.g. an upload button). */
  actions?: React.ReactNode;
  /** Mono footnote at the rail's bottom (e.g. the folder's on-disk path). */
  railNote?: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const [view, setView] = React.useState<StorageView>("folder");
  const [folderId, setFolderId] = React.useState<string | null>(null);
  const [mode, setMode] = React.useState<DisplayMode>("list");
  const [sort, setSort] = React.useState<{ by: SortBy; dir: "asc" | "desc" }>({
    by: "name",
    dir: "asc",
  });
  const listingRef = React.useRef<HTMLDivElement>(null);
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(new Set());

  const clearSelection = React.useCallback(() => setSelected(new Set()), []);
  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const openView = (next: StorageView) => {
    setView(next);
    setFolderId(null);
    onQueryChange("");
    onFolderChange?.(null);
    clearSelection();
  };
  const openFolder = (id: string | null) => {
    setView("folder");
    setFolderId(id);
    onQueryChange("");
    onFolderChange?.(id);
    clearSelection();
  };

  // Deleted or vanished nodes leave the selection; Escape empties it.
  React.useEffect(() => {
    setSelected((prev) => {
      const ids = new Set(nodes.map((node) => node.id));
      const next = new Set([...prev].filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [nodes]);
  React.useEffect(() => {
    if (selected.size === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") clearSelection();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected.size, clearSelection]);

  const byId = React.useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);

  const childFolders = React.useMemo(() => {
    const map = new Map<string | null, StorageNode[]>();
    for (const node of nodes) {
      if (node.kind !== "folder") continue;
      const siblings = map.get(node.parentId) ?? [];
      siblings.push(node);
      map.set(node.parentId, siblings);
    }
    for (const siblings of map.values()) siblings.sort((a, b) => a.name.localeCompare(b.name));
    return map;
  }, [nodes]);

  const term = query.trim().toLowerCase();
  const searching = term.length > 0;

  const listing = React.useMemo(() => {
    let picked: StorageNode[];
    if (searching) {
      picked = nodes.filter(
        (node) =>
          node.name.toLowerCase().includes(term) ||
          node.snippet?.toLowerCase().includes(term) ||
          searchHits?.has(node.id),
      );
    } else if (view === "recent") {
      picked = nodes
        .filter((node) => node.kind === "file")
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .slice(0, RECENT_LIMIT);
    } else {
      picked = nodes.filter((node) => node.parentId === folderId);
    }

    const dir = sort.dir === "asc" ? 1 : -1;
    return [...picked].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
      if (sort.by === "updatedAt") return (Date.parse(a.updatedAt) - Date.parse(b.updatedAt)) * dir;
      if (sort.by === "sizeBytes") return ((a.sizeBytes ?? 0) - (b.sizeBytes ?? 0)) * dir;
      return a.name.localeCompare(b.name) * dir;
    });
  }, [searching, term, searchHits, view, folderId, nodes, sort]);

  // Palette focus: clear a query that hides the file, then land in its folder.
  // focusId alone re-fires this; the query it may clear must not.
  // biome-ignore lint/correctness/useExhaustiveDependencies: query/searchHits are read but must not re-trigger (the effect clears the query itself)
  React.useEffect(() => {
    if (!focusId) return;
    const node = byId.get(focusId);
    if (!node) return;
    const matches =
      node.name.toLowerCase().includes(term) ||
      node.snippet?.toLowerCase().includes(term) ||
      searchHits?.has(node.id);
    if (term && !matches) onQueryChange("");
    setView("folder");
    setFolderId(node.parentId);
    onFolderChange?.(node.parentId);
  }, [focusId, byId]);

  // Runs again as listing settles so the row exists before scrolling to it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: listing re-triggers the scroll once the row mounts, not read in the body
  React.useEffect(() => {
    if (!focusId) return;
    listingRef.current
      ?.querySelector(`[data-node-id="${CSS.escape(focusId)}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusId, listing]);

  const crumbs = React.useMemo(() => {
    if (view !== "folder") return [{ id: null as string | null, label: t(`storage.nav.${view}`) }];
    const trail: { id: string | null; label: string }[] = [];
    for (
      let node = folderId ? byId.get(folderId) : undefined;
      node;
      node = node.parentId ? byId.get(node.parentId) : undefined
    ) {
      trail.unshift({ id: node.id, label: node.name });
    }
    return [{ id: null as string | null, label: t("storage.nav.folder") }, ...trail];
  }, [view, folderId, byId, t]);

  const selectable = React.useMemo(
    () => listing.filter((node) => node.deletable !== false),
    [listing],
  );
  const allSelected = selectable.length > 0 && selectable.every((node) => selected.has(node.id));
  const toggleSelectAll = React.useCallback(() => {
    setSelected(allSelected ? new Set() : new Set(selectable.map((node) => node.id)));
  }, [allSelected, selectable]);

  // Cmd/Ctrl+A selects the current listing, unless focus is in a text field.
  React.useEffect(() => {
    if (!onDeleteMany) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "a") return;
      if ((e.target as HTMLElement).closest("input, textarea, [contenteditable=true]")) return;
      e.preventDefault();
      setSelected(new Set(selectable.map((node) => node.id)));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDeleteMany, selectable]);

  const nodeActions: NodeActions = {
    openFolder,
    openFile: onOpenFile,
    download: onDownload,
    delete: onDelete,
    toggleSelect: onDeleteMany ? toggleSelect : undefined,
    toggleSelectAll: onDeleteMany ? toggleSelectAll : undefined,
    allSelected,
    selected,
    selectionActive: selected.size > 0,
  };
  const usedBytes = nodes.reduce((sum, node) => sum + (node.sizeBytes ?? 0), 0);

  // Every folder on the path to the current one, so the tree opens along it.
  const selectedTrail = React.useMemo(() => {
    const trail = new Set<string>();
    for (
      let node = view === "folder" && folderId ? byId.get(folderId) : undefined;
      node;
      node = node.parentId ? byId.get(node.parentId) : undefined
    ) {
      trail.add(node.id);
    }
    return trail;
  }, [view, folderId, byId]);

  return (
    <div className={cn("flex min-h-0 items-stretch gap-4", className)}>
      <aside className="surface hidden w-52 shrink-0 flex-col gap-4 p-3 md:flex">
        <nav className="flex flex-col gap-0.5">
          {VIEWS.map((entry) => {
            const Icon = VIEW_ICON[entry];
            const active = view === entry && (entry !== "folder" || !folderId);
            return (
              <OptionRow
                key={entry}
                icon={<Icon className="h-4 w-4 shrink-0" />}
                label={t(`storage.nav.${entry}`)}
                selected={active}
                aria-current={active ? "page" : undefined}
                onClick={() => openView(entry)}
              />
            );
          })}
        </nav>

        <GroupLabel size="sm" className="pl-2.5">
          {t("storage.folders")}
        </GroupLabel>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {(childFolders.get(null) ?? []).map((node) => (
            <FolderTreeRow
              key={node.id}
              node={node}
              depth={0}
              childFolders={childFolders}
              selectedId={view === "folder" ? folderId : null}
              selectedTrail={selectedTrail}
              onSelect={openFolder}
            />
          ))}
        </div>

        <div className="flex flex-col gap-0.5 px-2.5 pb-1">
          {railNote && (
            <p
              dir="rtl"
              data-tooltip={railNote}
              className="truncate text-left font-mono text-2xs text-muted-foreground"
            >
              {railNote}
            </p>
          )}
          <p className="font-mono text-2xs text-muted-foreground tabular-nums">
            {t("storage.usage", { used: formatFileSize(usedBytes) })}
          </p>
        </div>
      </aside>

      <section className="surface flex min-w-0 flex-1 flex-col @container">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pb-2 pt-3">
          {selected.size > 0 ? (
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("storage.clearSelection")}
                onClick={clearSelection}
              >
                <X />
              </Button>
              <span className="whitespace-nowrap text-sm font-medium tabular-nums">
                {t("storage.selected", { count: selected.size })}
              </span>
              {!allSelected && (
                <Button variant="ghost" size="sm" onClick={toggleSelectAll}>
                  {t("storage.selectAll")}
                </Button>
              )}
              <Button
                variant="ghost-danger"
                size="sm"
                onClick={() => onDeleteMany?.(nodes.filter((node) => selected.has(node.id)))}
              >
                <Trash2 />
                {t("storage.actions.delete")}
              </Button>
            </div>
          ) : (
            <nav
              aria-label={t("storage.breadcrumbs")}
              className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden text-sm"
            >
              {crumbs.map((crumb, index) => {
                const isLast = index === crumbs.length - 1;
                return (
                  <span key={crumb.id ?? "root"} className="flex min-w-0 items-center gap-1">
                    {index > 0 && (
                      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <button
                      type="button"
                      disabled={isLast || view !== "folder"}
                      onClick={() => openFolder(crumb.id)}
                      className={cn(
                        "min-w-0 truncate",
                        isLast
                          ? "font-medium text-foreground"
                          : "text-muted-foreground transition-colors hover:text-foreground",
                      )}
                    >
                      {crumb.label}
                    </button>
                  </span>
                );
              })}
            </nav>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <SearchField
              value={query}
              onChange={onQueryChange}
              placeholder={t("storage.searchPlaceholder")}
              className="w-40"
            />
            <Select
              id="storage-sort"
              value={sort.by}
              onChange={(value) => setSort((prev) => ({ ...prev, by: value as SortBy }))}
              options={SORT_FIELDS.map((field) => ({
                value: field,
                label: t(`storage.sort.${field}`),
              }))}
              className="w-28"
              aria-label={t("storage.sortLabel")}
            />
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t(`storage.sortDir.${sort.dir}`)}
              onClick={() =>
                setSort((prev) => ({ ...prev, dir: prev.dir === "asc" ? "desc" : "asc" }))
              }
            >
              {sort.dir === "asc" ? <ArrowUp /> : <ArrowDown />}
            </Button>
            <div className="flex gap-1">
              <Chip
                active={mode === "list"}
                aria-label={t("storage.view.list")}
                onClick={() => setMode("list")}
                className="w-7 justify-center px-0"
              >
                <ListIcon className="h-3.5 w-3.5" />
              </Chip>
              <Chip
                active={mode === "grid"}
                aria-label={t("storage.view.grid")}
                onClick={() => setMode("grid")}
                className="w-7 justify-center px-0"
              >
                <LayoutGrid className="h-3.5 w-3.5" />
              </Chip>
            </div>
            {actions}
          </div>
        </div>

        <div ref={listingRef} className="min-h-0 flex-1 overflow-y-auto scroll-stable px-2 pb-2">
          {listing.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <EmptyState
                surface={false}
                icon={searching ? Search : EMPTY_ICON[view]}
                description={t(searching ? "storage.empty.search" : `storage.empty.${view}`)}
              />
            </div>
          ) : mode === "grid" ? (
            <NodeTiles nodes={listing} focusId={focusId} actions={nodeActions} />
          ) : (
            <NodeRows
              nodes={listing}
              focusId={focusId}
              searchHits={searchHits}
              actions={nodeActions}
            />
          )}
        </div>
      </section>
    </div>
  );
}

function FolderTreeRow({
  node,
  depth,
  childFolders,
  selectedId,
  selectedTrail,
  onSelect,
}: {
  node: StorageNode;
  depth: number;
  childFolders: Map<string | null, StorageNode[]>;
  selectedId: string | null;
  /** Ancestors of the current folder; the tree opens along this path. */
  selectedTrail: Set<string>;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  // Follows the listing's navigation until the user toggles this row by hand.
  const [manual, setManual] = React.useState<boolean | null>(null);
  const expanded = manual ?? (depth === 0 || selectedTrail.has(node.id));
  const children = childFolders.get(node.id) ?? [];
  const selected = node.id === selectedId;

  return (
    <div>
      <div className="flex items-center gap-1" style={{ paddingLeft: `${depth * 12}px` }}>
        <IconButton
          aria-label={t(expanded ? "storage.tree.collapse" : "storage.tree.expand")}
          className={cn("p-0.5 text-muted-foreground", children.length === 0 && "invisible")}
          onClick={() => setManual(!expanded)}
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </IconButton>
        <button
          type="button"
          onClick={() => onSelect(node.id)}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-1.5 rounded-lg py-1.5 pl-1 pr-2 text-left text-sm transition-colors",
            selected ? "tint-accent font-medium" : "text-foreground hover:bg-surface-2",
          )}
        >
          <Folder className="h-4 w-4 shrink-0 text-accent" />
          <span className="truncate">{node.name}</span>
        </button>
      </div>
      {expanded &&
        children.map((child) => (
          <FolderTreeRow
            key={child.id}
            node={child}
            depth={depth + 1}
            childFolders={childFolders}
            selectedId={selectedId}
            selectedTrail={selectedTrail}
            onSelect={onSelect}
          />
        ))}
    </div>
  );
}
