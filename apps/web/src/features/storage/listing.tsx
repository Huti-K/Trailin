import { formatFileSize } from "@trailin/shared";
import {
  Check,
  FileSpreadsheet,
  FileText,
  Folder,
  Image as ImageIcon,
  type LucideIcon,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import type * as React from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { GroupLabel } from "@/components/ui/group-label";
import { HoverActions } from "@/components/ui/hover-actions";
import { dateTimeLabel } from "@/lib/dates";
import { cn } from "@/lib/utils";

/**
 * The listing half of the storage browser: list rows and grid tiles with
 * open/select/delete affordances. StorageBrowser owns navigation, search and
 * selection state and passes them down as NodeActions.
 */

export interface StorageNode {
  id: string;
  parentId: string | null;
  kind: "folder" | "file";
  name: string;
  /** Lowercase file extension; null for folders. */
  ext: string | null;
  sizeBytes: number | null;
  updatedAt: string;
  /** Indexing failure, surfaced on the row. */
  error?: string | null;
  /** Standing preview under the name in list mode; also searchable text. */
  snippet?: string | null;
  /** False for files with no in-app open action (e.g. memory files). */
  openable?: boolean;
  /** Small muted chip after the name (e.g. a memory's account scope). */
  tag?: string | null;
  /** False for nodes the caller refuses to delete (e.g. the root folders). */
  deletable?: boolean;
}

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "heic"]);
const SHEET_EXT = new Set(["xlsx", "xls", "xlsm", "csv"]);

function nodeIcon(node: StorageNode): LucideIcon {
  if (node.kind === "folder") return Folder;
  if (node.ext && IMAGE_EXT.has(node.ext)) return ImageIcon;
  if (node.ext && SHEET_EXT.has(node.ext)) return FileSpreadsheet;
  return FileText;
}

export interface NodeActions {
  openFolder: (id: string) => void;
  openFile?: (node: StorageNode) => void;
  delete?: (node: StorageNode) => void;
  /** Present only when the caller wired bulk deletion (onDeleteMany). */
  toggleSelect?: (id: string) => void;
  toggleSelectAll?: () => void;
  allSelected?: boolean;
  selected?: ReadonlySet<string>;
  selectionActive?: boolean;
}

function RowActions({ node, actions }: { node: StorageNode; actions: NodeActions }) {
  const { t } = useTranslation();
  if (!actions.delete || node.deletable === false) return null;
  return (
    <HoverActions className="justify-end">
      <Button
        variant="ghost-danger"
        size="icon-xs"
        aria-label={t("storage.actions.delete")}
        onClick={() => actions.delete?.(node)}
      >
        <Trash2 />
      </Button>
    </HoverActions>
  );
}

/** Folders open on click; files open when the caller wired onOpenFile and the node allows it. */
function NodeName({ node, actions }: { node: StorageNode; actions: NodeActions }) {
  const { t } = useTranslation();
  const openable =
    node.kind === "folder" || (actions.openFile !== undefined && node.openable !== false);
  const label = openable ? (
    <button
      type="button"
      onClick={() =>
        node.kind === "folder" ? actions.openFolder(node.id) : actions.openFile?.(node)
      }
      className="min-w-0 truncate text-left font-medium text-foreground transition-colors hover:text-accent"
    >
      {node.name}
    </button>
  ) : (
    <span className="min-w-0 truncate font-medium text-foreground">{node.name}</span>
  );
  return (
    <>
      {label}
      {node.tag && (
        <span className="shrink-0 rounded-full bg-surface-2 px-1.5 py-px text-2xs text-muted-foreground">
          {node.tag}
        </span>
      )}
      {node.error && (
        <TriangleAlert
          className="h-3 w-3 shrink-0 text-destructive"
          aria-label={t("library.error")}
          data-tooltip={node.error}
        />
      )}
    </>
  );
}

/**
 * Row-level click handler, or undefined when the row does nothing. While a
 * selection is active (or with cmd/ctrl held) a click toggles membership;
 * otherwise it opens. Clicks that land on inner buttons (name, checkbox,
 * delete) are theirs, not the row's.
 */
function rowAction(
  node: StorageNode,
  actions: NodeActions,
): ((e: React.MouseEvent) => void) | undefined {
  const canToggle = actions.toggleSelect !== undefined && node.deletable !== false;
  const open =
    node.kind === "folder"
      ? () => actions.openFolder(node.id)
      : actions.openFile && node.openable !== false
        ? () => actions.openFile?.(node)
        : undefined;
  if (!open && !canToggle) return undefined;
  return (e) => {
    if ((e.target as HTMLElement).closest("button")) return;
    if (canToggle && (actions.selectionActive || e.metaKey || e.ctrlKey)) {
      actions.toggleSelect?.(node.id);
      return;
    }
    open?.();
  };
}

/** Round check toggle; reserved space, revealed on hover and while selecting. */
function SelectToggle({ node, actions }: { node: StorageNode; actions: NodeActions }) {
  const { t } = useTranslation();
  if (!actions.toggleSelect || node.deletable === false) return null;
  const isSelected = actions.selected?.has(node.id) === true;
  return (
    <button
      type="button"
      aria-label={t("storage.actions.select")}
      aria-pressed={isSelected}
      onClick={() => actions.toggleSelect?.(node.id)}
      className={cn(
        "grid h-5 w-5 shrink-0 place-items-center rounded-full transition-[opacity,background-color]",
        isSelected
          ? "bg-accent text-accent-foreground opacity-100"
          : "bg-background/80 text-transparent hover:text-muted-foreground",
        !isSelected && !actions.selectionActive && "opacity-0 group-hover:opacity-100",
      )}
    >
      <Check className="h-3 w-3" />
    </button>
  );
}

// Column count follows the pane's own width via the section @container.
const LIST_COLUMNS =
  "grid-cols-[minmax(0,1fr)_4rem] @md:grid-cols-[minmax(0,1fr)_8.5rem_4rem] @xl:grid-cols-[minmax(0,1fr)_5rem_8.5rem_4rem]";
const SIZE_CELL = "hidden @xl:block";
const MODIFIED_CELL = "hidden @md:block";

export function NodeRows({
  nodes,
  focusId,
  searchHits,
  actions,
}: {
  nodes: StorageNode[];
  focusId?: string | null;
  searchHits?: Map<string, string>;
  actions: NodeActions;
}) {
  const { t, i18n } = useTranslation();
  return (
    <div>
      <div className={cn("grid items-center gap-x-3 px-2 pb-1 pt-2", LIST_COLUMNS)}>
        <span className="flex items-center gap-2.5">
          {actions.toggleSelectAll && (
            <button
              type="button"
              aria-label={t("storage.selectAll")}
              aria-pressed={actions.allSelected === true}
              onClick={actions.toggleSelectAll}
              className={cn(
                "grid h-5 w-5 shrink-0 place-items-center rounded-full transition-[background-color,color]",
                actions.allSelected === true
                  ? "bg-accent text-accent-foreground"
                  : "bg-background/80 text-transparent hover:text-muted-foreground",
              )}
            >
              <Check className="h-3 w-3" />
            </button>
          )}
          <GroupLabel as="span" size="sm">
            {t("storage.columns.name")}
          </GroupLabel>
        </span>
        <GroupLabel as="span" size="sm" className={SIZE_CELL}>
          {t("storage.columns.size")}
        </GroupLabel>
        <GroupLabel as="span" size="sm" className={MODIFIED_CELL}>
          {t("storage.columns.modified")}
        </GroupLabel>
        <span />
      </div>
      {nodes.map((node) => {
        const Icon = nodeIcon(node);
        const snippet = searchHits?.get(node.id) ?? node.snippet;
        const rowOpen = rowAction(node, actions);
        const isSelected = actions.selected?.has(node.id) === true;
        return (
          // biome-ignore lint/a11y/noStaticElementInteractions: whole-row open is a mouse convenience; the name button inside is the keyboard path
          // biome-ignore lint/a11y/useKeyWithClickEvents: same — keyboard users activate the name button
          <div
            key={node.id}
            data-node-id={node.id}
            onClick={rowOpen}
            className={cn(
              "group grid items-center gap-x-3 rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-surface-2",
              rowOpen && "cursor-pointer",
              LIST_COLUMNS,
              (node.id === focusId || isSelected) && "tint-accent",
            )}
          >
            <span className="flex min-w-0 items-center gap-2.5">
              <SelectToggle node={node} actions={actions} />
              <Icon
                className={cn(
                  "h-4 w-4 shrink-0",
                  node.kind === "folder" ? "text-accent" : "text-muted-foreground",
                )}
              />
              <span className="flex min-w-0 flex-col">
                <span className="flex min-w-0 items-center gap-1.5">
                  <NodeName node={node} actions={actions} />
                </span>
                {snippet && (
                  <span className="truncate text-2xs text-muted-foreground">{snippet}</span>
                )}
              </span>
            </span>
            <span
              className={cn("font-mono text-2xs text-muted-foreground tabular-nums", SIZE_CELL)}
            >
              {node.kind === "file" ? formatFileSize(node.sizeBytes ?? 0) : ""}
            </span>
            <span
              className={cn("font-mono text-2xs text-muted-foreground tabular-nums", MODIFIED_CELL)}
            >
              {dateTimeLabel(node.updatedAt, i18n.language)}
            </span>
            <RowActions node={node} actions={actions} />
          </div>
        );
      })}
    </div>
  );
}

export function NodeTiles({
  nodes,
  focusId,
  actions,
}: {
  nodes: StorageNode[];
  focusId?: string | null;
  actions: NodeActions;
}) {
  const { i18n } = useTranslation();
  return (
    <div className="grid grid-cols-2 gap-2.5 p-2 @lg:grid-cols-3 @3xl:grid-cols-4 @6xl:grid-cols-6">
      {nodes.map((node) => {
        const Icon = nodeIcon(node);
        const meta = [
          node.updatedAt ? dateTimeLabel(node.updatedAt, i18n.language) : null,
          node.kind === "file" && node.sizeBytes !== null ? formatFileSize(node.sizeBytes) : null,
        ]
          .filter(Boolean)
          .join(" · ");
        const tileOpen = rowAction(node, actions);
        const isSelected = actions.selected?.has(node.id) === true;
        return (
          // biome-ignore lint/a11y/noStaticElementInteractions: whole-tile open is a mouse convenience; the name button inside is the keyboard path
          // biome-ignore lint/a11y/useKeyWithClickEvents: same — keyboard users activate the name button
          <div
            key={node.id}
            data-node-id={node.id}
            onClick={tileOpen}
            className={cn(
              "group relative flex flex-col gap-2 rounded-xl bg-surface-2 p-2.5 transition-colors hover:bg-secondary",
              tileOpen && "cursor-pointer",
              (node.id === focusId || isSelected) && "tint-accent",
            )}
          >
            <div className="grid aspect-[4/3] place-items-center rounded-lg bg-background/70">
              <Icon
                strokeWidth={1.25}
                className={cn(
                  "h-10 w-10",
                  node.kind === "folder" ? "text-accent" : "text-muted-foreground",
                )}
              />
            </div>
            <div className="flex min-w-0 flex-col gap-0.5 px-0.5">
              <div className="flex min-w-0 items-center gap-1.5 text-sm">
                <NodeName node={node} actions={actions} />
              </div>
              <div className="truncate font-mono text-2xs text-muted-foreground tabular-nums">
                {meta || " "}
              </div>
            </div>
            <div className="absolute left-1.5 top-1.5">
              <SelectToggle node={node} actions={actions} />
            </div>
            <div className="absolute right-1.5 top-1.5">
              <RowActions node={node} actions={actions} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
