/*
 * Control-primitive tabs of the DEV showcase gallery: buttons, marks, forms,
 * surfaces, and feedback. Each export is one tab's worth of sections. Safe to
 * delete with the folder.
 */

import { Bell, Check, Inbox, Mail, Sparkles, Trash2, TriangleAlert, X } from "lucide-react";
import * as React from "react";
import { RunStatusBadge } from "@/components/RunStatusBadge";
import { setShowcaseUpdate } from "@/components/UpdatePill";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorBanner } from "@/components/ui/feedback";
import { FormField } from "@/components/ui/form-field";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Label } from "@/components/ui/label";
import { LinkButton } from "@/components/ui/link-button";
import { ListRow } from "@/components/ui/list-row";
import { Section } from "@/components/ui/section-header";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ApiError } from "@/lib/api";
import { CHANGELOG } from "@/lib/changelog";
import { openSearch } from "@/lib/nav";
import { toast } from "@/lib/toast";
import { cn, MOD_LABEL } from "@/lib/utils";
import {
  ColorPickerDemo,
  CursorTooltipDemo,
  ErrorBoundaryDemo,
  LoadingRowsDemo,
  LoadingSweepDemo,
  NoticeDemo,
  RetryableErrorDemo,
  SectionHeaderDemo,
  SmallMarksDemo,
} from "./demos";

/** The file-type ink family. The hue is the only thing that varies per format. */
const FILETYPES: { label: string; hue: number }[] = [
  { label: "PDF", hue: 25 },
  { label: "DOCX", hue: 256 },
  { label: "XLSX", hue: 150 },
  { label: "PNG", hue: 300 },
  { label: "MD", hue: 70 },
];

/** Buttons, badges, chips, run status, and switches. */
export function ButtonsTab() {
  return (
    <>
      <Section
        title="Buttons"
        description="Ink primary, tonal fills, no outlines. Hover over the icon buttons below to see the custom cursor tooltip in action."
      >
        <div className="flex flex-wrap items-center gap-3">
          <Button data-tooltip="Default solid button">Default</Button>
          <Button variant="secondary" data-tooltip="Secondary style">
            Secondary
          </Button>
          <Button variant="outline" data-tooltip="Outline style">
            Outline
          </Button>
          <Button variant="ghost" data-tooltip="Ghost style">
            Ghost
          </Button>
          <Button variant="destructive" data-tooltip="Confirm CTA in destructive dialogs">
            <Trash2 /> Destructive
          </Button>
          <Button
            variant="ghost-danger"
            data-tooltip="Delete/discard/dismiss row actions — pale red hover"
          >
            <Trash2 /> Ghost danger
          </Button>
          <Button disabled data-tooltip="This is currently disabled">
            Disabled
          </Button>
          <Button loading>Loading</Button>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm">Small</Button>
          <Button size="default">Default</Button>
          <Button size="lg">Large</Button>
          <Button size="icon" aria-label="Notifications">
            <Bell />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Compact row action (icon-sm)">
            <Bell />
          </Button>
          <Button variant="ghost" size="icon-xs" aria-label="Tiny row action (icon-xs)">
            <Bell />
          </Button>
          <Button variant="ghost-danger" size="icon-xs" aria-label="Delete row (icon-xs)">
            <Trash2 />
          </Button>
          <IconButton aria-label="Dismiss row">
            <Bell className="h-4 w-4" />
          </IconButton>
          <LinkButton data-tooltip="Goes somewhere else">Link button</LinkButton>
        </div>
        {/* One meaning, one glyph. Whether a row is deleted outright or only
            flipped to a terminal status, the user cannot get it back either
            way, so both are Trash2 in ghost-danger. X never carries that
            weight. */}
        <div className="flex flex-wrap items-center gap-x-8 gap-y-2">
          <div className="flex items-center gap-2">
            <Button
              variant="ghost-danger"
              size="icon-xs"
              aria-label="Dismiss (destructive)"
              data-tooltip="Trash2 — the row is gone either way"
            >
              <Trash2 />
            </Button>
            <span className="text-sm text-muted-foreground">
              Destructive: delete, discard, dismiss
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Close (non-destructive)"
              data-tooltip="X — nothing is lost"
            >
              <X />
            </Button>
            <span className="text-sm text-muted-foreground">
              Non-destructive: close a panel, clear a field
            </span>
          </div>
        </div>
      </Section>

      <Section title="Badges" description="Pill status chips — pastel fill, no border.">
        <div className="flex flex-wrap items-center gap-2">
          <Badge>Default</Badge>
          <Badge variant="muted">Muted</Badge>
          <Badge variant="success">
            <Check /> Connected
          </Badge>
          <Badge variant="warning">Paused</Badge>
          <Badge variant="destructive">Error</Badge>
        </div>
      </Section>

      <Section
        title="Chips & run status"
        description="Filter chips, connection state, and how an automation run reports itself."
      >
        <div className="flex flex-wrap items-center gap-2">
          <ChipsDemo />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="success">
            <Check /> Connected
          </Badge>
          <Badge variant="warning">
            <TriangleAlert /> Token expired
          </Badge>
          <Badge variant="muted">Never run</Badge>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <RunStatusBadge status="running" />
          <RunStatusBadge status="success" />
          <RunStatusBadge status="error" />
        </div>
      </Section>

      <Section title="Switches" description="Accent by default; warning arms risky actions.">
        <div className="flex flex-wrap items-center gap-6">
          <SwitchDemo label="Accent" tone="accent" defaultOn />
          <SwitchDemo label="Warning" tone="warning" defaultOn />
          <SwitchDemo label="Off" tone="accent" />
          <div className="flex items-center gap-2 opacity-60">
            <Switch disabled />
            <span className="text-sm">Disabled</span>
          </div>
        </div>
        <DangerZoneDemo />
      </Section>
    </>
  );
}

/** The tiny shared shapes, section headers, and the type scale. */
export function MarksTab() {
  return (
    <>
      <Section
        title="Small marks"
        description="Icon chips, account dots, keyboard hints, the colour picker, and the cursor tooltip — the tiny shared shapes and pointers."
      >
        <SmallMarksDemo />
        <ColorPickerDemo />
        <CursorTooltipDemo />
      </Section>

      <Section
        title="Section headers"
        description="SectionHeader and the Section wrapper — every mark and layout they take."
      >
        <SectionHeaderDemo />
      </Section>

      <Section title="Typography" description="Hierarchy by weight and colour, not size jumps.">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-lg font-semibold tracking-tight">Heading — text-lg semibold</h1>
          <h2 className="text-sm font-semibold tracking-tight">Section title — text-sm semibold</h2>
          <p className="text-sm">Body text sits on the foreground ink, never pure black.</p>
          <p className="text-sm text-muted-foreground">Secondary text uses muted-foreground.</p>
          <p className="font-mono text-xs tabular-nums text-muted-foreground">
            mono · 09:41 · model_id · proj_abc123
          </p>
        </div>
      </Section>
    </>
  );
}

/** Filled fields — inputs, selects, textareas, and their hint/error states. */
export function FormsTab() {
  return (
    <Section
      title="Form controls"
      description="Filled fields, no borders; focus lightens the fill."
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField id="sc-name" label="Full name" hint="As it appears on your account.">
          <Input id="sc-name" placeholder="Ada Lovelace" />
        </FormField>
        <FormField id="sc-email" label="Email" error="That address looks invalid.">
          <Input id="sc-email" type="email" defaultValue="not-an-email" />
        </FormField>
        <FormField id="sc-plan" label="Plan">
          <SelectDemo />
        </FormField>
        <FormField id="sc-country" label="Country" hint="Searchable — opt-in for long lists only.">
          <SearchableSelectDemo />
        </FormField>
        <FormField id="sc-disabled" label="Disabled">
          <Input id="sc-disabled" disabled defaultValue="Read-only" />
        </FormField>
        <FormField id="sc-note" label="Note" className="sm:col-span-2">
          <Textarea id="sc-note" placeholder="Write something…" rows={3} />
        </FormField>
      </div>
    </Section>
  );
}

/** The tone ladder, cards, rows, and everything that floats over content. */
export function SurfacesTab() {
  return (
    <>
      <Section
        title="Surfaces"
        description="Three tones by depth — never a border, never card-in-card."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Card>
            <p className="text-sm font-medium">Card</p>
            <p className="text-xs text-muted-foreground">The one elevated panel.</p>
          </Card>
          <div className="surface-pop p-4">
            <p className="text-sm font-medium">Pop surface</p>
            <p className="text-xs text-muted-foreground">What select menus float on.</p>
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          {(["sm", "md", "lg"] as const).map((padding) => (
            <Card key={padding} padding={padding}>
              <p className="font-mono text-xs text-muted-foreground">padding="{padding}"</p>
            </Card>
          ))}
        </div>
        <div className="flex flex-col gap-2">
          <ListRow>
            <div className="flex items-center gap-3">
              <Mail className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm">Gmail — personal</span>
            </div>
            <Badge variant="success">Connected</Badge>
          </ListRow>
          <ListRow>
            <div className="flex items-center gap-3">
              <Inbox className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm">Outlook — work</span>
            </div>
            <Badge variant="warning">Reconnect</Badge>
          </ListRow>
        </div>
      </Section>

      <Section
        title="Overlays"
        description="Dialogs float on .surface-pop over a blurred scrim. The Cmd+K palette is the third overlay — open it from anywhere."
      >
        <div className="flex flex-wrap items-center gap-3">
          <DialogDemo />
          <ConfirmDialogDemo />
          <Button variant="secondary" onClick={() => openSearch()}>
            Search palette <Kbd className="px-1.5">{MOD_LABEL}K</Kbd>
          </Button>
        </div>
      </Section>

      <Section
        title="Update pill"
        description="The one persistent CTA: it sits in the sidebar footer once an update has downloaded and stays until the restart, collapsing to its icon with the sidebar. Opens the changelog, where the notes sit above the restart button."
      >
        <UpdatePillDemo />
      </Section>
    </>
  );
}

/** Toasts, status tints, loading/empty states, and crash recovery. */
export function FeedbackTab() {
  return (
    <>
      <Section title="Toasts" description="Ephemeral system notifications that slide in.">
        <div className="flex flex-wrap items-center gap-3">
          <Button
            onClick={() => toast.success("Your changes have been saved.")}
            variant="secondary"
          >
            Success toast
          </Button>
          <Button
            onClick={() => toast.error("Could not connect to the server.")}
            variant="secondary"
          >
            Error toast
          </Button>
          <Button
            onClick={() => toast.info("A new draft is waiting for review.")}
            variant="secondary"
          >
            Info toast
          </Button>
          <Button
            onClick={() =>
              toast.error(
                new ApiError(
                  "Pipedream is not set up. Add your Pipedream credentials in Settings → Accounts.",
                  409,
                  "pipedream_not_configured",
                ),
              )
            }
            variant="secondary"
          >
            Error toast with action
          </Button>
        </div>
      </Section>

      <Section title="Status tints" description="The one place semantic colour fills a shape.">
        <div className="flex flex-wrap gap-2">
          {(
            ["tint-neutral", "tint-accent", "tint-success", "tint-warning", "tint-danger"] as const
          ).map((tint) => (
            <span key={tint} className={cn(tint, "rounded-lg px-3 py-1.5 text-xs font-medium")}>
              {tint.replace("tint-", "")}
            </span>
          ))}
        </div>
        {/* One class, every format: only --filetype-h varies. The lightness and
            chroma come from the theme, so the Grain/Saturation knobs move these too. */}
        <div className="flex flex-wrap gap-2">
          {FILETYPES.map(({ label, hue }) => (
            <span
              key={label}
              className="tint-file rounded-lg px-3 py-1.5 text-xs font-medium"
              style={{ "--filetype-h": hue } as React.CSSProperties}
            >
              {label}
            </span>
          ))}
        </div>
        <ErrorBanner>Something went wrong while saving your changes.</ErrorBanner>
        <NoticeDemo />
      </Section>

      <Section
        title="Feedback & empty states"
        description="Loading, skeletons, and the nothing-here shape."
      >
        <LoadingSweepDemo />
        <LoadingRowsDemo />
        <RetryableErrorDemo />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-24 w-full" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <EmptyState
            icon={Inbox}
            title="No drafts yet"
            description="When the agent writes a draft, it shows up here for review."
            action={<Button size="sm">Compose one</Button>}
          />
          <EmptyState
            size="lg"
            icon={Sparkles}
            title="All caught up"
            description="Nothing needs your attention right now."
          />
        </div>
      </Section>

      <Section
        title="Crash recovery"
        description="ErrorBoundary — one broken component never white-screens the app."
      >
        <ErrorBoundaryDemo />
      </Section>
    </>
  );
}

function ChipsDemo() {
  const [active, setActive] = React.useState("all");
  return (
    <>
      {["all", "unread", "needs reply", "waiting"].map((filter) => (
        <Chip key={filter} active={active === filter} onClick={() => setActive(filter)}>
          {filter}
        </Chip>
      ))}
    </>
  );
}

function DialogDemo() {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Open dialog
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Rename account"
        description="Shown wherever this connection appears."
        footer={<Button onClick={() => setOpen(false)}>Save</Button>}
      >
        <Input defaultValue="Gmail — personal" />
      </Dialog>
    </>
  );
}

/** Stands the real pill up in the real sidebar, with the newest release as the
 *  waiting update — outside the desktop shell nothing ever mounts it. Collapse
 *  the sidebar while it is up to see its icon-only width. */
function UpdatePillDemo() {
  const [shown, setShown] = React.useState(false);
  const pending = CHANGELOG[0]?.version;

  React.useEffect(() => () => setShowcaseUpdate(null), []);

  if (!pending) return null;
  return (
    <Button
      variant="secondary"
      onClick={() => {
        setShown(!shown);
        setShowcaseUpdate(shown ? null : pending);
      }}
    >
      {shown ? "Hide it" : "Show it in the sidebar"}
    </Button>
  );
}

function ConfirmDialogDemo() {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button variant="destructive" onClick={() => setOpen(true)}>
        <Trash2 /> Discard draft
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Discard this draft?"
        description="The draft is deleted from your mailbox. This can't be undone."
        confirmLabel="Discard"
        onConfirm={() => setOpen(false)}
      />
    </>
  );
}

function SwitchDemo({
  label,
  tone,
  defaultOn,
}: {
  label: string;
  tone: "accent" | "warning";
  defaultOn?: boolean;
}) {
  const [on, setOn] = React.useState(Boolean(defaultOn));
  return (
    <div className="flex items-center gap-2">
      <Switch tone={tone} checked={on} onCheckedChange={setOn} />
      <span className="text-sm">{label}</span>
    </div>
  );
}

/** Mirrors the real "allow sending" danger-zone row so it can be tuned here. */
function DangerZoneDemo() {
  const [armed, setArmed] = React.useState(false);
  return (
    <ListRow className={cn("transition-colors", armed && "bg-warning/10")}>
      <div className="min-w-0">
        <Label className="flex items-center gap-1.5 text-sm font-medium">
          {armed && <Sparkles className="h-3.5 w-3.5 shrink-0 text-warning" />}
          Allow sending &amp; changes
        </Label>
        <p className={cn("text-xs", armed ? "text-warning" : "text-muted-foreground")}>
          {armed
            ? "The agent may send emails and make changes when you ask."
            : "Read-only: the agent can draft but never send or delete."}
        </p>
      </div>
      <Switch tone="warning" checked={armed} onCheckedChange={setArmed} />
    </ListRow>
  );
}

function SelectDemo() {
  const [value, setValue] = React.useState("pro");
  return (
    <Select
      id="sc-plan"
      value={value}
      onChange={setValue}
      options={[
        { value: "free", label: "Free" },
        { value: "pro", label: "Pro" },
        { value: "team", label: "Team" },
      ]}
    />
  );
}

function SearchableSelectDemo() {
  const [value, setValue] = React.useState("de");
  return (
    <Select
      id="sc-country"
      searchable
      value={value}
      onChange={setValue}
      options={[
        { value: "at", label: "Austria" },
        { value: "be", label: "Belgium" },
        { value: "dk", label: "Denmark" },
        { value: "fi", label: "Finland" },
        { value: "fr", label: "France" },
        { value: "de", label: "Germany" },
        { value: "it", label: "Italy" },
        { value: "nl", label: "Netherlands" },
        { value: "no", label: "Norway" },
        { value: "pl", label: "Poland" },
        { value: "es", label: "Spain" },
        { value: "se", label: "Sweden" },
        { value: "ch", label: "Switzerland" },
        { value: "gb", label: "United Kingdom" },
        { value: "us", label: "United States" },
      ]}
    />
  );
}
