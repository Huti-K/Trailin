/*
 * Composed-feature tabs of the DEV showcase gallery: list/interaction systems,
 * the agent chat transcript, markdown, and the home widgets — plus the static
 * fixtures that feed them. Safe to delete with the folder.
 */

import type { AccountColor } from "@trailin/shared";
import { Wrench } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { AgentCardView } from "@/components/cards";
import { SHOWCASE_TURNS, type ShowcaseTurn } from "@/components/cards/samples";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Markdown } from "@/components/ui/markdown";
import { Section } from "@/components/ui/section-header";
import { Spinner } from "@/components/ui/spinner";
import { StorageBrowser, type StorageNode } from "@/features/storage/StorageBrowser";
import { cn } from "@/lib/utils";
import {
  DisclosureDemo,
  FocusRingDemo,
  MicroInteractionsDemo,
  MotionDemo,
  OpenRunInChatDemo,
  PagedListDemo,
  ResizableDemo,
  RowMotionDemo,
  ThreadHistoryDemo,
  ToggleRowDemo,
} from "./demos";

/* ── Fixtures for the feature components ─────────────────────────────────── */

/** Account ids match `samples.ts`, so the chat cards pick these dots up. */
const DEMO_COLORS: AccountColor[] = [
  { accountId: "demo-work", hex: "#4f46e5" },
  { accountId: "demo-personal", hex: "#0d9488" },
];

const MARKDOWN_DEMO = `### What the assistant's replies render as

**Acme GmbH** replied to the payment reminder — Thomas Brandt
([t.brandt@acme-gmbh.de](mailto:t.brandt@acme-gmbh.de)) wants the invoice as a PDF.

- A reply draft is waiting in your mailbox
- Accounting is in Cc
- Payment was due 30 June

| Account | Unread | Drafts |
| --- | ---: | ---: |
| Work | 4 | 1 |
| Personal | 2 | 1 |

More context lives at [nordwind-studio.de](https://nordwind-studio.de).`;

function demoFolder(
  id: string,
  parentId: string | null,
  name: string,
  updatedAt: string,
): StorageNode {
  return {
    id,
    parentId,
    kind: "folder",
    name,
    ext: null,
    sizeBytes: null,
    updatedAt,
  };
}

function demoFile(
  id: string,
  parentId: string | null,
  name: string,
  sizeBytes: number,
  updatedAt: string,
): StorageNode {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return {
    id,
    parentId,
    kind: "file",
    name,
    ext,
    sizeBytes,
    updatedAt,
  };
}

const STORAGE_NODES: StorageNode[] = [
  demoFolder("st-docs", null, "Dokumente", "2026-07-10T09:00:00Z"),
  demoFolder("st-contracts", "st-docs", "Verträge", "2026-07-08T14:20:00Z"),
  demoFolder("st-photos", null, "Bilder", "2026-06-30T11:00:00Z"),
  demoFile("st-expose", "st-docs", "Exposé Elbchaussee 12.pdf", 2_450_000, "2026-07-16T10:12:00Z"),
  demoFile("st-desc", "st-docs", "Objektbeschreibung.md", 8_200, "2026-07-15T16:40:00Z"),
  demoFile(
    "st-makler",
    "st-contracts",
    "Maklervertrag Muster.pdf",
    240_000,
    "2026-07-02T09:30:00Z",
  ),
  demoFile(
    "st-miete",
    "st-contracts",
    "Mietvertrag Elbchaussee 12.pdf",
    480_000,
    "2026-07-12T13:05:00Z",
  ),
  demoFile(
    "st-fassade",
    "st-photos",
    "Fassade Elbchaussee 12.jpg",
    3_100_000,
    "2026-06-28T08:45:00Z",
  ),
  demoFile("st-eg", "st-photos", "Grundriss EG.png", 1_200_000, "2026-06-29T09:10:00Z"),
  demoFile("st-og", "st-photos", "Grundriss OG.png", 1_150_000, "2026-06-29T09:12:00Z"),
  demoFile("st-leads", null, "Leads Juli.xlsx", 96_000, "2026-07-17T18:00:00Z"),
  demoFile("st-provision", null, "Provisionen 2026.xlsx", 64_000, "2026-07-05T12:00:00Z"),
  demoFile("st-notes", null, "Notizen Besichtigung.md", 4_100, "2026-07-18T07:55:00Z"),
];

/** Paged lists, disclosure, run/thread plumbing, and the interaction systems. */
export function SystemsTab() {
  return (
    <>
      <Section
        title="Lists & disclosure"
        description="Paged reveal (SearchField + usePagedVisible + ShowMoreButton — type to see the cap reset), the quiet DisclosureToggle, and the keyboard-operable toggle row."
      >
        <PagedListDemo />
        <DisclosureDemo />
        <ToggleRowDemo />
      </Section>

      <Section
        title="Runs & threads"
        description="The shared pieces the activity feeds compose: the continue-in-chat action and the live conversation history."
      >
        <OpenRunInChatDemo />
        <ThreadHistoryDemo />
      </Section>

      <Section
        title="Interaction systems"
        description="Focus ring, text selection, and the drag-to-resize rail."
      >
        <FocusRingDemo />
        <ResizableDemo />
      </Section>

      <Section
        title="Motion"
        description="How a list behaves over time: rows arrive staggered, and rows that leave or move ride a view transition so the list never snaps to its new shape. Send and discard use the same mechanism to opposite ends — a sent row keeps its name and morphs in place, a discarded one leaves. Below that, the micro-interactions a row answers a pointer with. Switching panels in the sidebar rides the same transition."
      >
        <MotionDemo />
        <RowMotionDemo />
        <MicroInteractionsDemo />
      </Section>
    </>
  );
}

/** The chat transcript, the markdown vocabulary, and the home widgets. */
export function ContentTab() {
  return (
    <>
      <Section
        title="Agent chat"
        description="Bubbles, tool activity, the thinking state, and every structured card the agent can return. Same fixtures as the /showcase chat command."
      >
        <ChatTranscript />
      </Section>

      <Section
        title="Markdown"
        description="The vocabulary an assistant reply may use. mailto: links copy the address."
      >
        <Card padding="lg">
          <Markdown content={MARKDOWN_DEMO} />
        </Card>
      </Section>
    </>
  );
}

/** The file-browser surface, running entirely on local demo data. */
export function StorageTab() {
  const [nodes, setNodes] = React.useState(STORAGE_NODES);
  const [query, setQuery] = React.useState("");
  return (
    <Section
      title="Storage browser"
      description="Saved views and folder tree in the rail, breadcrumb toolbar with search, sort and layout controls, list or tile listings with hover actions. Runs on local demo data; deleting removes the row locally. The Knowledge page mounts this over the real knowledge folder."
    >
      <StorageBrowser
        nodes={nodes}
        query={query}
        onQueryChange={setQuery}
        onDelete={(node) => setNodes((prev) => prev.filter((n) => n.id !== node.id))}
        className="h-[560px]"
      />
    </Section>
  );
}

/**
 * A static replay of a chat turn — same markup ChatPanel uses, so bubbles,
 * tool chips and cards all re-theme with the Theme Lab sliders. The briefing
 * card's row actions still post into the real chat panel; the panel forces
 * prefill mode while this page is mounted so nothing fires a live agent turn.
 */
function ChatTranscript() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col items-end gap-2">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-sm leading-relaxed text-accent-foreground">
          Show me everything you can render.
        </div>
      </div>
      {SHOWCASE_TURNS.map((turn, index) => (
        // SHOWCASE_TURNS is a fixed module-level fixture — same length and
        // order on every render, so the index is a stable identity here.
        // biome-ignore lint/suspicious/noArrayIndexKey: static fixture array, never reordered/filtered
        <AssistantTurn key={index} turn={turn} />
      ))}
    </div>
  );
}

function AssistantTurn({ turn }: { turn: ShowcaseTurn }) {
  const { t } = useTranslation();
  const text = turn.contentKey ? t(turn.contentKey as never) : turn.content;
  const hasBubble = Boolean(text || turn.toolCalls?.length || turn.thinking);

  return (
    <div className="flex flex-col items-start gap-2">
      {turn.cards?.length ? (
        <div className="flex w-full max-w-[95%] flex-col gap-2">
          {turn.cards.map((card, index) => (
            // turn.cards comes from the same static fixture — fixed set of
            // cards, never reordered/filtered.
            // biome-ignore lint/suspicious/noArrayIndexKey: static fixture array, never reordered/filtered
            <AgentCardView key={index} card={card} colors={DEMO_COLORS} />
          ))}
        </div>
      ) : null}

      {hasBubble && (
        <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-surface-2 px-4 py-2.5 text-sm text-foreground">
          {turn.toolCalls?.length ? (
            <div className={cn("flex flex-wrap gap-1.5", text && "mb-2")}>
              {turn.toolCalls.map((call) => (
                <Badge
                  key={call.name}
                  variant={call.isError ? "destructive" : call.done ? "success" : "muted"}
                >
                  <Wrench className="h-3 w-3" />
                  {call.name}
                  {!call.done && <Spinner className="h-3 w-3" />}
                </Badge>
              ))}
            </div>
          ) : null}

          {text ? (
            <Markdown content={text} />
          ) : turn.thinking ? (
            <span className="animate-pulse text-muted-foreground">{t("chat.thinking")}</span>
          ) : null}
        </div>
      )}
    </div>
  );
}
