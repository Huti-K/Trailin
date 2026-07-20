/*
 * Interactive demos for the shared primitives the /showcase gallery exercises —
 * each one holds its own state so the page stays a live test bench, not a
 * screenshot. Part of the DEV showcase; safe to delete with the folder.
 */

import { useQuery } from "@tanstack/react-query";
import {
  ArrowUp,
  Bell,
  Bomb,
  Brain,
  Check,
  ChevronDown,
  ChevronUp,
  FileText,
  FolderOpen,
  Inbox,
  RotateCcw,
  Send,
  Sparkles,
  Sunrise,
  Trash2,
} from "lucide-react";
import * as React from "react";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { OpenRunInChatButton } from "@/components/OpenRunInChatButton";
import { RunStatusBadge } from "@/components/RunStatusBadge";
import { ThreadHistory } from "@/components/ThreadHistory";
import { AccountDot } from "@/components/ui/account-dot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { ColorPicker } from "@/components/ui/color-picker";
import { DisclosureToggle, ShowMoreButton } from "@/components/ui/disclosure-toggle";
import { LoadingRow, Notice, RetryableError } from "@/components/ui/feedback";
import { IconChip } from "@/components/ui/icon-chip";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { LinkButton } from "@/components/ui/link-button";
import { ListRow } from "@/components/ui/list-row";
import { SearchField } from "@/components/ui/search-field";
import { Section, SectionHeader, SectionTitle } from "@/components/ui/section-header";
import { toast } from "@/lib/toast";
import { usePagedVisible } from "@/lib/usePagedVisible";
import { useResizableWidth } from "@/lib/useResizableWidth";
import { cn, MOD_LABEL, rowTransition, toggleRowProps, withViewTransition } from "@/lib/utils";

/** The tiny shared shapes: icon chips, account dots, and keyboard hints. */
export function SmallMarksDemo() {
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <IconChip>
          <Sunrise />
        </IconChip>
        <IconChip tone="tint-neutral">
          <FolderOpen />
        </IconChip>
        <IconChip size="sm">
          <Brain />
        </IconChip>
        <IconChip size="sm" tone="tint-neutral">
          <FileText />
        </IconChip>
        <span className="text-xs text-muted-foreground">
          IconChip — accent/neutral · md 28px / sm 24px, icons sized by the chip
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <AccountDot color="#4f46e5" />
        <AccountDot color="#0d9488" />
        <AccountDot />
        <AccountDot color="#4f46e5" className="h-2.5 w-2.5" />
        <span className="text-xs text-muted-foreground">
          AccountDot — the bare one is the unassigned-grey fallback; resize via className
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Kbd className="px-1.5">{MOD_LABEL}K</Kbd>
        <Kbd>↑</Kbd>
        <Kbd>↓</Kbd>
        <Kbd className="px-1.5">tab</Kbd>
        <Kbd className="px-1.5">esc</Kbd>
        <span className="text-xs text-muted-foreground">Kbd — keyboard hints</span>
      </div>
    </>
  );
}

const PAGED_SENDERS = [
  "Morning Digest",
  "Product Weekly",
  "Design Notes",
  "Changelog",
  "The Long Read",
  "Metrics Monday",
  "Paper Trail",
  "Release Radar",
  "Quiet Fridays",
  "Field Notes",
  "Ship It",
  "Sunday Edition",
];

/**
 * SearchField + usePagedVisible + ShowMoreButton wired together the way the
 * lanes use them: the cap grows by steps and resets whenever the filter
 * changes, so "show more" never sits past the end of a narrower list.
 */
export function PagedListDemo() {
  const [query, setQuery] = React.useState("");
  const { visible, showMore } = usePagedVisible(4, 4, query);
  const q = query.trim().toLowerCase();
  const filtered = PAGED_SENDERS.filter((label) => label.toLowerCase().includes(q));
  const shown = filtered.slice(0, visible);
  const remaining = filtered.length - shown.length;

  return (
    <div className="flex max-w-md flex-col gap-2">
      <SearchField value={query} onChange={setQuery} placeholder="Filter senders…" />
      {shown.map((label) => (
        <ListRow key={label}>
          <span className="text-sm">{label}</span>
          <span className="text-2xs text-muted-foreground">weekly</span>
        </ListRow>
      ))}
      {remaining > 0 && <ShowMoreButton count={remaining} onClick={showMore} />}
      {filtered.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No matches — clear the filter and the cap starts over at 4.
        </p>
      )}
    </div>
  );
}

/** RetryableError that actually recovers: the third attempt "succeeds". */
export function RetryableErrorDemo() {
  const [attempts, setAttempts] = React.useState(0);

  if (attempts >= 2) {
    return (
      <div className="flex flex-col items-start gap-2">
        <Notice tone="success">Loaded on the third attempt — the banner clears on success.</Notice>
        <LinkButton onClick={() => setAttempts(0)}>Break it again</LinkButton>
      </div>
    );
  }
  return (
    <RetryableError onRetry={() => setAttempts((n) => n + 1)}>
      Could not load the contact list{attempts > 0 ? ` (attempt ${attempts + 1})` : ""}.
    </RetryableError>
  );
}

/** LoadingRow at its default size and the compact className override. */
export function LoadingRowsDemo() {
  return (
    <div className="flex flex-col gap-1">
      <LoadingRow label="Loading your drafts…" />
      <LoadingRow className="py-1 text-xs" label="Compact — sized down via className" />
    </div>
  );
}

/**
 * Drives the real app-wide sweep rather than mounting a second one: it reads
 * the global in-flight count, so a deliberately slow query here lights the
 * strip already sitting on the canvas edge. The 200ms delay is the point, the
 * app's own local queries return too fast to ever flash it.
 */
export function LoadingSweepDemo() {
  const [run, setRun] = React.useState(0);
  const { isFetching } = useQuery({
    queryKey: ["showcase-sweep", run],
    queryFn: () => new Promise((resolve) => window.setTimeout(() => resolve(run), 1800)),
    enabled: run > 0,
    gcTime: 0,
  });
  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setRun((n) => n + 1)}
        disabled={isFetching}
      >
        {isFetching ? "Fetching…" : "Run a slow query"}
      </Button>
      <p className="max-w-md text-sm text-muted-foreground">
        Watch the top edge of the canvas, not this box. One accent strip for the whole app, so a
        refetch never needs a per-panel spinner. A busy <em>control</em> still takes{" "}
        <code className="text-xs">loading</code>.
      </p>
    </div>
  );
}

/** Every Notice tone, plus a dismissible one that can be brought back. */
export function NoticeDemo() {
  const [dismissed, setDismissed] = React.useState(false);
  return (
    <div className="flex flex-col gap-2">
      {dismissed ? (
        <LinkButton onClick={() => setDismissed(false)}>Bring the dismissed notice back</LinkButton>
      ) : (
        <Notice
          tone="accent"
          onDismiss={() => setDismissed(true)}
          className="flex justify-between gap-3"
        >
          Accent notice with the optional dismiss affordance.
        </Notice>
      )}
      <Notice tone="neutral">Neutral — a quiet setup hint.</Notice>
      <Notice tone="success">Success — the flow finished.</Notice>
      <Notice tone="warning">Warning — something needs attention.</Notice>
      <Notice tone="danger">Danger — the request failed.</Notice>
    </div>
  );
}

/** The quiet open/close disclosure — chevron up/down, no fill. */
export function DisclosureDemo() {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="flex flex-col gap-2">
      <DisclosureToggle open={open} onToggle={() => setOpen((o) => !o)}>
        {open ? "Hide delivery details" : "Show delivery details"}
      </DisclosureToggle>
      {open && (
        <p className="text-xs text-muted-foreground">
          Sent via smtp-relay · TLS 1.3 · queued 09:41, delivered 09:42.
        </p>
      )}
    </div>
  );
}

/**
 * toggleRowProps in action: the whole header row expands/collapses — focus it
 * and press Enter or Space. Used where the header wraps real buttons and so
 * can't be a native <button> itself.
 */
export function ToggleRowDemo() {
  const [expanded, setExpanded] = React.useState(false);
  return (
    <div className="rounded-lg bg-surface-2 p-3">
      <div
        className={cn("flex cursor-pointer items-center justify-between gap-3")}
        {...toggleRowProps(expanded, () => setExpanded((e) => !e))}
      >
        <p className="flex items-center gap-2 text-sm font-medium">
          Weekly digest ran
          {expanded ? (
            <ChevronUp className="h-3 w-3 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
          )}
        </p>
        <RunStatusBadge status="success" />
      </div>
      {expanded && (
        <p className="mt-2 text-xs text-muted-foreground">
          The row carries role, tabIndex, aria-expanded and Enter/Space handling from toggleRowProps
          — keyboard-toggle it to test.
        </p>
      )}
    </div>
  );
}

/** Every SectionHeader/Section shape: accent bar, icon chip, aside slot. */
export function SectionHeaderDemo() {
  return (
    <div className="flex flex-col gap-6 rounded-xl bg-surface-2 p-4">
      <SectionHeader
        title="Accent bar header"
        description="The default mark — a short accent bar in front of the title."
      />
      <SectionHeader
        title="Icon header"
        description="Passing an icon swaps the bar for a 24px IconChip."
        icon={<Sunrise />}
      />
      <Section
        title="Header with aside"
        description="The aside slot puts a status chip beside the header."
        aside={<Badge variant="success">Live</Badge>}
      >
        <p className="text-xs text-muted-foreground">Stacked content sits below the header.</p>
      </Section>
    </div>
  );
}

/** The three attribute sources the global CursorTooltip reads while hovering. */
export function CursorTooltipDemo() {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span
        data-tooltip="Read from data-tooltip"
        className="rounded-lg bg-surface-2 px-3 py-1.5 text-xs font-medium"
      >
        data-tooltip
      </span>
      <Button variant="secondary" size="icon-sm" aria-label="Read from aria-label">
        <Bell />
      </Button>
      <Button
        variant="secondary"
        size="sm"
        title="Read from title — the native tooltip is suppressed"
      >
        title attribute
      </Button>
      <span className="text-xs text-muted-foreground">
        CursorTooltip — hover each; one cursor-following tooltip serves data-tooltip, aria-label and
        title
      </span>
    </div>
  );
}

/** ColorPicker driving an AccountDot — the pairing the connections page uses. */
export function ColorPickerDemo() {
  const [hex, setHex] = React.useState("#4f46e5");
  return (
    <div className="flex flex-wrap items-center gap-3">
      <ColorPicker color={hex} onSelect={setHex} />
      <AccountDot color={hex} className="h-2.5 w-2.5" />
      <span className="font-mono text-2xs uppercase text-muted-foreground">{hex}</span>
      <span className="text-xs text-muted-foreground">
        ColorPicker — anchored surface-pop popover; the dot follows the picked colour
      </span>
    </div>
  );
}

/** Throws during render while armed so the surrounding ErrorBoundary catches it. */
function RenderBomb({ armed }: { armed: boolean }) {
  if (armed) throw new Error("Deliberate render crash from the showcase bomb.");
  return null;
}

/**
 * A live ErrorBoundary catch-and-recover cycle. The bomb disarms right after
 * the boundary has caught, so its own "Try again" restores the healthy
 * subtree. The wrapper flattens the fallback's full-screen height so it fits
 * inline in the gallery.
 */
export function ErrorBoundaryDemo() {
  const [armed, setArmed] = React.useState(false);
  React.useEffect(() => {
    if (armed) setArmed(false);
  }, [armed]);
  return (
    <div className="overflow-hidden rounded-xl bg-surface-2 [&_.h-dvh]:h-auto [&_.h-dvh]:py-8">
      <ErrorBoundary>
        <RenderBomb armed={armed} />
        <div className="flex flex-wrap items-center justify-between gap-3 p-4">
          <p className="text-sm">
            Healthy subtree — crash it to see the fallback, then recover with its own controls.
          </p>
          <Button variant="destructive" size="sm" onClick={() => setArmed(true)}>
            <Bomb /> Throw in render
          </Button>
        </div>
      </ErrorBoundary>
    </div>
  );
}

/**
 * ThreadHistory against demo ids: it reads the thread live on first expand,
 * so this shows the loading pass and then whichever terminal branch the
 * server answers with — the quiet standalone-draft line on a 404, the retry
 * banner otherwise.
 */
export function ThreadHistoryDemo() {
  return (
    <div className="flex max-w-md flex-col gap-2">
      <ThreadHistory accountId="demo-work" threadId="thread-acme-2291" />
      <p className="text-xs text-muted-foreground">
        Expand to watch it fetch — with demo ids the empty or error branch renders, on a connected
        account the collapsible message list does.
      </p>
    </div>
  );
}

/**
 * The per-run "continue in chat" action. The demo run has no conversation, so
 * a capture-phase guard swallows the real navigation and reports what would
 * have happened instead.
 */
export function OpenRunInChatDemo() {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div
        onClickCapture={(e) => {
          e.preventDefault();
          e.stopPropagation();
          toast.info("Would open this run's conversation in chat.");
        }}
      >
        <OpenRunInChatButton runId="demo-run" onNavigateToChat={() => {}} />
      </div>
      <span className="text-xs text-muted-foreground">
        OpenRunInChatButton — the icon action every activity feed row carries
      </span>
    </div>
  );
}

/** Focus ring and ::selection — the two accent marks that only appear on interaction. */
export function FocusRingDemo() {
  const [picked, setPicked] = React.useState(false);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" size="sm">
          Tab to me
        </Button>
        <Chip active={picked} onClick={() => setPicked((p) => !p)}>
          then me
        </Chip>
        <Input className="max-w-48" placeholder="then this field" />
      </div>
      <p className="max-w-md text-sm text-muted-foreground">
        The ring is keyboard-only (:focus-visible) — clicking never draws it. Select this sentence
        to see the accent ::selection tint, the same mark the palette uses for matched text.
      </p>
    </div>
  );
}

const MOTION_ROWS = [
  "Content rises 6px and fades in over ~360ms",
  "Siblings stagger by ~70ms",
  "Only transform and opacity animate",
];

/** Replays the entrance motion by remounting a staggered list. */
export function MotionDemo() {
  const [run, setRun] = React.useState(0);
  return (
    <div className="flex flex-col items-start gap-3">
      <Button variant="secondary" size="sm" onClick={() => setRun((n) => n + 1)}>
        <RotateCcw /> Replay entrance
      </Button>
      <div key={run} className="flex w-full max-w-md flex-col gap-2">
        {MOTION_ROWS.map((label, index) => (
          <ListRow
            key={label}
            className="animate-in-up"
            style={{ animationDelay: `${index * 70}ms` }}
          >
            <span className="text-sm">{label}</span>
          </ListRow>
        ))}
      </div>
    </div>
  );
}

const ROW_MOTION_ROWS = [
  { id: "anna", label: "Reply to Anna about Tuesday's viewing" },
  { id: "invoice", label: "Send the invoice for Hufelandstraße" },
  { id: "photos", label: "Refresh the exposé photos" },
  { id: "meyer", label: "Call the Meyer family back" },
];

/**
 * A list never snaps: every row carries `rowTransition(id)` so the browser can
 * pair it across the frame, and each mutation runs inside `withViewTransition`,
 * so the rows around the one that leaves or moves slide to their new places.
 * Every write here is synchronous, which is what the transition requires.
 * Under reduced motion the helper degrades to a plain write.
 *
 * Send and discard deliberately read differently: a sent row keeps its name and
 * morphs in place into its terminal line, a discarded one gives the name up and
 * leaves. Same mechanism, opposite meaning — the row that went out into the
 * world must not look like the row that was thrown away.
 */
export function RowMotionDemo() {
  const [rows, setRows] = React.useState(ROW_MOTION_ROWS);
  const [sent, setSent] = React.useState<string[]>([]);

  const discard = (id: string) =>
    withViewTransition(() => setRows((prev) => prev.filter((row) => row.id !== id)));

  const send = (id: string) => withViewTransition(() => setSent((prev) => [...prev, id]));

  const lift = (id: string) =>
    withViewTransition(() =>
      setRows((prev) => {
        const at = prev.findIndex((row) => row.id === id);
        const moved = prev.find((row) => row.id === id);
        if (at < 1 || !moved) return prev;
        const rest = prev.filter((row) => row.id !== id);
        return [...rest.slice(0, at - 1), moved, ...rest.slice(at - 1)];
      }),
    );

  return (
    <div className="flex flex-col items-start gap-3">
      <Button
        variant="secondary"
        size="sm"
        onClick={() => {
          setRows(ROW_MOTION_ROWS);
          setSent([]);
        }}
        disabled={rows.length === ROW_MOTION_ROWS.length && sent.length === 0}
      >
        <RotateCcw /> Refill the list
      </Button>
      <div className="flex w-full max-w-md flex-col gap-2">
        {rows.map((row) =>
          // Same transition name either way, so the browser pairs the live row
          // with its terminal line and morphs rather than swapping.
          sent.includes(row.id) ? (
            <ListRow key={row.id} style={rowTransition(row.id)}>
              <span className="truncate text-sm">{row.label}</span>
              <Badge variant="success">Sent</Badge>
            </ListRow>
          ) : (
            <ListRow key={row.id} style={rowTransition(row.id)}>
              <span className="truncate text-sm">{row.label}</span>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Move "${row.label}" up`}
                  onClick={() => lift(row.id)}
                >
                  <ArrowUp />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="icon-send"
                  aria-label={`Send "${row.label}"`}
                  onClick={() => send(row.id)}
                >
                  <Send />
                </Button>
                <Button
                  variant="ghost-danger"
                  size="icon-xs"
                  className="icon-discard"
                  aria-label={`Discard "${row.label}"`}
                  onClick={() => discard(row.id)}
                >
                  <Trash2 />
                </Button>
              </div>
            </ListRow>
          ),
        )}
      </div>
      {rows.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Every row left through a transition, and the list closed its own gaps.
        </p>
      )}
    </div>
  );
}

/** The row-level micro-interactions, all transform/opacity only. */
export function MicroInteractionsDemo() {
  const [checked, setChecked] = React.useState(false);
  const [count, setCount] = React.useState(3);
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <p className="text-sm text-muted-foreground">
          Icon verbs — each glyph answers the pointer in its verb's own direction. Hover them.
        </p>
        <div className="flex flex-wrap items-center gap-1">
          <Button
            variant="ghost"
            size="icon-xs"
            className="icon-refine hover:bg-accent/10 hover:text-accent"
            aria-label="Refine"
            data-tooltip="icon-refine — the sparkle swells"
          >
            <Sparkles />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            className="icon-send"
            aria-label="Send"
            data-tooltip="icon-send — the glyph lifts along its diagonal"
          >
            <Send />
          </Button>
          <Button
            variant="ghost-danger"
            size="icon-xs"
            className="icon-discard"
            aria-label="Discard"
            data-tooltip="icon-discard — the bin tips"
          >
            <Trash2 />
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="flex items-center gap-2">
          <AccountDot tone="accent" className="dot-breathe h-2 w-2" />
          <span className="text-sm text-muted-foreground">
            <code className="text-xs">dot-breathe</code> — the unseen marker
          </span>
        </div>
        <button
          type="button"
          onClick={() => setChecked((prev) => !prev)}
          className="flex items-center gap-2 text-sm text-muted-foreground"
        >
          <span
            className={cn(
              "flex h-[18px] w-[18px] items-center justify-center rounded transition-colors",
              checked
                ? "bg-accent text-accent-foreground"
                : "bg-surface-2 text-muted-foreground/35",
            )}
          >
            <Check className={cn("h-3 w-3", checked && "check-pop")} strokeWidth={3} />
          </span>
          <code className="text-xs">check-pop</code> — the tick lands with the fill
        </button>
      </div>

      {/* The count badge replays `count-tick` on its own, keyed on the value. */}
      <div className="flex flex-col items-start gap-2">
        <SectionTitle icon={Inbox} title="Needs attention" count={count} />
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => setCount((n) => n + 1)}>
            Add one
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setCount((n) => Math.max(0, n - 1))}
            disabled={count === 0}
          >
            Take one
          </Button>
        </div>
      </div>
    </div>
  );
}

const RESIZE_MIN = 180;
const RESIZE_MAX = 380;

/**
 * useResizableWidth on a demo rail — same grip markup as the app's chat
 * splitter. Overdragging past the minimum collapses it, like the real rails.
 */
export function ResizableDemo() {
  const [collapsed, setCollapsed] = React.useState(false);
  const { width, onPointerDown } = useResizableWidth({
    storageKey: "trailin-showcase-resize",
    defaultWidth: 260,
    min: RESIZE_MIN,
    max: RESIZE_MAX,
    edge: "right",
    onOverdrag: () => setCollapsed(true),
  });
  if (collapsed) {
    return <LinkButton onClick={() => setCollapsed(false)}>Reopen the resizable rail</LinkButton>;
  }
  return (
    <div className="flex h-28 overflow-hidden rounded-xl bg-surface-2">
      <p className="flex-1 p-4 text-xs text-muted-foreground">
        Drag the grip — the width persists across reloads. Pull well past the minimum to collapse
        the rail, the same overdrag gesture the chat column uses.
      </p>
      {/* biome-ignore lint/a11y/useSemanticElements: interactive draggable splitter, not a static divider — <hr> can't be focusable or hold the grip child */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize demo rail"
        aria-valuenow={width}
        aria-valuemin={RESIZE_MIN}
        aria-valuemax={RESIZE_MAX}
        tabIndex={0}
        onPointerDown={onPointerDown}
        className="group flex w-2 shrink-0 cursor-col-resize touch-none items-center justify-center"
      >
        <div className="h-8 w-1 rounded-full bg-foreground/10 transition-colors group-hover:bg-foreground/30 group-active:bg-accent/60" />
      </div>
      <div
        style={{ width }}
        className="flex shrink-0 items-center justify-center font-mono text-xs tabular-nums text-muted-foreground"
      >
        {width}px
      </div>
    </div>
  );
}
