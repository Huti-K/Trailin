import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ConnectedAccount,
  LibraryDocument,
  LibrarySearchHit,
  LibraryStatus,
  MemoryEntry,
} from "@trailin/shared";
import { FolderOpen, Plus, Upload } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { RetryableError } from "@/components/ui/feedback";
import { Skeleton } from "@/components/ui/skeleton";
import { StorageBrowser, type StorageNode } from "@/features/storage/StorageBrowser";
import { useAccountColors } from "@/lib/accounts";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { errorMessage } from "@/lib/utils";
import { type EditorTarget, FileEditor } from "./FileEditor";

/**
 * The agent home as files, filling the Knowledge page: one StorageBrowser
 * over memory/, skills/ and knowledge/. Memory and skill entries appear as
 * their md files (content or description as the row snippet, no in-app open;
 * editing happens through the agent or any editor). Knowledge documents come
 * from the library index, with FTS content search so a query also finds text
 * inside PDFs and Word files. Uploads land in knowledge/.
 */

const MEMORY_DIR = "dir:memory";
const SKILLS_DIR = "dir:skills";
const KNOWLEDGE_DIR = "dir:knowledge";
const SKILL_ID_PREFIX = "skill:";

/** md/txt open in the in-app editor; every other format opens as a raw file. */
const EDITABLE_EXTENSIONS = new Set(["md", "markdown", "txt"]);

function folder(id: string, parentId: string | null, name: string, deletable = true): StorageNode {
  return {
    id,
    parentId,
    kind: "folder",
    name,
    ext: null,
    sizeBytes: null,
    updatedAt: "",
    deletable,
  };
}

interface SkillFileEntry {
  name: string;
  description: string;
  updatedAt: string;
}

/** A memory's scope as its row tag: the account's name, @contact, or none for general. */
function memoryTag(memory: MemoryEntry, accounts: ConnectedAccount[]): string | null {
  if (memory.contactId !== null) return `@${memory.contactId}`;
  if (memory.accountId === null) return null;
  return accounts.find((a) => a.id === memory.accountId)?.name ?? memory.accountId;
}

function toNodes(
  memories: MemoryEntry[],
  skills: SkillFileEntry[],
  documents: LibraryDocument[],
  folders: string[],
  accounts: ConnectedAccount[],
): StorageNode[] {
  const nodes: StorageNode[] = [
    folder(MEMORY_DIR, null, "memory", false),
    folder(SKILLS_DIR, null, "skills", false),
    folder(KNOWLEDGE_DIR, null, "knowledge", false),
  ];
  for (const memory of memories) {
    nodes.push({
      id: memory.id,
      parentId: MEMORY_DIR,
      kind: "file",
      name: `${memory.id}.md`,
      ext: "md",
      sizeBytes: null,
      updatedAt: memory.updatedAt,
      snippet: memory.content,
      tag: memoryTag(memory, accounts),
    });
  }
  for (const skill of skills) {
    nodes.push({
      id: `${SKILL_ID_PREFIX}${skill.name}`,
      parentId: SKILLS_DIR,
      kind: "file",
      name: `${skill.name}.md`,
      ext: "md",
      sizeBytes: null,
      updatedAt: skill.updatedAt,
      snippet: skill.description,
    });
  }
  // The server's folder list is authoritative (it includes empty folders);
  // document paths only fill in anything the list happens to miss.
  const subfolders = new Set<string>();
  const ensureChain = (dirPath: string): string => {
    const segments = dirPath.split("/");
    let parent = KNOWLEDGE_DIR;
    for (let depth = 0; depth < segments.length; depth += 1) {
      const id = `${KNOWLEDGE_DIR}/${segments.slice(0, depth + 1).join("/")}`;
      if (!subfolders.has(id)) {
        subfolders.add(id);
        nodes.push(folder(id, parent, segments[depth] ?? dirPath));
      }
      parent = id;
    }
    return parent;
  };
  for (const dirPath of folders) ensureChain(dirPath);
  for (const doc of documents) {
    const slash = doc.path.lastIndexOf("/");
    const parent = slash === -1 ? KNOWLEDGE_DIR : ensureChain(doc.path.slice(0, slash));
    const segments = doc.path.split("/");
    nodes.push({
      id: doc.id,
      parentId: parent,
      kind: "file",
      name: segments[segments.length - 1] ?? doc.path,
      ext: doc.ext || null,
      sizeBytes: doc.size,
      updatedAt: doc.modifiedAt,
      error: doc.status === "error" ? (doc.error ?? "") : null,
      downloadable: true,
    });
  }
  return nodes;
}

export function LibrarySection({ focusId }: { focusId: string | null }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const libraryQuery = useQuery({ queryKey: ["library", "status"], queryFn: () => api.library() });
  const memoriesQuery = useQuery({ queryKey: ["memories"], queryFn: () => api.memories() });
  const skillsQuery = useQuery({ queryKey: ["skills"], queryFn: () => api.skills() });
  const status = libraryQuery.data ?? null;
  const loadError = libraryQuery.error ? errorMessage(libraryQuery.error) : null;
  const setStatus = (next: LibraryStatus) => queryClient.setQueryData(["library", "status"], next);
  const { accounts } = useAccountColors();
  const [uploading, setUploading] = React.useState(false);
  const [dragging, setDragging] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [nodesToDelete, setNodesToDelete] = React.useState<StorageNode[] | null>(null);
  const [deleting, setDeleting] = React.useState(false);
  const [editing, setEditing] = React.useState<EditorTarget | null>(null);
  // Where the browser currently is; targets uploads and the New dialog.
  const [currentFolderId, setCurrentFolderId] = React.useState<string | null>(null);
  const currentDir =
    currentFolderId?.startsWith(`${KNOWLEDGE_DIR}/`) === true
      ? currentFolderId.slice(KNOWLEDGE_DIR.length + 1)
      : "";
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  // dragenter/dragleave fire per child element; count depth so the overlay
  // doesn't flicker as the pointer crosses rows.
  const dragDepth = React.useRef(0);

  // Debounced FTS content search; stale responses are dropped.
  const [contentHits, setContentHits] = React.useState<LibrarySearchHit[]>([]);
  const lastSearchedRef = React.useRef("");
  React.useEffect(() => {
    const trimmed = query.trim();
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
          // content search is a bonus signal; name filtering still works
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  const searchHits = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const hit of contentHits) map.set(hit.id, hit.snippet);
    return map;
  }, [contentHits]);

  const nodes = React.useMemo(
    () =>
      toNodes(
        memoriesQuery.data ?? [],
        skillsQuery.data ?? [],
        status?.documents ?? [],
        status?.folders ?? [],
        accounts,
      ),
    [memoriesQuery.data, skillsQuery.data, status, accounts],
  );

  /** Memories and skills open the md editor; documents do too when they are
   *  editable text, otherwise the raw file opens in a new tab. */
  const openFile = (node: StorageNode) => {
    if (node.parentId === MEMORY_DIR) {
      const entry = memoriesQuery.data?.find((m) => m.id === node.id);
      if (entry) setEditing({ kind: "memory", entry });
      return;
    }
    if (node.id.startsWith(SKILL_ID_PREFIX)) {
      const skill = skillsQuery.data?.find((s) => s.name === node.id.slice(SKILL_ID_PREFIX.length));
      if (skill) setEditing({ kind: "skill", skill });
      return;
    }
    const doc = status?.documents.find((d) => d.id === node.id);
    if (!doc) return;
    if (EDITABLE_EXTENSIONS.has(doc.ext)) setEditing({ kind: "document", doc });
    else api.openLibraryDocument(doc.id);
  };

  const upload = async (fileList: FileList | null) => {
    const files = fileList ? Array.from(fileList) : [];
    if (files.length === 0 || uploading) return;
    setUploading(true);
    let last: LibraryStatus | null = null;
    let added = 0;
    for (const file of files) {
      try {
        last = await api.uploadLibraryFile(file, currentDir || undefined);
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
    const nodes = nodesToDelete;
    if (!nodes || nodes.length === 0) return;
    setDeleting(true);
    try {
      // Deleting a selected folder may also remove selected files inside it —
      // per-kind deletes tolerate already-gone targets (404s toast, but only
      // for genuinely separate failures).
      for (const node of nodes) {
        if (node.kind === "folder") {
          setStatus(await api.deleteLibraryFolder(node.id.slice(KNOWLEDGE_DIR.length + 1)));
        } else if (node.id.startsWith(SKILL_ID_PREFIX)) {
          await api.deleteSkill(node.id.slice(SKILL_ID_PREFIX.length));
        } else if (node.parentId === MEMORY_DIR) {
          await api.deleteMemory(node.id);
        } else {
          setStatus(await api.deleteLibraryDocument(node.id));
        }
      }
    } catch (err) {
      toast.error(err);
    } finally {
      if (nodes.some((node) => node.id.startsWith(SKILL_ID_PREFIX))) {
        await queryClient.invalidateQueries({ queryKey: ["skills"] });
      }
      if (nodes.some((node) => node.parentId === MEMORY_DIR)) {
        await queryClient.invalidateQueries({ queryKey: ["memories"] });
      }
      setDeleting(false);
      setNodesToDelete(null);
    }
  };

  const dragHasFiles = (e: React.DragEvent) => e.dataTransfer.types.includes("Files");

  if (!status) {
    return loadError ? (
      <RetryableError onRetry={() => queryClient.invalidateQueries({ queryKey: ["library"] })}>
        {loadError}
      </RetryableError>
    ) : (
      <Skeleton className="h-full min-h-96 w-full rounded-lg" />
    );
  }

  // status.folder is <home>/knowledge; the rail note shows the home itself.
  const homePath = status.folder.replace(/[/\\]knowledge$/, "");

  // The current browser location as a home-relative path for the OS file manager.
  const revealPath =
    currentFolderId === MEMORY_DIR
      ? "memory"
      : currentFolderId === SKILLS_DIR
        ? "skills"
        : currentFolderId?.startsWith(KNOWLEDGE_DIR)
          ? `knowledge${currentDir ? `/${currentDir}` : ""}`
          : "";

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop upload target, not an interactive control
    <section
      className="relative flex h-full min-h-0 flex-col"
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

      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".pdf,.md,.markdown,.txt,.docx,.csv,.html,.htm"
        className="hidden"
        onChange={(e) => void upload(e.target.files)}
      />

      <StorageBrowser
        nodes={nodes}
        query={query}
        onQueryChange={setQuery}
        searchHits={searchHits}
        focusId={focusId}
        onOpenFile={openFile}
        onDelete={(node) => setNodesToDelete([node])}
        onDownload={(node) => api.downloadLibraryDocument(node.id)}
        onDeleteMany={(nodes) => nodes.length > 0 && setNodesToDelete(nodes)}
        onFolderChange={setCurrentFolderId}
        actions={
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                void api.revealLibraryFolder(revealPath).catch((err: unknown) => toast.error(err))
              }
            >
              <FolderOpen />
              {t("library.openFolder")}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setEditing({ kind: "create" })}>
              <Plus />
              {t("storage.editor.new")}
            </Button>
            <Button size="sm" onClick={() => fileInputRef.current?.click()} loading={uploading}>
              <Upload />
              {uploading ? t("library.uploading") : t("library.upload")}
            </Button>
          </>
        }
        railNote={homePath}
        className="min-h-0 flex-1"
      />

      {editing && (
        <FileEditor
          target={editing}
          currentDir={currentDir}
          onClose={() => setEditing(null)}
          onStatus={setStatus}
        />
      )}

      <ConfirmDialog
        open={!!nodesToDelete}
        onOpenChange={(open) => !open && setNodesToDelete(null)}
        title={t("library.delete")}
        description={
          nodesToDelete === null
            ? ""
            : nodesToDelete.length > 1
              ? t("library.deleteManyConfirm", { count: nodesToDelete.length })
              : t(
                  nodesToDelete[0]?.kind === "folder"
                    ? "library.deleteFolderConfirm"
                    : "library.deleteConfirm",
                  { title: nodesToDelete[0]?.name ?? "" },
                )
        }
        confirmLabel={t("library.delete")}
        busy={deleting}
        onConfirm={() => void confirmRemove()}
      />
    </section>
  );
}
