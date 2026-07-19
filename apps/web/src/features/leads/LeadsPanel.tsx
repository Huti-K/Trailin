import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Automation, Lead, LeadPriority, LeadStatus } from "@trailin/shared";
import { CalendarClock, Phone, Plus, Trash2, Users } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { relativeTime } from "@/lib/dates";
import { toast } from "@/lib/toast";
import { stagger } from "@/lib/utils";

/**
 * The leads directory: every prospect the agent (or the user) recorded, as a
 * flat list of raised rows — status filter chips on top, quick status editing
 * and deletion on each row. Rows appear and update live: intake runs and the
 * agent's lead tools emit the "leads" server event.
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

  const setStatus = async (lead: Lead, status: LeadStatus) => {
    try {
      await api.updateLead(lead.id, { status });
      await load();
    } catch (err) {
      toast.error(err);
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
        <div className="flex flex-col gap-3">
          {[0, 1].map((i) => (
            <Card key={i} padding="lg">
              <div className="flex items-start justify-between gap-3">
                <div className="flex flex-col gap-2">
                  <Skeleton className="h-4 w-44" />
                  <Skeleton className="h-3 w-64" />
                </div>
                <Skeleton className="h-8 w-24 rounded-md" />
              </div>
            </Card>
          ))}
        </div>
      ) : visible.length === 0 ? (
        <EmptyState
          icon={Users}
          title={filter ? t("leads.emptyFilteredTitle") : t("leads.emptyTitle")}
          description={filter ? t("leads.emptyFilteredBody") : t("leads.emptyBody")}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {visible.map((lead, i) => (
            <div key={lead.id} className="animate-in-up" style={stagger(i)}>
              <LeadCard
                lead={lead}
                automations={attachedTo(lead)}
                onStatus={(status) => void setStatus(lead, status)}
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

function LeadCard({
  lead,
  automations,
  onStatus,
  onDelete,
}: {
  lead: Lead;
  automations: Automation[];
  onStatus: (status: LeadStatus) => void;
  onDelete: () => void;
}) {
  const { t, i18n } = useTranslation();

  const meta = [
    lead.lastInboundAt
      ? t("leads.lastInbound", { time: relativeTime(lead.lastInboundAt, i18n.language) })
      : t("leads.noInbound"),
    lead.lastOutboundAt
      ? t("leads.lastOutbound", { time: relativeTime(lead.lastOutboundAt, i18n.language) })
      : t("leads.noOutbound"),
  ];

  return (
    <Card padding="lg" className="flex flex-col gap-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-semibold tracking-tight">
              {lead.name || lead.email}
            </span>
            <Badge variant={STATUS_TONE[lead.status]}>{t(`leads.status.${lead.status}`)}</Badge>
            {lead.priority !== "" && (
              <Badge variant={PRIORITY_TONE[lead.priority]} aria-label={t("leads.priorityLabel")}>
                {t(`leads.priority.${lead.priority}`)}
              </Badge>
            )}
          </div>
          {lead.name && (
            <span className="truncate font-mono text-2xs text-muted-foreground">{lead.email}</span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <div className="w-36">
            <Select
              id={`lead-status-${lead.id}`}
              aria-label={t("leads.statusLabel")}
              value={lead.status}
              onChange={(value) => onStatus(value as LeadStatus)}
              options={STATUSES.map((status) => ({
                value: status,
                label: t(`leads.status.${status}`),
              }))}
            />
          </div>
          <Button
            variant="ghost-danger"
            size="icon-sm"
            aria-label={t("leads.delete")}
            onClick={onDelete}
          >
            <Trash2 />
          </Button>
        </div>
      </div>

      {lead.interest && <p className="text-sm">{lead.interest}</p>}
      {lead.notes && <p className="text-xs text-muted-foreground">{lead.notes}</p>}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-2xs text-muted-foreground tabular-nums">
        {lead.persona && <span>{lead.persona}</span>}
        {lead.language && (
          <span>
            {t("leads.language")}: {lead.language}
          </span>
        )}
        {meta.map((line) => (
          <span key={line}>{line}</span>
        ))}
        {lead.phone && (
          <span className="flex items-center gap-1">
            <Phone className="h-3 w-3" /> {lead.phone}
          </span>
        )}
      </div>

      {automations.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted-foreground">
          <CalendarClock className="h-3 w-3" />
          {automations.map((automation) => (
            <span key={automation.id}>{automation.name}</span>
          ))}
        </div>
      )}
    </Card>
  );
}
