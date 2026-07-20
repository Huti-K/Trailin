import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { type QueryKey, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Automation, Todo } from "@trailin/shared";
import { Check, ChevronRight, Menu, MessageSquareShare, Pencil, X, Zap } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { dueChip } from "@/features/home/agenda";
import { DueDatePicker } from "@/features/home/DueDatePicker";
import { NewDot } from "@/features/home/seen";
import { api } from "@/lib/api";
import { cn, rowTransition, withViewTransition } from "@/lib/utils";

type TodoMutation = {
  id: string;
  patch: Parameters<typeof api.updateTodo>[1];
  optimistic?: (todos: Todo[]) => Todo[];
  /** Cache list the optimistic write targets: the open agenda by default, the done history passes its own key. */
  key?: QueryKey;
};

export type PatchFn = (
  id: string,
  body: Parameters<typeof api.updateTodo>[1],
  optimistic?: (todos: Todo[]) => Todo[],
  key?: QueryKey,
) => void;

/**
 * The one todo mutation: optimistic cache write, rollback on error, and a
 * settle-time invalidate the "todos" server event would also trigger. The
 * invalidate is prefix-keyed on ["todos"], so both the open and done lists
 * reconcile however the status changed.
 */
export function useTodoPatch(): PatchFn {
  const queryClient = useQueryClient();
  const mutate = useMutation({
    mutationFn: ({ id, patch }: TodoMutation) => api.updateTodo(id, patch),
    onMutate: async ({ optimistic, key = ["todos"] }: TodoMutation) => {
      await queryClient.cancelQueries({ queryKey: key });
      const prev = queryClient.getQueryData<Todo[]>(key);
      // The optimistic write is the frame the user sees, so it carries the
      // transition: rows below a completed todo slide up to close the gap.
      if (optimistic) {
        withViewTransition(() =>
          queryClient.setQueryData<Todo[]>(key, (old) => optimistic(old ?? [])),
        );
      }
      return { prev, key };
    },
    onError: (_e, _v, ctx) => ctx?.prev && queryClient.setQueryData(ctx.key, ctx.prev),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["todos"] }),
  });
  return (id, body, optimistic, key) => mutate.mutate({ id, patch: body, optimistic, key });
}

/**
 * One todo: checkbox to complete, expand for the body note, dismiss, drag to
 * reorder/reschedule, pencil to edit title/note/due/linked automation in place
 * (fields save on blur/change — no Save button). A linked automation shows as
 * a bolt: ticking done starts that automation.
 */
export function TodoRow({
  todo,
  overdue,
  lang,
  todayStart,
  onPatch,
  onOpenChat,
  automations,
  isNew,
}: {
  todo: Todo;
  overdue: boolean;
  lang: string;
  todayStart: number;
  onPatch: PatchFn;
  onOpenChat?: () => void;
  /** All automations, for the linked-automation name and the edit-mode picker. */
  automations: Automation[] | null;
  /** Filed since the user last looked — fronts the title with the new dot. */
  isNew?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  // Ticking done plays the strike-wipe, then the patch removes the row; reduced
  // motion skips straight to completion.
  const [completing, setCompleting] = React.useState(false);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: todo.id,
  });
  const style = { transform: CSS.Transform.toString(transform), transition };

  const expandable = !!todo.body;
  const chip = todo.dueAt ? dueChip(todo.dueAt, lang, todayStart, { dayContext: !overdue }) : null;
  const linkedName = todo.linkedAutomationId
    ? (automations?.find((a) => a.id === todo.linkedAutomationId)?.name ??
      t("home.deletedAutomation"))
    : null;

  const completeTodo = () =>
    onPatch(todo.id, { status: "done" }, (list) => list.filter((td) => td.id !== todo.id));
  const startComplete = () => {
    if (completing) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      completeTodo();
      return;
    }
    setCompleting(true);
    window.setTimeout(completeTodo, 450);
  };
  const dismiss = () =>
    onPatch(todo.id, { status: "dismissed" }, (list) => list.filter((td) => td.id !== todo.id));

  const saveTitle = (value: string) => {
    const title = value.trim();
    if (!title || title === todo.title) return;
    onPatch(todo.id, { title }, (list) =>
      list.map((td) => (td.id === todo.id ? { ...td, title } : td)),
    );
  };
  const saveBody = (value: string) => {
    const body = value.trim();
    if (body === todo.body) return;
    onPatch(todo.id, { body }, (list) =>
      list.map((td) => (td.id === todo.id ? { ...td, body } : td)),
    );
  };
  const saveDueAt = (dueAt: string | null) => {
    if (dueAt === todo.dueAt) return;
    onPatch(todo.id, { dueAt }, (list) =>
      list.map((td) => (td.id === todo.id ? { ...td, dueAt } : td)),
    );
  };
  const saveLinked = (linkedAutomationId: string | null) => {
    if (linkedAutomationId === todo.linkedAutomationId) return;
    onPatch(todo.id, { linkedAutomationId }, (list) =>
      list.map((td) => (td.id === todo.id ? { ...td, linkedAutomationId } : td)),
    );
  };

  return (
    <div
      ref={setNodeRef}
      style={{ ...style, ...rowTransition(todo.id) }}
      className={cn("group/todo relative", isDragging && "opacity-50")}
    >
      {/* Drag handle lives in the gutter left of the card, revealed on hover
          (keyboard focus and touch keep it reachable). */}
      <button
        type="button"
        className={cn(
          "absolute -left-6 top-3 cursor-grab touch-none text-muted-foreground/50 hover:text-muted-foreground",
          "opacity-0 transition-opacity focus-visible:opacity-100 group-hover/todo:opacity-100 max-sm:opacity-100",
        )}
        aria-label={t("home.todosReorder")}
        {...attributes}
        {...listeners}
      >
        <Menu className="h-4 w-4" />
      </button>
      <article
        className={cn(
          "surface surface-hover flex flex-col gap-2 rounded-lg px-2.5 py-2.5 transition",
          completing && "opacity-60",
        )}
      >
        <div className="flex items-center gap-2">
          <Checkbox checked={completing} onToggle={startComplete} label={todo.title} />
          {editing ? (
            <Input
              defaultValue={todo.title}
              aria-label={t("home.todosEditTitle")}
              className="h-7 flex-1 px-2 py-0 text-sm font-medium"
              autoFocus
              onBlur={(e) => saveTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
            />
          ) : (
            <button
              type="button"
              className={cn(
                "flex min-w-0 flex-1 items-center gap-2 text-left",
                expandable && "cursor-pointer",
              )}
              onClick={() => expandable && setOpen((v) => !v)}
            >
              {isNew && <NewDot />}
              <span
                className={cn(
                  "truncate text-sm font-medium transition-colors",
                  completing && "todo-strike text-muted-foreground",
                )}
              >
                {todo.title}
              </span>
              {chip?.text && (
                <span
                  className={cn(
                    "shrink-0 text-2xs tabular-nums",
                    chip.overdue ? "font-medium text-warning" : "text-muted-foreground",
                  )}
                >
                  {chip.text}
                </span>
              )}
              {linkedName && (
                <Zap
                  className="h-3.5 w-3.5 shrink-0 text-warning"
                  aria-label={t("home.todosLinkedRun", { name: linkedName })}
                  data-tooltip={t("home.todosLinkedRun", { name: linkedName })}
                />
              )}
            </button>
          )}
          <div className="flex shrink-0 items-center gap-1">
            {onOpenChat && !editing && (
              <Button
                variant="ghost"
                size="icon-xs"
                title={t("home.openInChat")}
                aria-label={t("home.openInChat")}
                onClick={onOpenChat}
              >
                <MessageSquareShare />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon-xs"
              title={t(editing ? "home.todosEditDone" : "home.todosEdit")}
              aria-label={t(editing ? "home.todosEditDone" : "home.todosEdit")}
              onClick={() => setEditing((v) => !v)}
            >
              {editing ? <Check /> : <Pencil />}
            </Button>
            {!editing && (
              <Button
                variant="ghost-danger"
                size="icon-xs"
                title={t("home.todosDismiss")}
                aria-label={t("home.todosDismiss")}
                onClick={dismiss}
              >
                <X />
              </Button>
            )}
            {expandable && !editing && (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-expanded={open}
                title={t(open ? "common.collapse" : "common.expand")}
                aria-label={t(open ? "common.collapse" : "common.expand")}
                onClick={() => setOpen((v) => !v)}
              >
                <ChevronRight className={cn("transition-transform", open && "rotate-90")} />
              </Button>
            )}
          </div>
        </div>

        {editing ? (
          <div className="flex flex-col gap-2 pl-8">
            <div className="flex flex-wrap items-center gap-2">
              <DueDatePicker dueAt={todo.dueAt} lang={lang} onChange={saveDueAt} />
              <div className="flex items-center gap-1.5">
                <Zap className="h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
                <Select
                  id={`todo-link-${todo.id}`}
                  value={todo.linkedAutomationId ?? ""}
                  onChange={(v) => saveLinked(v || null)}
                  aria-label={t("home.todosLinkedLabel")}
                  className="w-auto"
                  options={[
                    { value: "", label: t("home.todosLinkedNone") },
                    ...(automations ?? []).map((a) => ({ value: a.id, label: a.name })),
                  ]}
                />
              </div>
            </div>
            <Textarea
              defaultValue={todo.body}
              placeholder={t("home.todosBodyPlaceholder")}
              className="field-sizing-content resize-none text-sm"
              onBlur={(e) => saveBody(e.target.value)}
            />
          </div>
        ) : (
          open &&
          expandable && (
            <p className="whitespace-pre-wrap pl-8 text-sm text-muted-foreground">{todo.body}</p>
          )
        )}
      </article>
    </div>
  );
}

/** A completed todo in the collapsed history: a filled check to reopen it (back
 *  onto the agenda), title struck through. */
export function DoneTodoRow({ todo, onRestore }: { todo: Todo; onRestore: () => void }) {
  const { t } = useTranslation();
  return (
    <article className="surface surface-hover flex items-center gap-2 rounded-lg px-2.5 py-2">
      <Checkbox checked onToggle={onRestore} label={t("home.todosRestore")} />
      <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground line-through">
        {todo.title}
      </span>
    </article>
  );
}

function Checkbox({
  checked,
  onToggle,
  label,
}: {
  checked: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <label className="group flex h-5 shrink-0 cursor-pointer items-center">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        aria-label={label}
        className="peer sr-only"
      />
      <span
        className={cn(
          "flex h-[18px] w-[18px] items-center justify-center rounded transition-colors",
          "peer-focus-visible:ring-2 peer-focus-visible:ring-ring",
          checked
            ? "bg-accent text-accent-foreground"
            : "bg-surface-2 text-muted-foreground/35 group-hover:text-muted-foreground",
        )}
      >
        <Check className={cn("h-3 w-3", checked && "check-pop")} strokeWidth={3} />
      </span>
    </label>
  );
}
