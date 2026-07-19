import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Skill } from "@trailin/shared";
import { ChevronDown, ListChecks, Plus, Trash2 } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { HoverActions } from "@/components/ui/hover-actions";
import { InlineEditButton } from "@/components/ui/inline-edit-button";
import { Input } from "@/components/ui/input";
import { SectionTitle } from "@/components/ui/section-header";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useAutoGrow } from "@/lib/useAutoGrow";
import { cn, stagger } from "@/lib/utils";

/** Collapse state outlives the route, like the memory strip's. */
const SKILLS_OPEN_KEY = "trailin:knowledge:skills-open";

function readSkillsOpen(): boolean {
  try {
    return localStorage.getItem(SKILLS_OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}

/**
 * The add/edit card for one skill: name (new skills only — a skill's name is
 * its file identity, so existing ones keep theirs), one-line description, and
 * the instructions body in an auto-growing textarea.
 */
function SkillEditor({
  initial,
  busy,
  onSave,
  onCancel,
}: {
  /** null for a fresh skill — shows the name field. */
  initial: Skill | null;
  busy: boolean;
  onSave: (name: string, description: string, instructions: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = React.useState(initial?.name ?? "");
  const [description, setDescription] = React.useState(initial?.description ?? "");
  const [instructions, setInstructions] = React.useState(initial?.instructions ?? "");
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  useAutoGrow(textareaRef, instructions);

  const canSave =
    !busy &&
    name.trim().length > 0 &&
    description.trim().length > 0 &&
    instructions.trim().length > 0;
  const save = () => {
    if (canSave) onSave(name, description, instructions);
  };
  const onFieldKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg bg-surface-2 p-3 focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background">
      {initial === null && (
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={onFieldKeyDown}
          disabled={busy}
          autoFocus
          placeholder={t("knowledge.sections.skills.namePlaceholder")}
          aria-label={t("knowledge.sections.skills.namePlaceholder")}
          className="font-mono text-sm"
        />
      )}
      <Input
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        onKeyDown={onFieldKeyDown}
        disabled={busy}
        autoFocus={initial !== null}
        placeholder={t("knowledge.sections.skills.descriptionPlaceholder")}
        aria-label={t("knowledge.sections.skills.descriptionPlaceholder")}
        className="text-sm"
      />
      <textarea
        ref={textareaRef}
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
        onKeyDown={onFieldKeyDown}
        disabled={busy}
        rows={4}
        placeholder={t("knowledge.sections.skills.instructionsPlaceholder")}
        aria-label={t("knowledge.sections.skills.instructionsPlaceholder")}
        className="w-full resize-none rounded-md bg-transparent text-sm leading-relaxed text-foreground placeholder:text-muted-foreground focus:outline-none disabled:opacity-50"
      />
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          {t("common.cancel")}
        </Button>
        <Button size="sm" onClick={save} disabled={!canSave} loading={busy}>
          {t("knowledge.sections.skills.save")}
        </Button>
      </div>
    </div>
  );
}

export function SkillsStrip() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  // Agent-side writes land via "skills" topic invalidation; refetches keep
  // the previous data, so the list never blanks under the reader.
  const skillsQuery = useQuery({ queryKey: ["skills"], queryFn: () => api.skills() });
  const skills = skillsQuery.data ?? [];
  const loading = skillsQuery.isPending;
  React.useEffect(() => {
    if (skillsQuery.error) toast.error(skillsQuery.error);
  }, [skillsQuery.error]);
  const [open, setOpen] = React.useState(readSkillsOpen);
  /** "new" for the composer, a skill name for a row in edit mode, null for none. */
  const [editing, setEditing] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [confirmName, setConfirmName] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState(false);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["skills"] });

  React.useEffect(() => {
    try {
      localStorage.setItem(SKILLS_OPEN_KEY, open ? "1" : "0");
    } catch {
      // private mode: the strip just forgets between visits
    }
  }, [open]);

  const save = async (name: string, description: string, instructions: string) => {
    setBusy(true);
    try {
      await api.saveSkill(name, description, instructions);
      setEditing(null);
      await refresh();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (name: string) => {
    setDeleting(true);
    try {
      await api.deleteSkill(name);
      await refresh();
    } catch (err) {
      toast.error(err);
    } finally {
      setDeleting(false);
      setConfirmName(null);
    }
  };

  return (
    <Card as="section" padding="lg" className="flex flex-col gap-4">
      <SectionTitle
        icon={ListChecks}
        tone="tint-accent"
        title={t("knowledge.sections.skills.title")}
        count={loading ? null : skills.length}
        description={open ? t("knowledge.sections.skills.description") : undefined}
      >
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => {
            setOpen(true);
            setEditing("new");
          }}
          aria-label={t("knowledge.sections.skills.add")}
          data-tooltip={t("knowledge.sections.skills.add")}
        >
          <Plus className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls="knowledge-skills-body"
          aria-label={
            open ? t("knowledge.sections.skills.collapse") : t("knowledge.sections.skills.expand")
          }
          data-tooltip={
            open ? t("knowledge.sections.skills.collapse") : t("knowledge.sections.skills.expand")
          }
        >
          <ChevronDown
            className={cn("h-4 w-4 transition-transform duration-200", open && "rotate-180")}
          />
        </Button>
      </SectionTitle>

      <div id="knowledge-skills-body" hidden={!open} className="flex flex-col gap-3">
        {editing === "new" && (
          <SkillEditor
            initial={null}
            busy={busy}
            onSave={(name, description, instructions) => void save(name, description, instructions)}
            onCancel={() => setEditing(null)}
          />
        )}

        {loading ? (
          <div className="flex flex-col gap-2.5" role="status" aria-label={t("common.loading")}>
            <Skeleton className="h-9 w-full rounded-lg" />
            <Skeleton className="h-9 w-full rounded-lg" />
          </div>
        ) : skills.length === 0 ? (
          editing !== "new" && (
            <p className="py-2 text-sm text-muted-foreground">
              {t("knowledge.sections.skills.empty")}
            </p>
          )
        ) : (
          <ul className="flex flex-col gap-0.5">
            {skills.map((skill, i) =>
              editing === skill.name ? (
                <li key={skill.name}>
                  <SkillEditor
                    initial={skill}
                    busy={busy}
                    onSave={(name, description, instructions) =>
                      void save(name, description, instructions)
                    }
                    onCancel={() => setEditing(null)}
                  />
                </li>
              ) : (
                <li key={skill.name} className="animate-in-up" style={stagger(i)}>
                  <div className="group flex items-center gap-3 rounded-lg px-2.5 py-2 transition-colors hover:bg-surface-2">
                    <InlineEditButton
                      onClick={() => setEditing(skill.name)}
                      data-tooltip={t("knowledge.sections.skills.edit")}
                      className="text-sm leading-relaxed"
                    >
                      <span className="font-mono text-xs text-foreground">{skill.name}</span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        {skill.description}
                      </span>
                    </InlineEditButton>
                    <HoverActions>
                      <Button
                        variant="ghost-danger"
                        size="icon-sm"
                        onClick={() => setConfirmName(skill.name)}
                        aria-label={t("knowledge.sections.skills.delete")}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </HoverActions>
                  </div>
                </li>
              ),
            )}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={confirmName !== null}
        onOpenChange={(o) => {
          if (!o) setConfirmName(null);
        }}
        title={t("knowledge.sections.skills.delete")}
        description={t("knowledge.sections.skills.deleteConfirm")}
        confirmLabel={t("knowledge.sections.skills.delete")}
        busy={deleting}
        onConfirm={() => {
          if (confirmName) void remove(confirmName);
        }}
      />
    </Card>
  );
}
