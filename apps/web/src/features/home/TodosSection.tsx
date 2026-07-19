import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Automation, Todo, TodoStep } from "@trailin/shared";
import { Check, Clock, ListTodo, MessageSquareShare, TriangleAlert, X } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { GroupLabel } from "@/components/ui/group-label";
import { SectionTitle } from "@/components/ui/section-header";
import { api } from "@/lib/api";
import { dayLabel, timeLabel } from "@/lib/dates";
import type { View } from "@/lib/nav";
import { openConversationInChat } from "@/lib/quickActions";
import { cn, stagger } from "@/lib/utils";

const DAY_MS = 86_400_000;
/** Automations recur, so only surface their next run within a near horizon; a dated todo shows however far out it is. */
const AUTOMATION_HORIZON_DAYS = 14;

function startOfDayMs(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** A date-only ISO ("2026-07-24") anchors to local midnight and shows no clock; a date-time keeps its time. */
function parseDue(iso: string): { at: Date; dateOnly: boolean } {
  const trimmed = iso.trim();
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(trimmed);
  return { at: new Date(dateOnly ? `${trimmed}T00:00:00` : trimmed), dateOnly };
}

type TodoSlot = { kind: "todo"; at: Date | null; dateOnly: boolean; todo: Todo };
type AutoSlot = { kind: "auto"; at: Date; automation: Automation };

/**
 * "Needs you" — an agenda of the todos the agent filed, grouped by due date
 * (missed at the top, then by day) with the next scheduled automation runs
 * interleaved so the user sees what is coming. Undated todos land in "Anytime".
 * Todos mutate optimistically; the "todos" server event reconciles the cache.
 */
export function TodosSection({
  automations,
  onNavigate,
}: {
  automations: Automation[] | null;
  onNavigate: (view: View) => void;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = React.useState(true);
  const todosQuery = useQuery({ queryKey: ["todos"], queryFn: () => api.todos("open") });

  const patchCache = (next: (todos: Todo[]) => Todo[]) => {
    const prev = queryClient.getQueryData<Todo[]>(["todos"]);
    queryClient.setQueryData<Todo[]>(["todos"], (old) => next(old ?? []));
    return prev;
  };

  const toggleStep = useMutation({
    mutationFn: ({ todo, step }: { todo: Todo; step: TodoStep }) =>
      api.updateTodo(
        todo.id,
        step.done ? { reopenSteps: [step.id] } : { completeSteps: [step.id] },
      ),
    onMutate: async ({ todo, step }) => {
      await queryClient.cancelQueries({ queryKey: ["todos"] });
      return {
        prev: patchCache((todos) =>
          todos.map((row) =>
            row.id === todo.id
              ? {
                  ...row,
                  steps: row.steps.map((s) => (s.id === step.id ? { ...s, done: !s.done } : s)),
                }
              : row,
          ),
        ),
      };
    },
    onError: (_e, _v, ctx) => ctx?.prev && queryClient.setQueryData(["todos"], ctx.prev),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["todos"] }),
  });

  const dismiss = useMutation({
    mutationFn: (id: string) => api.updateTodo(id, { status: "dismissed" }),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: ["todos"] });
      return { prev: patchCache((todos) => todos.filter((row) => row.id !== id)) };
    },
    onError: (_e, _id, ctx) => ctx?.prev && queryClient.setQueryData(["todos"], ctx.prev),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["todos"] }),
  });

  const todos = todosQuery.data ?? [];
  const todayStart = startOfDayMs(new Date());

  const todoSlots: TodoSlot[] = todos.map((todo) => {
    if (!todo.dueAt) return { kind: "todo", at: null, dateOnly: false, todo };
    const { at, dateOnly } = parseDue(todo.dueAt);
    return { kind: "todo", at, dateOnly, todo };
  });

  const autoSlots: AutoSlot[] = (automations ?? [])
    .filter((a) => a.enabled && a.nextRunAt)
    .map((a) => ({ kind: "auto" as const, at: new Date(a.nextRunAt as string), automation: a }))
    .filter((s) => startOfDayMs(s.at) < todayStart + AUTOMATION_HORIZON_DAYS * DAY_MS);

  const overdue = todoSlots
    .filter((s): s is TodoSlot & { at: Date } => !!s.at && startOfDayMs(s.at) < todayStart)
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  const undated = todoSlots.filter((s) => !s.at);
  const dated = [
    ...todoSlots.filter(
      (s): s is TodoSlot & { at: Date } => !!s.at && startOfDayMs(s.at) >= todayStart,
    ),
    ...autoSlots,
  ].sort((a, b) => a.at.getTime() - b.at.getTime());

  // Split the chronological stream into consecutive same-day groups.
  const days: { key: number; slots: ((TodoSlot & { at: Date }) | AutoSlot)[] }[] = [];
  for (const slot of dated) {
    const key = startOfDayMs(slot.at);
    const last = days.at(-1);
    if (last?.key === key) last.slots.push(slot);
    else days.push({ key, slots: [slot] });
  }

  // Nothing filed and nothing scheduled — keep Home uncluttered.
  if (todos.length === 0 && autoSlots.length === 0) return null;

  const dayHeading = (key: number): string => {
    if (key === todayStart) return t("home.todosToday");
    if (key === todayStart + DAY_MS) return t("home.todosTomorrow");
    return dayLabel(new Date(key).toISOString(), lang);
  };

  const overdueLabel = (slot: TodoSlot & { at: Date }): string => {
    const date = slot.at.toLocaleDateString(lang, {
      weekday: "short",
      day: "numeric",
      month: "short",
    });
    return slot.dateOnly ? date : `${date}, ${timeLabel(slot.at.toISOString(), lang)}`;
  };

  const renderTodo = (todo: Todo, index: number, dueLabel?: string, overdueItem?: boolean) => (
    <TodoCard
      key={todo.id}
      todo={todo}
      index={index}
      dueLabel={dueLabel}
      overdue={overdueItem}
      onToggleStep={(step) => toggleStep.mutate({ todo, step })}
      onDismiss={() => dismiss.mutate(todo.id)}
      onOpenChat={
        todo.conversationId
          ? () => openConversationInChat(todo.conversationId as string, () => onNavigate("chat"))
          : undefined
      }
    />
  );

  return (
    <section className="flex flex-col gap-3">
      <SectionTitle
        icon={ListTodo}
        title={t("home.todosTitle")}
        count={todos.length}
        expanded={expanded}
        onToggle={() => setExpanded((v) => !v)}
      />
      {expanded && (
        <div className="flex flex-col gap-6">
          {overdue.length > 0 && (
            <div className="flex flex-col gap-3">
              <GroupLabel className="flex items-center gap-1.5 text-warning">
                <TriangleAlert className="h-3.5 w-3.5" />
                {t("home.todosOverdue")}
              </GroupLabel>
              {overdue.map((s, i) => renderTodo(s.todo, i, overdueLabel(s), true))}
            </div>
          )}

          {days.map(({ key, slots }) => (
            <div key={key} className="flex flex-col gap-3">
              <GroupLabel>{dayHeading(key)}</GroupLabel>
              {slots.map((s, i) =>
                s.kind === "todo" ? (
                  renderTodo(
                    s.todo,
                    i,
                    s.dateOnly ? undefined : timeLabel(s.at.toISOString(), lang),
                  )
                ) : (
                  <AutomationRow
                    key={s.automation.id}
                    automation={s.automation}
                    at={s.at}
                    lang={lang}
                  />
                ),
              )}
            </div>
          ))}

          {undated.length > 0 && (
            <div className="flex flex-col gap-3">
              <GroupLabel>{t("home.todosAnytime")}</GroupLabel>
              {undated.map((s, i) => renderTodo(s.todo, i))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function AutomationRow({
  automation,
  at,
  lang,
}: {
  automation: Automation;
  at: Date;
  lang: string;
}) {
  return (
    <div className="flex items-center gap-2 px-1 text-sm text-muted-foreground">
      <Clock className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 truncate text-foreground/80">{automation.name}</span>
      <span className="ml-auto shrink-0 text-xs tabular-nums">
        {timeLabel(at.toISOString(), lang)}
      </span>
    </div>
  );
}

function TodoCard({
  todo,
  index,
  dueLabel,
  overdue,
  onToggleStep,
  onDismiss,
  onOpenChat,
}: {
  todo: Todo;
  index: number;
  dueLabel?: string;
  overdue?: boolean;
  onToggleStep: (step: TodoStep) => void;
  onDismiss: () => void;
  onOpenChat?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <article
      className="surface animate-in-up flex flex-col gap-3 rounded-lg p-4"
      style={stagger(index)}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <p className="text-sm font-medium">{todo.title}</p>
            {dueLabel && (
              <span
                className={cn(
                  "text-2xs tabular-nums",
                  overdue ? "font-medium text-warning" : "text-muted-foreground",
                )}
              >
                {dueLabel}
              </span>
            )}
          </div>
          {todo.body && (
            <p className="whitespace-pre-wrap text-sm text-muted-foreground">{todo.body}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {onOpenChat && (
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
            variant="ghost-danger"
            size="icon-xs"
            title={t("home.todosDismiss")}
            aria-label={t("home.todosDismiss")}
            onClick={onDismiss}
          >
            <X />
          </Button>
        </div>
      </div>

      {todo.steps.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {todo.steps.map((step) => (
            <li key={step.id}>
              <label className="group flex w-full cursor-pointer items-start gap-2.5 text-sm">
                <input
                  type="checkbox"
                  checked={step.done}
                  onChange={() => onToggleStep(step)}
                  className="peer sr-only"
                />
                <span
                  className={cn(
                    "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded transition-colors",
                    "peer-focus-visible:ring-2 peer-focus-visible:ring-ring",
                    step.done
                      ? "bg-accent text-accent-foreground"
                      : "bg-surface-2 text-transparent group-hover:text-muted-foreground",
                  )}
                >
                  <Check className="h-3 w-3" strokeWidth={3} />
                </span>
                <span className={cn(step.done && "text-muted-foreground line-through")}>
                  {step.label}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
