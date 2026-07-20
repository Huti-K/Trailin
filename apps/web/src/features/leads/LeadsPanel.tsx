import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Automation, Lead, LeadPriority, LeadStatus } from "@trailin/shared";
import {
  CalendarClock,
  Check,
  ChevronRight,
  Pencil,
  Phone,
  Plus,
  Trash2,
  Users,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { FormField } from "@/components/ui/form-field";
import { HoverActions } from "@/components/ui/hover-actions";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { relativeTime } from "@/lib/dates";
import { toast } from "@/lib/toast";
import { cn, stagger } from "@/lib/utils";

/**
 * The leads directory: every prospect the agent (or the user) recorded, as a
 * flat list of raised rows — status/priority filter chips on top, and per-row
 * edit-in-place (pencil; fields save on blur/change, no Save button). Rows
 * appear and update live: intake runs and the agent's lead tools emit the
 * "leads" server event.
 */

const STATUSES: LeadStatus[] = ["new", "contacted", "engaged", "qualified", "won", "lost"];

/** Pastel status → tone mapping: attention on "new", success once they replied. */
const STATUS_TONE: Record<LeadStatus, "default" | "muted" | "success" | "warning" | "destructive"> =
  {
    new: "warning",
    contacted: "muted",
    engaged: "success",
    qualified: "default",
    won: "success",
    lost: "muted",
  };

/** Priority tier A/B/C, brightest on "A" so the hot leads pop. */
const PRIORITIES = ["A", "B", "C"] as const satisfies readonly LeadPriority[];
const PRIORITY_TONE: Record<(typeof PRIORITIES)[number], "default" | "muted" | "success"> = {
  A: "success",
  B: "default",
  C: "muted",
};

const EMPTY_FORM = { email: "", name: "", phone: "", interest: "", notes: "" };

type LeadPatch = Parameters<typeof api.updateLead>[1];

/**
 * The one lead mutation: optimistic cache write, rollback + toast on error,
 * and a settle-time invalidate the "leads" server event would also trigger.
 */
function useLeadPatch(): (id: string, patch: LeadPatch) => void {
  const queryClient = useQueryClient();
  const mutate = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: LeadPatch }) => api.updateLead(id, patch),
    onMutate: async ({ id, patch }) => {
      await queryClient.cancelQueries({ queryKey: ["leads"] });
      const prev = queryClient.getQueryData<Lead[]>(["leads"]);
      queryClient.setQueryData<Lead[]>(["leads"], (old) =>
        (old ?? []).map((lead) => (lead.id === id ? { ...lead, ...patch } : lead)),
      );
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(["leads"], ctx.prev);
      toast.error(err);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["leads"] }),
  });
  return (id, patch) => mutate.mutate({ id, patch });
}

export function LeadsPanel() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  // Server-side changes (intake runs, agent lead tools) land via topic
  // invalidation; refetches keep previous data, so open rows keep their state.
  const leadsQuery = useQuery({ queryKey: ["leads"], queryFn: () => api.leads() });
  const automationsQuery = useQuery({
    queryKey: ["automations", "list"],
    queryFn: () => api.automations(),
  });
  const leads = leadsQuery.data ?? [];
  const automations = automationsQuery.data ?? [];
  const loading = leadsQuery.isPending || automationsQuery.isPending;
  const loadError = leadsQuery.error ?? automationsQuery.error;
  React.useEffect(() => {
    if (loadError) toast.error(loadError);
  }, [loadError]);
  const [filter, setFilter] = React.useState<LeadStatus | null>(null);
  const [priorityFilter, setPriorityFilter] = React.useState<(typeof PRIORITIES)[number] | null>(
    null,
  );
  const [showForm, setShowForm] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [form, setForm] = React.useState(EMPTY_FORM);
  const [confirmDelete, setConfirmDelete] = React.useState<Lead | null>(null);
  const onPatch = useLeadPatch();

  const load = () => queryClient.invalidateQueries({ queryKey: ["leads"] });

  const visible = leads
    .filter((lead) => (filter ? lead.status === filter : true))
    .filter((lead) => (priorityFilter ? lead.priority === priorityFilter : true));
  const attachedTo = (lead: Lead) => automations.filter((a) => a.leadId === lead.id);

  const create = async () => {
    setSaving(true);
    try {
      const { created } = await api.recordLead({
        email: form.email,
        name: form.name || undefined,
        phone: form.phone || undefined,
        interest: form.interest || undefined,
        notes: form.notes || undefined,
      });
      if (!created) toast.info(t("leads.mergedNote", { email: form.email }));
      setShowForm(false);
      setForm(EMPTY_FORM);
      await load();
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (lead: Lead) => {
    try {
      await api.deleteLead(lead.id);
      setConfirmDelete(null);
      await load();
    } catch (err) {
      toast.error(err);
    }
  };

  return (
    <div className="flex flex-col gap-4 pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          <Chip active={filter === null} onClick={() => setFilter(null)}>
            {t("leads.filters.all")}
          </Chip>
          {STATUSES.map((status) => (
            <Chip
              key={status}
              active={filter === status}
              onClick={() => setFilter(filter === status ? null : status)}
            >
              {t(`leads.status.${status}`)}
            </Chip>
          ))}
          {PRIORITIES.map((priority) => (
            <Chip
              key={priority}
              active={priorityFilter === priority}
              onClick={() => setPriorityFilter(priorityFilter === priority ? null : priority)}
            >
              {t(`leads.priority.${priority}`)}
            </Chip>
          ))}
        </div>
        <Button size="sm" onClick={() => setShowForm(true)}>
          <Plus /> {t("leads.new")}
        </Button>
      </div>

      <Dialog
        open={showForm}
        onOpenChange={(open) => {
          setShowForm(open);
          if (!open) setForm(EMPTY_FORM);
        }}
        title={t("leads.formTitle")}
        description={t("leads.formHint")}
        footer={
          <div className="flex w-full items-center justify-end gap-2">
            <Button variant="ghost" onClick={() => setShowForm(false)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void create()} disabled={!form.email.trim()} loading={saving}>
              {t("leads.create")}
            </Button>
          </div>
        }
      >
        <FormField id="lead-email" label={t("leads.email")}>
          <Input
            id="lead-email"
            type="email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            placeholder="anna.muster@example.com"
          />
        </FormField>
        <FormField id="lead-name" label={t("leads.name")}>
          <Input
            id="lead-name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </FormField>
        <FormField id="lead-phone" label={t("leads.phone")}>
          <Input
            id="lead-phone"
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
          />
        </FormField>
        <FormField id="lead-interest" label={t("leads.interest")}>
          <Input
            id="lead-interest"
            value={form.interest}
            onChange={(e) => setForm({ ...form, interest: e.target.value })}
            placeholder={t("leads.interestPlaceholder")}
          />
        </FormField>
        <FormField id="lead-notes" label={t("leads.notes")}>
          <Textarea
            id="lead-notes"
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
            rows={3}
          />
        </FormField>
      </Dialog>

      {loading ? (
        <div className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="surface flex items-center justify-between gap-3 rounded-lg p-3">
              <Skeleton className="h-4 w-44" />
              <Skeleton className="h-4 w-24" />
            </div>
          ))}
        </div>
      ) : visible.length === 0 ? (
        <EmptyState
          icon={Users}
          title={filter ? t("leads.emptyFilteredTitle") : t("leads.emptyTitle")}
          description={filter ? t("leads.emptyFilteredBody") : t("leads.emptyBody")}
        />
      ) : (
        <div className="flex flex-col gap-2">
          {visible.map((lead, i) => (
            <div key={lead.id} className="animate-in-up" style={stagger(i)}>
              <LeadRow
                lead={lead}
                automations={attachedTo(lead)}
                onPatch={onPatch}
                onDelete={() => setConfirmDelete(lead)}
              />
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmDelete(null);
        }}
        title={t("leads.delete")}
        description={t("leads.deleteConfirm", { email: confirmDelete?.email ?? "" })}
        confirmLabel={t("leads.delete")}
        onConfirm={() => confirmDelete && void remove(confirmDelete)}
      />
    </div>
  );
}

/**
 * One lead: name + status/priority badges, expand for the details, pencil to
 * edit every field in place (saves on blur/change). Email is the lead's
 * identity and stays read-only.
 */
function LeadRow({
  lead,
  automations,
  onPatch,
  onDelete,
}: {
  lead: Lead;
  automations: Automation[];
  onPatch: (id: string, patch: LeadPatch) => void;
  onDelete: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState(false);

  const expandable =
    !!(lead.interest || lead.notes || lead.phone || lead.persona) || automations.length > 0;

  const saveField = (
    field: "name" | "phone" | "interest" | "language" | "notes",
    value: string,
  ) => {
    const trimmed = value.trim();
    if (trimmed !== lead[field]) onPatch(lead.id, { [field]: trimmed });
  };

  const meta = [
    lead.lastInboundAt
      ? t("leads.lastInbound", { time: relativeTime(lead.lastInboundAt, i18n.language) })
      : t("leads.noInbound"),
    lead.lastOutboundAt
      ? t("leads.lastOutbound", { time: relativeTime(lead.lastOutboundAt, i18n.language) })
      : t("leads.noOutbound"),
  ];

  return (
    <article className="surface surface-hover group flex flex-col gap-2 rounded-lg px-3 py-2.5 transition">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 text-left",
            expandable && !editing && "cursor-pointer",
          )}
          onClick={() => expandable && !editing && setOpen((v) => !v)}
        >
          <span className="truncate text-sm font-medium tracking-tight">
            {lead.name || lead.email}
          </span>
          <Badge variant={STATUS_TONE[lead.status]}>{t(`leads.status.${lead.status}`)}</Badge>
          {lead.priority !== "" && (
            <Badge variant={PRIORITY_TONE[lead.priority]} aria-label={t("leads.priorityLabel")}>
              {lead.priority}
            </Badge>
          )}
        </button>
        <span className="shrink-0 font-mono text-2xs text-muted-foreground tabular-nums max-sm:hidden">
          {lead.lastInboundAt ? relativeTime(lead.lastInboundAt, i18n.language) : meta[0]}
        </span>
        {editing ? (
          <Button
            variant="ghost"
            size="icon-xs"
            title={t("leads.editDone")}
            aria-label={t("leads.editDone")}
            onClick={() => setEditing(false)}
          >
            <Check />
          </Button>
        ) : (
          <HoverActions>
            <Button
              variant="ghost"
              size="icon-xs"
              title={t("leads.edit")}
              aria-label={t("leads.edit")}
              onClick={() => {
                setEditing(true);
                setOpen(true);
              }}
            >
              <Pencil />
            </Button>
            <Button
              variant="ghost-danger"
              size="icon-xs"
              title={t("leads.delete")}
              aria-label={t("leads.delete")}
              onClick={onDelete}
            >
              <Trash2 />
            </Button>
          </HoverActions>
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

      {editing ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Select
              id={`lead-status-${lead.id}`}
              aria-label={t("leads.statusLabel")}
              value={lead.status}
              onChange={(value) => onPatch(lead.id, { status: value as LeadStatus })}
              className="w-auto"
              options={STATUSES.map((status) => ({
                value: status,
                label: t(`leads.status.${status}`),
              }))}
            />
            <Select
              id={`lead-priority-${lead.id}`}
              aria-label={t("leads.priorityLabel")}
              value={lead.priority}
              onChange={(value) => onPatch(lead.id, { priority: value as LeadPriority })}
              className="w-auto"
              options={[
                { value: "", label: t("leads.priorityNone") },
                ...PRIORITIES.map((priority) => ({
                  value: priority,
                  label: t(`leads.priority.${priority}`),
                })),
              ]}
            />
            <span className="truncate font-mono text-2xs text-muted-foreground">{lead.email}</span>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <Input
              defaultValue={lead.name}
              aria-label={t("leads.name")}
              placeholder={t("leads.name")}
              onBlur={(e) => saveField("name", e.target.value)}
            />
            <Input
              defaultValue={lead.phone}
              aria-label={t("leads.phone")}
              placeholder={t("leads.phone")}
              onBlur={(e) => saveField("phone", e.target.value)}
            />
            <Input
              defaultValue={lead.interest}
              aria-label={t("leads.interest")}
              placeholder={t("leads.interestPlaceholder")}
              onBlur={(e) => saveField("interest", e.target.value)}
            />
            <Input
              defaultValue={lead.language}
              aria-label={t("leads.language")}
              placeholder={t("leads.languagePlaceholder")}
              onBlur={(e) => saveField("language", e.target.value)}
            />
          </div>
          <Textarea
            defaultValue={lead.notes}
            aria-label={t("leads.notes")}
            placeholder={t("leads.notes")}
            className="field-sizing-content resize-none text-sm"
            onBlur={(e) => saveField("notes", e.target.value)}
          />
        </div>
      ) : (
        open && (
          <div className="flex flex-col gap-1.5">
            {lead.interest && <p className="text-sm">{lead.interest}</p>}
            {lead.notes && (
              <p className="whitespace-pre-wrap text-xs text-muted-foreground">{lead.notes}</p>
            )}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-2xs text-muted-foreground tabular-nums">
              <span className="truncate">{lead.email}</span>
              {lead.phone && (
                <span className="flex items-center gap-1">
                  <Phone className="h-3 w-3" /> {lead.phone}
                </span>
              )}
              {lead.persona && <span>{lead.persona}</span>}
              {lead.language && (
                <span>
                  {t("leads.language")}: {lead.language}
                </span>
              )}
              {meta.map((line) => (
                <span key={line}>{line}</span>
              ))}
            </div>
            {automations.length > 0 && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted-foreground">
                <CalendarClock className="h-3 w-3" />
                {automations.map((automation) => (
                  <span key={automation.id}>{automation.name}</span>
                ))}
              </div>
            )}
          </div>
        )
      )}
    </article>
  );
}
