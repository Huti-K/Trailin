import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { LibraryDocument, LibrarySearchHit, LibraryStatus } from "@trailin/shared";
import { Check, Folder, FolderOpen, SearchX, Upload } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DisclosureToggle, ShowMoreButton } from "@/components/ui/disclosure-toggle";
import { EmptyState } from "@/components/ui/empty-state";
import { RetryableError } from "@/components/ui/feedback";
import { InlineEditButton } from "@/components/ui/inline-edit-button";
import { Input } from "@/components/ui/input";
import { SearchField } from "@/components/ui/search-field";
import { SectionTitle } from "@/components/ui/section-header";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { usePagedVisible } from "@/lib/usePagedVisible";
import { errorMessage, stagger } from "@/lib/utils";
import { DocumentTile } from "./DocumentTile";

/** The document grid's own shape — thumbnail, title, meta line. */
const DOC_GRID = "grid grid-cols-2 gap-1.5 sm:grid-cols-4 lg:grid-cols-5";

/** Rows shown before the list asks to be expanded, and how many each press adds. */
const INITIAL_VISIBLE = 12;
const VISIBLE_STEP = 24;

/** A search field is chrome until there's enough here to lose track of. */
const SEARCH_THRESHOLD = 8;

/** Which library subfolders are folded away — the folder tree mirrors the drop folder on disk. */
const LIBRARY_FOLDED_KEY = "trailin:knowledge:library-folded";

function readFoldedFolders(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LIBRARY_FOLDED_KEY) ?? "[]");
    return new Set(
      Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : [],
    );
  } catch {
    return new Set();
  }
}

/** A document's top-level subfolder within the library, or null for files at the root. */
function folderOf(doc: LibraryDocument): string | null {
  const slash = doc.path.indexOf("/");
  return slash === -1 ? null : doc.path.slice(0, slash);
}

/** One rendered run of tiles: root files first (label-less), then one collapsible group per subfolder. */
type LibraryGroup = {
  key: string;
  /** The subfolder name; null for the label-less root run (and for flat search results). */
  label: string | null;
  entries: LibraryDocument[];
};

function TileSkeleton({ tiles }: { tiles: number }) {
  const { t } = useTranslation();
  return (
    <div role="status" aria-label={t("common.loading")} className={DOC_GRID}>
      {Array.from({ length: tiles }, (_, i) => (
        // Interchangeable placeholders with no content of their own — index is
        // the only identity available, and the count never reorders.
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder count, never reordered
        <div key={i} className="flex flex-col gap-2 p-2">
          <Skeleton className="aspect-[4/3] w-full rounded-lg" />
          <Skeleton className="h-3.5 w-2/3" />
          <Skeleton className="h-3 w-1/3" />
        </div>
      ))}
    </div>
  );
}

export function LibrarySection({ focusId }: { focusId: string | null }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const libraryQuery = useQuery({ queryKey: ["library", "status"], queryFn: () => api.library() });
  const status = libraryQuery.data ?? null;
  const loadError = libraryQuery.error ? errorMessage(libraryQuery.error) : null;
  /** Several flows get a fresh LibraryStatus back from their own call — push it into the shared query. */
  const setStatus = (next: LibraryStatus) => queryClient.setQueryData(["library", "status"], next);
  const [uploading, setUploading] = React.useState(false);
  const [dragging, setDragging] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const { visible, showMore, revealIndex } = usePagedVisible(INITIAL_VISIBLE, VISIBLE_STEP, query);
  const [docToDelete, setDocToDelete] = React.useState<LibraryDocument | null>(null);
  const [deleting, setDeleting] = React.useState(false);
  const [folded, setFolded] = React.useState<Set<string>>(readFoldedFolders);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  // dragenter/dragleave fire for every child element, so count depth rather
  // than toggling — otherwise the overlay flickers as the pointer crosses rows.
  const dragDepth = React.useRef(0);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["library"] });

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
        toast.error(err);
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
      toast.error(err);
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
    // narrows the list.
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
    try {
      localStorage.setItem(LIBRARY_FOLDED_KEY, JSON.stringify([...folded]));
    } catch {
      // private mode: the section just forgets between visits
    }
  }, [folded]);

  // Opened from the search palette: a live query might be hiding it, it may
  // sit inside a folded folder, and it may sit past the fold. Clear the first,
  // unfold the second, reach past the third. Only focusId/status should
  // re-fire this — including query/snippetByDocId would re-run it right
  // after the setQuery("") below clears the query that made it fire.
  // biome-ignore lint/correctness/useExhaustiveDependencies: query/snippetByDocId are read but must not re-trigger this effect (it clears query itself)
  React.useEffect(() => {
    if (!focusId || !status) return;
    const doc = status.documents.find((d) => d.id === focusId);
    if (!doc) return;
    const q = query.trim().toLowerCase();
    if (q && !doc.title.toLowerCase().includes(q) && !snippetByDocId.has(doc.id)) setQuery("");
    const folder = folderOf(doc);
    if (folder !== null) {
      setFolded((prev) => {
        if (!prev.has(folder)) return prev;
        const next = new Set(prev);
        next.delete(folder);
        return next;
      });
    }
  }, [focusId, status]);

  const searching = query.trim().length > 0;

  // Browsing groups by top-level subfolder — root files first as a label-less
  // run, then one collapsible group per folder, alphabetized (the tree simply
  // mirrors how the user organized the drop folder on disk). A search renders
  // flat instead: results are in relevance order, and slicing them into
  // folders would scramble it.
  const groups = React.useMemo<LibraryGroup[]>(() => {
    if (searching) return [{ key: "__flat__", label: null, entries: documents }];
    const root: LibraryDocument[] = [];
    const byFolder = new Map<string, LibraryDocument[]>();
    for (const doc of documents) {
      const folder = folderOf(doc);
      if (folder === null) {
        root.push(doc);
        continue;
      }
      const list = byFolder.get(folder);
      if (list) list.push(doc);
      else byFolder.set(folder, [doc]);
    }
    const folderGroups = [...byFolder.entries()]
      .map(([name, entries]) => ({ key: name, label: name, entries }))
      .sort((a, b) => a.label.localeCompare(b.label));
    return [
      ...(root.length > 0 ? [{ key: "__root__", label: null, entries: root }] : []),
      ...folderGroups,
    ];
  }, [documents, searching]);

  const toggleFolder = (key: string) =>
    setFolded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // What the visible cap and a palette hit's position are measured against:
  // the unfolded groups' documents, in render order. Repeats the open
  // predicate inline so the memo depends on plain state.
  const orderedDocs = React.useMemo(
    () => groups.filter((g) => g.label === null || !folded.has(g.key)).flatMap((g) => g.entries),
    [groups, folded],
  );

  React.useEffect(() => {
    if (!focusId) return;
    revealIndex(orderedDocs.findIndex((d) => d.id === focusId));
  }, [focusId, orderedDocs, revealIndex]);

  // documents/visible are re-run triggers, not read here: the effect above can
  // expand `visible` on a later commit, and the target row only exists in the
  // DOM once that happens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: documents/visible re-trigger the scroll once the row mounts, not read in the body
  React.useEffect(() => {
    if (!focusId) return;
    listRef.current
      ?.querySelector(`[data-doc-id="${focusId}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusId, documents, visible]);

  const dragHasFiles = (e: React.DragEvent) => e.dataTransfer.types.includes("Files");

  if (!status) {
    return loadError ? (
      <RetryableError onRetry={() => void refresh()}>{loadError}</RetryableError>
    ) : (
      <Card as="section" padding="lg" className="flex flex-col gap-5">
        <Skeleton className="h-7 w-44" />
        <Skeleton className="h-4 w-3/4" />
        <TileSkeleton tiles={10} />
      </Card>
    );
  }

  const empty = status.documents.length === 0;

  // The visible cap is spent across unfolded groups in render order; folded
  // groups still show their header line but contribute no tiles. `start`
  // keeps the entrance stagger continuous across group boundaries.
  const shownGroups: {
    group: LibraryGroup;
    tiles: LibraryDocument[];
    start: number;
    open: boolean;
  }[] = [];
  let consumed = 0;
  for (const group of groups) {
    const open = group.label === null || !folded.has(group.key);
    const tiles = open ? group.entries.slice(0, Math.max(0, visible - consumed)) : [];
    shownGroups.push({ group, tiles, start: consumed, open });
    consumed += tiles.length;
  }
  const remaining = orderedDocs.length - consumed;

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
        <SectionTitle
          icon={FolderOpen}
          tone="tint-neutral"
          title={t("knowledge.sections.library.title")}
          count={status.documents.length}
          description={t("knowledge.sections.library.description")}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".pdf,.md,.markdown,.txt,.docx,.csv,.html,.htm"
            className="hidden"
            onChange={(e) => void upload(e.target.files)}
          />
          <Button size="sm" onClick={() => fileInputRef.current?.click()} loading={uploading}>
            <Upload />
            {uploading ? t("library.uploading") : t("library.upload")}
          </Button>
        </SectionTitle>

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
          surface={false}
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
          surface={false}
          action={
            <Button variant="outline" size="sm" onClick={() => setQuery("")}>
              {t("common.clearSearch")}
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col gap-3">
          <div ref={listRef} className="flex flex-col gap-4">
            {shownGroups.map(({ group, tiles, start, open }) => (
              <div key={group.key} className="flex flex-col gap-1.5">
                {group.label !== null && (
                  <DisclosureToggle
                    open={open}
                    onToggle={() => toggleFolder(group.key)}
                    className="px-1 py-0.5"
                  >
                    <Folder className="h-3.5 w-3.5 shrink-0" />
                    <span className="max-w-56 truncate">{group.label}</span>
                    <span className="tabular text-2xs text-muted-foreground/70">
                      {group.entries.length}
                    </span>
                  </DisclosureToggle>
                )}
                {tiles.length > 0 && (
                  <ul className={DOC_GRID}>
                    {tiles.map((doc, j) => (
                      <li key={doc.id} className="animate-in-up" style={stagger(start + j)}>
                        <DocumentTile
                          doc={doc}
                          snippet={snippetByDocId.get(doc.id)}
                          onDelete={() => setDocToDelete(doc)}
                          highlighted={doc.id === focusId}
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

      <ConfirmDialog
        open={!!docToDelete}
        onOpenChange={(open) => !open && setDocToDelete(null)}
        title={t("library.delete")}
        description={docToDelete ? t("library.deleteConfirm", { title: docToDelete.title }) : ""}
        confirmLabel={t("library.delete")}
        busy={deleting}
        onConfirm={() => void confirmRemove()}
      />
    </Card>
  );
}

/** How long the "saved" checkmark holds before the control reverts to idle. */
const SAVED_FLASH_MS = 500;

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
      setTimeout(() => setState("idle"), SAVED_FLASH_MS);
    } catch (err) {
      toast.error(err);
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
      }, SAVED_FLASH_MS);
    } catch (err) {
      toast.error(err);
      setState("idle");
    } finally {
      busy.current = false;
    }
  };

  const statusNote =
    state === "saving" ? (
      <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
        <Spinner className="h-3.5 w-3.5" /> {t("common.saving")}
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
      <InlineEditButton
        dir="rtl"
        onClick={startEdit}
        disabled={picking}
        aria-label={`${t("library.editPath")}: ${folder}`}
        data-tooltip={folder}
        className="font-mono text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        {folder}
      </InlineEditButton>
      {statusNote}
      <Button
        variant="ghost"
        size="sm"
        className="shrink-0"
        onClick={() => void pick()}
        loading={picking}
      >
        {t("library.changeFolder")}
      </Button>
    </div>
  );
}
