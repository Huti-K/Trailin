import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import type { AccountColor, AccountDrafts, Automation, EmailDraft, Todo } from "@marlen/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronRight,
  CircleCheck,
  Clock,
  ListTodo,
  Plus,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { AccountDot } from "@/components/ui/account-dot";
import { Button } from "@/components/ui/button";
import { DisclosureToggle } from "@/components/ui/disclosure-toggle";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorBanner, LoadingRow } from "@/components/ui/feedback";
import { GroupLabel } from "@/components/ui/group-label";
import { IconChip } from "@/components/ui/icon-chip";
import { Input } from "@/components/ui/input";
import { SectionTitle } from "@/components/ui/section-header";
import { Select } from "@/components/ui/select";
import { DraftRow } from "@/features/drafts/DraftRow";
import { DAY_MS, dayIso, dueMs, startOfDayMs } from "@/features/home/agenda";
import { OutboundRow } from "@/features/home/OutboundRow";
import {
  draftSeenKey,
  outboundSeenKey,
  type Seen,
  SeenOnInteract,
  todoSeenKey,
} from "@/features/home/seen";
import { DoneTodoRow, TodoRow, useTodoPatch } from "@/features/home/TodoRow";
import { accountColor } from "@/lib/accounts";
import { api } from "@/lib/api";
import { dateTimeLabel, dayLabel, timeLabel } from "@/lib/dates";
import type { View } from "@/lib/nav";
import { openConversationInChat } from "@/lib/quickActions";
import { cn, errorMessage, midpoint, stagger } from "@/lib/utils";

const AUTOMATION_HORIZON_DAYS = 14;
const OVERDUE = "overdue";
const ANYTIME = "anytime";
const dayGroupId = (ms: number) => `day:${ms}`;

/** Draft rows shown per account before the disclosure unfolds the rest. */
const DRAFTS_VISIBLE = 4;

type Group = {
  id: string;
  heading: string;
  overdue: boolean;
  droppable: boolean;
  /** The sortable todos, in display order. */
  todos: Todo[];
  /** Read-only automation rows (day groups only), pre-merged for render order. */
  render: RenderItem[];
};
type RenderItem =
  | { kind: "todo"; at: number; todo: Todo }
  | { kind: "auto"; at: number; automation: Automation };

/**
 * "Zu erledigen" — the one agenda of everything on your plate: overdue todos,
 * every draft awaiting approval (email and outbound channels), then the days
 * ahead — dated todos with the next scheduled automation runs interleaved
 * read-only — and undated todos last. Drag a todo onto another day to
 * reschedule, or onto "Anytime" to undate it; mutations are optimistic and
 * the "todos" server event reconciles the cache.
 */
export function AttentionSection({
  automations,
  drafts,
  colors,
  focusDraft,
  onDraftsChanged,
  onNavigate,
  seen,
}: {
  automations: Automation[] | null;
  /** Email provider drafts; null while the (slow, live-mailbox) fetch is in flight. */
  drafts: AccountDrafts[] | null;
  colors: AccountColor[];
  /** A draft opened via the search palette — expand and unfold so it's visible. */
  focusDraft?: { accountId: string; draftId: string } | null;
  /** A draft row was sent/discarded/saved: refresh the drafts list without waiting on the event debounce. */
  onDraftsChanged: () => void;
  onNavigate: (view: View) => void;
  seen: Seen;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [expanded, setExpanded] = React.useState(true);
  const [adding, setAdding] = React.useState(false);
  const [showDone, setShowDone] = React.useState(false);
  /** Account id, or "all" — narrows the approvals block only. */
  const [accountFilter, setAccountFilter] = React.useState("all");
  const [rowError, setRowError] = React.useState<string | null>(null);

  const todosQuery = useQuery({ queryKey: ["todos"], queryFn: () => api.todos("open") });
  const doneQuery = useQuery({ queryKey: ["todos", "done"], queryFn: () => api.todos("done") });
  const outboundQuery = useQuery({
    queryKey: ["outbound", "open"],
    queryFn: () => api.outbound("open"),
  });
  const suggestionsQuery = useQuery({
    queryKey: ["automations", "suggestions"],
    queryFn: () => api.automationSuggestions(),
  });
  const patch = useTodoPatch();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  React.useEffect(() => {
    if (!focusDraft) return;
    setExpanded(true);
    setAccountFilter("all");
  }, [focusDraft]);

  const todos = todosQuery.data ?? [];
  // Most-recently completed first; reopening returns a todo to the open agenda.
  const done = [...(doneQuery.data ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const restoreTodo = (id: string) =>
    patch(id, { status: "open" }, (list) => list.filter((td) => td.id !== id), ["todos", "done"]);
  const todayStart = startOfDayMs(new Date());

  // Partition todos into overdue / dated-by-day / anytime.
  const overdueTodos = todos
    .filter((td) => {
      const at = dueMs(td);
      return at !== null && startOfDayMs(new Date(at)) < todayStart;
    })
    .sort((a, b) => (dueMs(a) as number) - (dueMs(b) as number));
  const anytimeTodos = todos.filter((td) => dueMs(td) === null);
  const datedTodos = todos.filter((td) => {
    const at = dueMs(td);
    return at !== null && startOfDayMs(new Date(at)) >= todayStart;
  });

  const upcomingAutos = (automations ?? [])
    .filter((a) => a.enabled && a.nextRunAt)
    .map((a) => ({ automation: a, at: new Date(a.nextRunAt as string).getTime() }))
    .filter((a) => a.at < todayStart + AUTOMATION_HORIZON_DAYS * DAY_MS);

  // Day buckets keyed by local day-start ms, holding the day's todos + automations.
  const dayKeys = new Set<number>();
  for (const td of datedTodos) dayKeys.add(startOfDayMs(new Date(dueMs(td) as number)));
  for (const a of upcomingAutos) dayKeys.add(startOfDayMs(new Date(a.at)));

  const dayHeading = (ms: number): string => {
    if (ms === todayStart) return t("home.todosToday");
    if (ms === todayStart + DAY_MS) return t("home.todosTomorrow");
    return dayLabel(new Date(ms).toISOString(), lang);
  };

  const groups: Group[] = [];
  if (overdueTodos.length > 0) {
    groups.push({
      id: OVERDUE,
      heading: t("home.todosOverdue"),
      overdue: true,
      droppable: false,
      todos: overdueTodos,
      render: overdueTodos.map((td) => ({ kind: "todo", at: dueMs(td) as number, todo: td })),
    });
  }
  for (const ms of [...dayKeys].sort((a, b) => a - b)) {
    const dayTodos = datedTodos
      .filter((td) => startOfDayMs(new Date(dueMs(td) as number)) === ms)
      .sort((a, b) => (dueMs(a) as number) - (dueMs(b) as number));
    const render: RenderItem[] = [
      ...dayTodos.map((td) => ({ kind: "todo" as const, at: dueMs(td) as number, todo: td })),
      ...upcomingAutos
        .filter((a) => startOfDayMs(new Date(a.at)) === ms)
        .map((a) => ({ kind: "auto" as const, at: a.at, automation: a.automation })),
    ].sort((a, b) => a.at - b.at);
    groups.push({
      id: dayGroupId(ms),
      heading: dayHeading(ms),
      overdue: false,
      droppable: true,
      todos: dayTodos,
      render,
    });
  }
  if (anytimeTodos.length > 0) {
    groups.push({
      id: ANYTIME,
      heading: t("home.todosAnytime"),
      overdue: false,
      droppable: true,
      todos: anytimeTodos,
      render: anytimeTodos.map((td) => ({ kind: "todo", at: 0, todo: td })),
    });
  }

  const outbound = outboundQuery.data ?? [];
  const emailGroups = drafts ?? [];
  const visibleEmailGroups = emailGroups
    .filter((a) => accountFilter === "all" || a.accountId === accountFilter)
    .filter((a) => a.drafts.length > 0 || a.error);
  const approvalsCount = outbound.length + emailGroups.reduce((n, a) => n + a.drafts.length, 0);
  const hasApprovals = approvalsCount > 0 || drafts === null || emailGroups.some((a) => a.error);
  // With one mailbox connected a color says nothing, so the dots and the filter
  // that reads as their legend both appear only from the second one on.
  const manyAccounts = emailGroups.length > 1;

  const dateLabel = (iso: string) => dateTimeLabel(iso, lang);

  const suggestions = suggestionsQuery.data ?? [];
  const count = todos.length + approvalsCount + suggestions.length;
  const loaded = !!todosQuery.data && drafts !== null && !!outboundQuery.data;
  const allClear =
    loaded && count === 0 && upcomingAutos.length === 0 && !emailGroups.some((a) => a.error);

  const groupOfTodo = new Map<string, Group>();
  for (const g of groups) for (const td of g.todos) groupOfTodo.set(td.id, g);
  const groupById = new Map(groups.map((g) => [g.id, g]));

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over) return;
    const activeId = String(active.id);
    const src = groupOfTodo.get(activeId);
    if (!src) return;
    const overId = String(over.id);
    const dst = groupById.get(overId) ?? groupOfTodo.get(overId);
    if (!dst?.droppable) return;

    const overTodo = groupOfTodo.get(overId) ? overId : null;
    const dropIndex = overTodo ? dst.todos.findIndex((td) => td.id === overTodo) : dst.todos.length;

    if (dst.id === ANYTIME) {
      // Reorder within / move into Anytime: clear any date, land at the drop slot.
      const others = dst.todos.filter((td) => td.id !== activeId);
      const pos = midpoint(others[dropIndex - 1]?.position, others[dropIndex]?.position);
      patch(activeId, { dueAt: null, position: pos }, (list) =>
        list.map((td) => (td.id === activeId ? { ...td, dueAt: null, position: pos } : td)),
      );
      return;
    }
    if (src.id === dst.id) return; // within a dated day: time-ordered, nothing to persist.
    // Reschedule onto another day.
    const iso = dayIso(Number(dst.id.slice(4)));
    patch(activeId, { dueAt: iso }, (list) =>
      list.map((td) => (td.id === activeId ? { ...td, dueAt: iso } : td)),
    );
  };

  const renderGroup = (group: Group) => (
    <GroupBlock key={group.id} group={group}>
      <SortableContext
        items={group.todos.map((td) => td.id)}
        strategy={verticalListSortingStrategy}
      >
        {group.render.map((item) =>
          item.kind === "todo" ? (
            <SeenOnInteract
              key={item.todo.id}
              seen={seen}
              itemKey={todoSeenKey(item.todo.id)}
              createdAt={item.todo.createdAt}
            >
              {(isNew) => (
                <TodoRow
                  todo={item.todo}
                  overdue={group.overdue}
                  lang={lang}
                  todayStart={todayStart}
                  onPatch={patch}
                  automations={automations}
                  isNew={isNew}
                  onOpenChat={
                    item.todo.conversationId
                      ? () =>
                          openConversationInChat(item.todo.conversationId as string, () =>
                            onNavigate("chat"),
                          )
                      : undefined
                  }
                />
              )}
            </SeenOnInteract>
          ) : (
            <AutomationRow
              key={item.automation.id}
              automation={item.automation}
              at={item.at}
              lang={lang}
            />
          ),
        )}
      </SortableContext>
    </GroupBlock>
  );

  // One flat list of approvals: every row already names its own channel and
  // recipient, so the zone needs no per-channel or per-account heading — the
  // account chips carry the colors, and each row wears the matching dot.
  const approvalsZone = hasApprovals && (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <GroupLabel>{t("home.approvalsGroup")}</GroupLabel>
        {manyAccounts && (
          <Select
            id="draft-account"
            value={accountFilter}
            onChange={setAccountFilter}
            aria-label={t("home.approvalsFilterAccount")}
            className="ml-auto w-auto max-w-64"
            options={[
              { value: "all", label: t("home.approvalsAllAccounts") },
              // The dot per option is the legend for the dots the rows wear.
              ...emailGroups.map((a) => ({
                value: a.accountId,
                label: a.account,
                mark: (
                  <AccountDot color={accountColor(colors, a.accountId)} className="mr-2 h-2 w-2" />
                ),
              })),
            ]}
          />
        )}
      </div>
      {drafts === null ? (
        <LoadingRow />
      ) : (
        <div className="flex flex-col gap-2">
          {accountFilter === "all" &&
            outbound.map((draft, i) => (
              <SeenOnInteract
                key={draft.id}
                seen={seen}
                itemKey={outboundSeenKey(draft.id)}
                createdAt={draft.createdAt}
                className="animate-in-up"
                style={stagger(i)}
              >
                {(isNew) => (
                  <OutboundRow
                    draft={draft}
                    dateLabel={dateLabel}
                    isNew={isNew}
                    onChanged={() => void queryClient.invalidateQueries({ queryKey: ["outbound"] })}
                    onError={setRowError}
                  />
                )}
              </SeenOnInteract>
            ))}
          {visibleEmailGroups.map((account) => (
            <AccountDraftGroup
              key={account.accountId}
              account={account}
              color={accountColor(colors, account.accountId)}
              markAccount={manyAccounts}
              dateLabel={dateLabel}
              focusDraft={focusDraft?.accountId === account.accountId ? focusDraft : null}
              onChanged={onDraftsChanged}
              onError={setRowError}
              seen={seen}
            />
          ))}
        </div>
      )}
    </div>
  );

  return (
    <section className="flex flex-col gap-3">
      <SectionTitle
        icon={ListTodo}
        tone="tint-neutral"
        title={t("home.attentionTitle")}
        count={loaded ? count : null}
        expanded={expanded}
        onToggle={() => setExpanded((v) => !v)}
      >
        <Button
          variant="ghost"
          size="icon-xs"
          title={t("home.todosAdd")}
          aria-label={t("home.todosAdd")}
          onClick={() => {
            setAdding((v) => (expanded ? !v : true));
            setExpanded(true);
          }}
        >
          <Plus />
        </Button>
      </SectionTitle>
      {expanded && (
        <>
          {rowError && <ErrorBanner>{rowError}</ErrorBanner>}
          {!todosQuery.data && <LoadingRow />}
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <div className="flex flex-col gap-6">
              {groups.filter((g) => g.overdue).map(renderGroup)}
              {suggestions.length > 0 && (
                <button
                  type="button"
                  // Router state (not onNavigate) so the panel can flash the cards on arrival.
                  onClick={() => navigate("/automations", { state: { focusSuggestions: true } })}
                  className="surface surface-hover flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm"
                >
                  <IconChip size="sm">
                    <Sparkles />
                  </IconChip>
                  <span className="min-w-0 truncate">
                    {t("home.suggestionsWaiting", { count: suggestions.length })}
                  </span>
                  <ChevronRight className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                </button>
              )}
              {approvalsZone}
              {groups.filter((g) => !g.overdue).map(renderGroup)}
              {adding && (
                <AddTodoRow seen={seen} onClose={() => setAdding(false)} onError={setRowError} />
              )}
              {allClear && !adding && (
                <EmptyState icon={CircleCheck} description={t("home.attentionEmpty")} />
              )}
            </div>
          </DndContext>
          {done.length > 0 && (
            <div className="flex flex-col gap-2">
              <DisclosureToggle open={showDone} onToggle={() => setShowDone((v) => !v)}>
                {t("home.todosDone", { count: done.length })}
              </DisclosureToggle>
              {showDone && (
                <div className="flex flex-col gap-2">
                  {done.map((td, i) => (
                    <div key={td.id} className="animate-in-up" style={stagger(i)}>
                      <DoneTodoRow todo={td} onRestore={() => restoreTodo(td.id)} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

/**
 * The manual add row, revealed by the header's plus: Enter files an anytime
 * todo and keeps the field open for the next one; Escape or leaving it empty
 * closes it. Details (date, note, link) are edited on the created row.
 */
function AddTodoRow({
  seen,
  onClose,
  onError,
}: {
  seen: Seen;
  onClose: () => void;
  onError: (message: string | null) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [title, setTitle] = React.useState("");
  const create = useMutation({
    mutationFn: (title: string) => api.createTodo({ title }),
    onSuccess: (todo) => {
      // The user filed this one themselves, so it never wears the new dot.
      seen.see(todoSeenKey(todo.id));
      void queryClient.invalidateQueries({ queryKey: ["todos"] });
    },
    onError: (e) => onError(errorMessage(e)),
  });

  const submit = () => {
    const trimmed = title.trim();
    if (!trimmed) {
      onClose();
      return;
    }
    create.mutate(trimmed);
    setTitle("");
  };

  return (
    <form
      className="animate-in-up"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={t("home.todosAddPlaceholder")}
        aria-label={t("home.todosAdd")}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
        onBlur={() => {
          if (!title.trim()) onClose();
        }}
      />
    </form>
  );
}

/** One email account's drafts: capped rows behind a disclosure. */
function AccountDraftGroup({
  account,
  color,
  markAccount,
  dateLabel,
  focusDraft,
  onChanged,
  onError,
  seen,
}: {
  account: AccountDrafts;
  color?: string;
  /** Marks each row with this account's dot — set only when the list holds more than one inbox. */
  markAccount: boolean;
  dateLabel: (iso: string) => string;
  /** Set when the palette targeted a draft in THIS account — unfold and expand it. */
  focusDraft: { accountId: string; draftId: string } | null;
  onChanged: () => void;
  onError: (message: string | null) => void;
  seen: Seen;
}) {
  const { t } = useTranslation();
  const [showAll, setShowAll] = React.useState(false);

  React.useEffect(() => {
    if (focusDraft) setShowAll(true);
  }, [focusDraft]);

  const visible = showAll ? account.drafts : account.drafts.slice(0, DRAFTS_VISIBLE);
  const hidden = account.drafts.length - visible.length;

  return (
    <div className="flex flex-col gap-2">
      {account.error ? (
        <ErrorBanner>{account.error}</ErrorBanner>
      ) : (
        <div className="flex flex-col gap-2">
          {visible.map((draft: EmailDraft, i: number) => (
            <SeenOnInteract
              key={draft.id}
              seen={seen}
              itemKey={draftSeenKey(account.accountId, draft.id)}
              createdAt={draft.date}
              className="animate-in-up"
              style={stagger(i)}
            >
              {(isNew) => (
                <DraftRow
                  accountId={account.accountId}
                  account={markAccount ? { name: account.account, color } : undefined}
                  draft={draft}
                  dateLabel={dateLabel}
                  onDeleted={onChanged}
                  onSaved={onChanged}
                  onError={onError}
                  forceOpen={focusDraft?.draftId === draft.id}
                  isNew={isNew}
                />
              )}
            </SeenOnInteract>
          ))}
          {account.drafts.length > DRAFTS_VISIBLE && (
            <DisclosureToggle open={showAll} onToggle={() => setShowAll((v) => !v)}>
              {showAll ? t("home.showLess") : t("home.approvalsShowMore", { count: hidden })}
            </DisclosureToggle>
          )}
        </div>
      )}
    </div>
  );
}

function GroupBlock({ group, children }: { group: Group; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: group.id, disabled: !group.droppable });
  return (
    <div ref={setNodeRef} className={cn("flex flex-col gap-2 rounded-lg", isOver && "bg-accent/5")}>
      <GroupLabel className={cn("flex items-center gap-1.5", group.overdue && "text-warning")}>
        {group.overdue && <TriangleAlert className="h-3.5 w-3.5" />}
        {group.heading}
      </GroupLabel>
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  );
}

/** A scheduled run in the agenda: a real (raised) row so it reads as an item,
 *  kept secondary through muted content. Clicking jumps to the Automations
 *  page, which scrolls to and flashes this automation's card. */
function AutomationRow({
  automation,
  at,
  lang,
}: {
  automation: Automation;
  at: number;
  lang: string;
}) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => navigate("/automations", { state: { focusAutomation: automation.id } })}
      className="surface surface-hover flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-muted-foreground"
    >
      <Clock className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 truncate text-foreground/80">{automation.name}</span>
      <span className="ml-auto shrink-0 text-xs tabular-nums">
        {timeLabel(new Date(at).toISOString(), lang)}
      </span>
    </button>
  );
}
