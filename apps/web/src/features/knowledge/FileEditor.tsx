import type { LibraryDocument, LibraryStatus, MemoryEntry, Skill } from "@marlen/shared";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { Markdown } from "tiptap-markdown";
import { AccountDot } from "@/components/ui/account-dot";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useAccountColors } from "@/lib/accounts";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";

/**
 * The browser's md editor: tiptap over markdown (tiptap-markdown parses on
 * load and serializes on save), one dialog for all three file kinds. A memory
 * edits its fact plus its scope tag (general or one connected account; an
 * existing contact scope shows as its own tag and is kept unless another is
 * picked). A skill edits description and instructions. A knowledge document
 * round-trips its raw file text through the content endpoint.
 */

export type EditorTarget =
  | { kind: "memory"; entry: MemoryEntry }
  | { kind: "skill"; skill: Skill }
  | { kind: "document"; doc: LibraryDocument }
  /** The "new file" flow: the dialog itself asks what kind to create. */
  | { kind: "create" };

/** null = keep the entry's current contact scope untouched. */
type MemoryScope = { accountId: string | null } | null;

/** Memories keep one fact per line (learned styles are one directive per line):
 *  tiptap's blank-line paragraph breaks collapse to single newlines, whitespace
 *  inside a line to one space. */
function memoryContent(markdown: string): string {
  return markdown
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/** What the create flow produces; notes and folders land in the browsed knowledge folder. */
type CreateKind = "note" | "folder" | "memory" | "skill";
const CREATE_KINDS: CreateKind[] = ["note", "folder", "memory", "skill"];

function MarkdownArea({
  initial,
  onReady,
}: {
  initial: string;
  onReady: (getMarkdown: () => string) => void;
}) {
  const editor = useEditor({
    extensions: [StarterKit, Markdown.configure({ html: false })],
    content: initial,
    autofocus: "end",
  });
  React.useEffect(() => {
    if (!editor) return;
    onReady(() => (editor.storage.markdown as { getMarkdown: () => string }).getMarkdown());
  }, [editor, onReady]);
  return (
    <EditorContent
      editor={editor}
      className="min-h-48 rounded-lg bg-surface-2 px-3 py-2 text-sm leading-relaxed [&_.ProseMirror]:min-h-44 [&_.ProseMirror]:outline-none [&_.ProseMirror_h1]:text-lg [&_.ProseMirror_h1]:font-semibold [&_.ProseMirror_h2]:text-base [&_.ProseMirror_h2]:font-semibold [&_.ProseMirror_h3]:font-semibold [&_.ProseMirror_ul]:list-disc [&_.ProseMirror_ul]:pl-5 [&_.ProseMirror_ol]:list-decimal [&_.ProseMirror_ol]:pl-5 [&_.ProseMirror_blockquote]:border-l-2 [&_.ProseMirror_blockquote]:pl-3 [&_.ProseMirror_code]:font-mono [&_.ProseMirror_code]:text-xs"
    />
  );
}

export function FileEditor({
  target,
  currentDir = "",
  onClose,
  onStatus,
}: {
  target: EditorTarget;
  /** Knowledge-relative folder new notes/folders are created in ("" = root). */
  currentDir?: string;
  onClose: () => void;
  /** A document save returns fresh LibraryStatus; the caller pushes it into its query. */
  onStatus: (status: LibraryStatus) => void;
}) {
  const { t } = useTranslation();
  const { accounts, colors } = useAccountColors();
  const [saving, setSaving] = React.useState(false);
  const [createKind, setCreateKind] = React.useState<CreateKind>("note");
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState(
    target.kind === "skill" ? target.skill.description : "",
  );
  const [scope, setScope] = React.useState<MemoryScope>(
    target.kind === "memory" && target.entry.contactId !== null
      ? null
      : { accountId: target.kind === "memory" ? target.entry.accountId : null },
  );
  // Document text arrives async; everything else is already loaded.
  const [initial, setInitial] = React.useState<string | null>(
    target.kind === "memory"
      ? target.entry.content
      : target.kind === "skill"
        ? target.skill.instructions
        : target.kind === "create"
          ? ""
          : null,
  );
  const getMarkdownRef = React.useRef<(() => string) | null>(null);

  const isMemory =
    target.kind === "memory" || (target.kind === "create" && createKind === "memory");
  const isSkill = target.kind === "skill" || (target.kind === "create" && createKind === "skill");

  React.useEffect(() => {
    if (target.kind !== "document") return;
    let stale = false;
    api
      .documentContent(target.doc.id)
      .then((res) => {
        if (!stale) setInitial(res.content);
      })
      .catch((err) => {
        toast.error(err);
        onClose();
      });
    return () => {
      stale = true;
    };
  }, [target, onClose]);

  const save = async () => {
    // A folder has no body; every other kind needs the mounted editor's text.
    const folderKind = target.kind === "create" && createKind === "folder";
    const markdown = folderKind ? "" : getMarkdownRef.current?.().trim();
    if (markdown === undefined) return;
    setSaving(true);
    try {
      if (target.kind === "memory") {
        const content = memoryContent(markdown);
        await (scope === null
          ? api.updateMemory(target.entry.id, content)
          : api.updateMemory(target.entry.id, content, scope.accountId, null));
      } else if (target.kind === "skill") {
        await api.saveSkill(target.skill.name, description, markdown);
      } else if (target.kind === "document") {
        onStatus(await api.saveDocumentContent(target.doc.id, markdown));
      } else if (createKind === "memory") {
        await api.addMemory(memoryContent(markdown), scope?.accountId ?? null);
      } else if (createKind === "skill") {
        await api.saveSkill(name, description, markdown);
      } else if (createKind === "folder") {
        const path = currentDir ? `${currentDir}/${name.trim()}` : name.trim();
        onStatus(await api.createLibraryFolder(path));
      } else {
        // A note is an ordinary md file, created via upload into the browsed folder.
        const fileName = /\.(md|markdown|txt)$/i.test(name.trim())
          ? name.trim()
          : `${name.trim()}.md`;
        onStatus(
          await api.uploadLibraryFile(
            new File([`${markdown}\n`], fileName, { type: "text/markdown" }),
            currentDir || undefined,
          ),
        );
      }
      onClose();
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  const accountDot = (accountId: string) => (
    <AccountDot color={colors.find((c) => c.accountId === accountId)?.hex} className="h-2 w-2" />
  );

  const title =
    target.kind === "memory"
      ? `${target.entry.id}.md`
      : target.kind === "skill"
        ? `${target.skill.name}.md`
        : target.kind === "document"
          ? target.doc.path
          : t("storage.editor.newTitle");
  const needsName = target.kind === "create" && createKind !== "memory";
  const isFolder = target.kind === "create" && createKind === "folder";

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={title}
      className="max-w-2xl"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            size="sm"
            onClick={() => void save()}
            loading={saving}
            disabled={needsName && !name.trim()}
          >
            {t("storage.editor.save")}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {target.kind === "create" && (
          <div className="flex flex-wrap items-center gap-1.5">
            {CREATE_KINDS.map((kind) => (
              <Chip key={kind} active={createKind === kind} onClick={() => setCreateKind(kind)}>
                {t(`storage.editor.kinds.${kind}`)}
              </Chip>
            ))}
          </div>
        )}

        {needsName && (
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("storage.editor.namePlaceholder")}
            aria-label={t("storage.editor.namePlaceholder")}
            className="font-mono text-xs"
          />
        )}

        {isSkill && (
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t("storage.editor.descriptionPlaceholder")}
            aria-label={t("storage.editor.descriptionPlaceholder")}
          />
        )}

        {isFolder ? null : initial === null ? (
          <Skeleton className="h-48 w-full rounded-lg" />
        ) : (
          <MarkdownArea
            initial={initial}
            onReady={(getMarkdown) => {
              getMarkdownRef.current = getMarkdown;
            }}
          />
        )}

        {isMemory && (
          <p className="text-xs text-muted-foreground">{t("storage.editor.memoryHint")}</p>
        )}

        {isMemory && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground">{t("storage.editor.scope")}</span>
            <Chip
              active={scope !== null && scope.accountId === null}
              onClick={() => setScope({ accountId: null })}
            >
              {t("storage.editor.general")}
            </Chip>
            {accounts.map((account) => (
              <Chip
                key={account.id}
                active={scope !== null && scope.accountId === account.id}
                onClick={() => setScope({ accountId: account.id })}
              >
                {accountDot(account.id)}
                {account.name}
              </Chip>
            ))}
            {target.kind === "memory" && target.entry.contactId !== null && (
              <Chip active={scope === null} onClick={() => setScope(null)}>
                @{target.entry.contactId}
              </Chip>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}
