/*
 * ─────────────────────────────────────────────────────────────────────────────
 *  DEV SHOWCASE / THEME LAB — safe to delete.
 *
 *  A gallery of every UI primitive plus a live theme editor, split into tabs
 *  behind an inner left nav. The tab groups live in `controlTabs.tsx` /
 *  `contentTabs.tsx` (built from the interactive demos in `demos.tsx`), the
 *  per-file component inventory in `componentsTab.tsx`, the theme editor in
 *  `ThemeLab.tsx`.
 *
 *  To remove entirely: delete this folder and the one `/showcase` <Route> in
 *  App.tsx. Nothing else imports it.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  HardDrive,
  Layers,
  LayoutList,
  ListTree,
  type LucideIcon,
  MessagesSquare,
  MousePointerClick,
  Shapes,
  SwatchBook,
  TextCursorInput,
  TriangleAlert,
} from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";
import { ComponentsTab } from "./componentsTab";
import { ContentTab, StorageTab, SystemsTab } from "./contentTabs";
import { ButtonsTab, FeedbackTab, FormsTab, MarksTab, SurfacesTab } from "./controlTabs";
import { ThemeLab } from "./ThemeLab";

interface Tab {
  id: string;
  label: string;
  icon: LucideIcon;
  /** The theme tab has none — ThemeLab stays mounted across tab switches
   *  (see below) rather than remounting. */
  render?: () => React.ReactNode;
}

/** The inner nav: grouped tabs under tiny uppercase eyebrows. */
const TAB_GROUPS: { label: string; tabs: Tab[] }[] = [
  {
    label: "Theme",
    tabs: [{ id: "theme", label: "Theme Lab", icon: SwatchBook }],
  },
  {
    label: "Primitives",
    tabs: [
      {
        id: "buttons",
        label: "Buttons & chips",
        icon: MousePointerClick,
        render: () => <ButtonsTab />,
      },
      { id: "marks", label: "Marks & type", icon: Shapes, render: () => <MarksTab /> },
      { id: "forms", label: "Forms", icon: TextCursorInput, render: () => <FormsTab /> },
      { id: "surfaces", label: "Surfaces & overlays", icon: Layers, render: () => <SurfacesTab /> },
    ],
  },
  {
    label: "Patterns",
    tabs: [
      {
        id: "feedback",
        label: "Feedback & errors",
        icon: TriangleAlert,
        render: () => <FeedbackTab />,
      },
      { id: "systems", label: "Lists & systems", icon: ListTree, render: () => <SystemsTab /> },
      {
        id: "content",
        label: "Chat & content",
        icon: MessagesSquare,
        render: () => <ContentTab />,
      },
      { id: "storage", label: "Storage", icon: HardDrive, render: () => <StorageTab /> },
    ],
  },
  {
    label: "Reference",
    tabs: [
      {
        id: "components",
        label: "All components",
        icon: LayoutList,
        render: () => <ComponentsTab />,
      },
    ],
  },
];

const TABS: Tab[] = TAB_GROUPS.flatMap((group) => group.tabs);

export function ShowcasePanel() {
  // The URL hash names the tab so a refresh (or a pasted link) lands on it.
  const [active, setActive] = React.useState(() => {
    const hash = window.location.hash.slice(1);
    return TABS.some((tab) => tab.id === hash) ? hash : "theme";
  });

  const rootRef = React.useRef<HTMLDivElement>(null);

  const select = (id: string) => {
    setActive(id);
    window.history.replaceState(null, "", `#${id}`);
    // Each tab reads as its own page, so start it at the top. Without this a
    // shorter tab clamps the previous tab's scroll offset — an accidental
    // upward snap — and a same-height one keeps a mid-page position.
    let node: HTMLElement | null = rootRef.current;
    while (node && node.scrollHeight <= node.clientHeight) node = node.parentElement;
    node?.scrollTo({ top: 0 });
  };

  // An edited/pasted hash while the page is open switches tabs too — a
  // hash-only navigation never remounts the panel, so the initializer above
  // can't see it. `select` uses replaceState, which doesn't fire this.
  React.useEffect(() => {
    const onHashChange = () => {
      const hash = window.location.hash.slice(1);
      if (TABS.some((tab) => tab.id === hash)) setActive(hash);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // BriefingCard's row actions post into the real chat panel, which App keeps
  // mounted beside every route — a curious click here would otherwise fire a
  // live agent turn. Force prefill while the gallery is open so it only fills
  // the composer. `pagehide` covers a refresh, which skips the unmount path.
  React.useEffect(() => {
    const KEY = "trailin-quick-action-mode";
    const previous = localStorage.getItem(KEY);
    const restore = () => {
      if (previous === null) localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, previous);
    };
    localStorage.setItem(KEY, "prefill");
    window.addEventListener("pagehide", restore);
    return () => {
      restore();
      window.removeEventListener("pagehide", restore);
    };
  }, []);

  const tab = TABS.find((entry) => entry.id === active);

  return (
    <div ref={rootRef} className="pb-16">
      <div className="flex flex-col gap-6 md:flex-row md:gap-8">
        {/* Chromeless nav band hugging the canvas's left edge. The content
            column centers itself in the space beside it (auto margins), so on
            wide canvases it sits mid-page like every other view instead of
            hugging the nav. */}
        <nav
          aria-label="Showcase sections"
          // top-1 matches the nav's natural offset in the scrollport (the
          // container's pt-1) — a larger sticky top pushes the nav down at
          // rest, and that push gets clamped by row height on short tabs,
          // so the nav would hop a few px between tabs.
          className="flex flex-row flex-wrap gap-1 md:sticky md:top-1 md:w-52 md:shrink-0 md:flex-col md:self-start"
        >
          {TAB_GROUPS.map((group) => (
            <React.Fragment key={group.label}>
              <p className="hidden w-full px-3 pt-4 text-2xs font-semibold uppercase tracking-wider text-muted-foreground first:pt-0 md:block">
                {group.label}
              </p>
              {group.tabs.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => select(id)}
                  aria-current={active === id ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                    active === id
                      ? "tint-accent"
                      : "text-muted-foreground hover:bg-accent/[0.08] hover:text-foreground",
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="truncate">{label}</span>
                </button>
              ))}
            </React.Fragment>
          ))}
        </nav>

        <div className="min-w-0 max-w-3xl flex-1 md:mx-auto">
          {/* ThemeLab stays mounted across tab switches: its inline-style
              preview pins CSS variables on <html>, and unmounting releases
              them — hiding keeps a retune visible while browsing the other
              tabs. Leaving the page unmounts it and restores everything. */}
          <div className={cn(active !== "theme" && "hidden")}>
            <ThemeLab />
          </div>
          {tab?.render && <div className="flex flex-col gap-10">{tab.render()}</div>}
        </div>
      </div>
    </div>
  );
}
