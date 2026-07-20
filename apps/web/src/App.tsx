import { type AppStatus, isLanguage, isSetupComplete } from "@trailin/shared";
import {
  ChevronLeft,
  ChevronRight,
  History,
  Menu,
  MessagesSquare,
  Moon,
  Plus,
  Search,
  Sun,
  X,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { SearchPalette } from "@/components/SearchPalette";
import { Sidebar } from "@/components/Sidebar";
import { Button, type ButtonProps } from "@/components/ui/button";
import { CursorTooltip } from "@/components/ui/cursor-tooltip";
import { Dialog } from "@/components/ui/dialog";
import { LoadingRow, LoadingSweep } from "@/components/ui/feedback";
import { Kbd } from "@/components/ui/kbd";
import { SearchField } from "@/components/ui/search-field";
import { Toaster } from "@/components/ui/toaster";
import { AutomationsPanel } from "@/features/automations/AutomationsPanel";
import { AttachmentViewer } from "@/features/chat/AttachmentViewer";
import { ChatPanel } from "@/features/chat/ChatPanel";
import { onRevealChat, sendChatCommand } from "@/features/chat/controller";
import { FocusChip } from "@/features/chat/FocusChip";
import { HistoryList } from "@/features/chat/HistoryList";
import { HomePanel } from "@/features/home/HomePanel";
import { KnowledgePanel } from "@/features/knowledge/KnowledgePanel";
import { LeadsPanel } from "@/features/leads/LeadsPanel";
import { SettingsPanel } from "@/features/settings/SettingsPanel";
import { SetupGate } from "@/features/setup/SetupGate";
import { ShowcasePanel } from "@/features/showcase/ShowcasePanel"; // DEV showcase — delete with its route
import { api } from "@/lib/api";
import { rememberLanguage } from "@/lib/i18n";
import { NAV_VIEWS, openSearch, registerNavigate, SHOWCASE_NAV, type View } from "@/lib/nav";
import { useDesktopChrome } from "@/lib/useDesktopChrome";
import { useResizableWidth } from "@/lib/useResizableWidth";
import { useRunNotifications } from "@/lib/useRunNotifications";
import { useTheme } from "@/lib/useTheme";
import { cn, MOD_LABEL, withViewTransition } from "@/lib/utils";

/** Set once setup finished (or was skipped); an established app never re-gates. */
const SETUP_DISMISSED_KEY = "trailin-setup-dismissed";

/** Drag range for the chat panel width, shared by the resize hook and the drag handle's
 *  ARIA value. The hook additionally caps the panel at a fraction of the window, so the
 *  px ceiling is only reachable on large screens. */
const CHAT_WIDTH_MIN = 320;
const CHAT_WIDTH_MAX = 960;

/** Narrows a raw route segment to a known nav view, for typed `t()` lookups. */
function isNavView(path: string): path is View {
  return (NAV_VIEWS as readonly string[]).includes(path);
}

/** Adopt the server's language setting; on first run, seed it from the client's initial language (the German default unless localStorage says otherwise). */
function useServerLanguage() {
  const { i18n } = useTranslation();
  React.useEffect(() => {
    api
      .language()
      .then(({ language }) => {
        if (!language) {
          const current = i18n.language;
          if (isLanguage(current)) {
            rememberLanguage(current);
            void api.setLanguage(current).catch(() => {});
          }
          return;
        }
        rememberLanguage(language);
        if (language !== i18n.language) void i18n.changeLanguage(language);
      })
      .catch(() => {});
  }, [i18n]);
}

/** Seed the server's timezone from the browser on first run — no visible setting for it. */
function useServerTimezone() {
  React.useEffect(() => {
    api
      .timezone()
      .then(({ timezone }) => {
        if (timezone) return;
        const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (detected) void api.setTimezone(detected).catch(() => {});
      })
      .catch(() => {});
  }, []);
}

/** Ghost icon button whose aria-label and hover tooltip are always the same string. */
function HeaderIconButton({
  label,
  ...props
}: Omit<ButtonProps, "variant" | "size" | "aria-label"> & { label: string }) {
  return <Button variant="ghost" size="icon" aria-label={label} data-tooltip={label} {...props} />;
}

/** Mobile-only scrim behind a slide-over panel. */
function Backdrop({ onClick }: { onClick: () => void }) {
  // Click-away convenience for mouse users only — every panel this backdrops
  // already exposes a real, keyboard-reachable close button, so the scrim
  // itself carries no independent keyboard interaction to mirror. role="presentation"
  // both drops the implicit semantics and satisfies the click/key-event pairing rule.
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: presentational scrim, not a control
    <div role="presentation" className="scrim fixed inset-0 z-40 md:hidden" onClick={onClick} />
  );
}

export default function App() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();

  const currentPath = location.pathname.split("/")[1] || "home";
  const onChatRoute = currentPath === "chat";
  const view: View = isNavView(currentPath) ? currentPath : "home";
  const [status, setStatus] = React.useState<AppStatus | null>(null);
  // "pending" until the first status answer decides between gate and app.
  const [gate, setGate] = React.useState<"pending" | "open" | "closed">(() =>
    localStorage.getItem(SETUP_DISMISSED_KEY) ? "closed" : "pending",
  );
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = React.useState(
    () =>
      typeof window !== "undefined" && localStorage.getItem("trailin-sidebar-collapsed") === "true",
  );
  const [chatOpen, setChatOpen] = React.useState(false);
  const [agentCollapsed, setAgentCollapsed] = React.useState(
    () =>
      typeof window !== "undefined" &&
      localStorage.getItem("trailin-agent-sidebar-collapsed") === "true",
  );
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false);
  const [historyOpen, setHistoryOpen] = React.useState(false);
  // Mirrors the ChatPanel's open conversation so the Chat tab's history rail can highlight it.
  const [activeConversationId, setActiveConversationId] = React.useState<string | undefined>();
  // A mailbox picked in the header chip before any conversation exists. The first
  // message carries it to the server (which opens the conversation focused on it),
  // after which the conversation owns its focus. Reset whenever there's no active
  // conversation again (a new chat), so a fresh chat starts on "All accounts".
  const [pendingFocusAccountId, setPendingFocusAccountId] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!activeConversationId) setPendingFocusAccountId(null);
  }, [activeConversationId]);
  const [historyCollapsed, setHistoryCollapsed] = React.useState(
    () =>
      typeof window !== "undefined" &&
      localStorage.getItem("trailin-chat-history-collapsed") === "true",
  );
  const [historyQuery, setHistoryQuery] = React.useState("");
  const [, theme, setThemePref] = useTheme();
  useDesktopChrome(theme);
  const toggleTheme = React.useCallback(() => {
    setThemePref(theme === "dark" ? "light" : "dark");
  }, [theme, setThemePref]);
  const { width: chatWidth, onPointerDown: onChatResizeStart } = useResizableWidth({
    storageKey: "trailin-chat-width",
    defaultWidth: 384,
    min: CHAT_WIDTH_MIN,
    max: CHAT_WIDTH_MAX,
    edge: "right",
    // Dragging well past the minimum reads as "put it away" — same collapse
    // the header chevron triggers.
    onOverdrag: () => setAgentCollapsed(true),
  });
  useServerLanguage();
  useServerTimezone();
  useRunNotifications();

  const refreshStatus = React.useCallback(() => {
    api
      .status()
      .then(setStatus)
      .catch(() => {
        setStatus(null);
        // Never trap the user behind a gate the server can't answer.
        setGate((g) => (g === "pending" ? "closed" : g));
      });
  }, []);

  // Mount + whenever the tab regains focus (sign-in and account linking
  // happen in other tabs, and status must not go stale).
  React.useEffect(() => {
    refreshStatus();
    const onFocus = () => refreshStatus();
    const onVisible = () => {
      if (!document.hidden) refreshStatus();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    const unsubscribeReveal = onRevealChat(() => setChatOpen(true));
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
      unsubscribeReveal();
    };
  }, [refreshStatus]);

  // Navigation requests from non-React code (e.g. a toast's click-through action).
  React.useEffect(() => {
    return registerNavigate((path) => {
      if (path.startsWith("/")) withViewTransition(() => navigate(path));
    });
  }, [navigate]);

  React.useEffect(() => {
    if (!status) return;
    const complete = isSetupComplete(status);
    if (complete) localStorage.setItem(SETUP_DISMISSED_KEY, "1");
    setGate((g) => (g === "pending" ? (complete ? "closed" : "open") : g));
  }, [status]);

  // Entering/leaving the Chat tab resets the history rail's drawer/toggle state,
  // so it never carries a stale "open" into the other layout.
  // biome-ignore lint/correctness/useExhaustiveDependencies: onChatRoute is the trigger, not a value read in the body — it must re-run on every route change
  React.useEffect(() => {
    setHistoryOpen(false);
    setHistoryQuery("");
  }, [onChatRoute]);

  React.useEffect(() => {
    localStorage.setItem("trailin-chat-history-collapsed", String(historyCollapsed));
  }, [historyCollapsed]);

  React.useEffect(() => {
    localStorage.setItem("trailin-sidebar-collapsed", String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  React.useEffect(() => {
    localStorage.setItem("trailin-agent-sidebar-collapsed", String(agentCollapsed));
  }, [agentCollapsed]);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const mod = event.metaKey || event.ctrlKey;

      if (mod && key === "b") {
        event.preventDefault();
        if (event.shiftKey) setAgentCollapsed((value) => !value);
        else setSidebarCollapsed((value) => !value);
        return;
      }
      if (mod && event.shiftKey && event.code === "Digit7") {
        event.preventDefault();
        setShortcutsOpen(true);
        return;
      }
      if (mod && event.shiftKey && event.code === "KeyL") {
        event.preventDefault();
        toggleTheme();
        return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleTheme]);

  const select = (next: string) => {
    withViewTransition(() => navigate(next === "home" ? "/" : `/${next}`));
    setMobileOpen(false);
    setChatOpen(false);
  };

  const closeGate = (openSettings: boolean) => {
    localStorage.setItem(SETUP_DISMISSED_KEY, "1");
    setGate("closed");
    select(openSettings ? "settings" : "home");
  };

  // Once the gate is open, a failed status poll (server down / offline) must not
  // fall through to the main app — SetupGate itself renders a "reconnecting" notice
  // when `status` is null and keeps polling.
  if (gate === "open") {
    return (
      <>
        <SetupGate status={status} onStatusChanged={refreshStatus} onFinish={closeGate} />
        <Toaster />
      </>
    );
  }

  if (gate === "pending") {
    return (
      <div className="grid h-dvh place-items-center">
        <LoadingRow />
      </div>
    );
  }

  const meta =
    import.meta.env.DEV && currentPath === "showcase" // DEV showcase — remove this branch with the route
      ? { title: SHOWCASE_NAV.title, description: SHOWCASE_NAV.description }
      : {
          title: t(`views.${view}.title`),
          description: t(`views.${view}.description`),
        };

  return (
    <div
      className="flex h-dvh overflow-hidden bg-sidebar"
      style={{ "--chat-width": `${chatWidth}px` } as React.CSSProperties}
    >
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[70] focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-primary-foreground"
      >
        {t("app.skipToContent")}
      </a>

      {mobileOpen && <Backdrop onClick={() => setMobileOpen(false)} />}

      <div
        className={cn(
          // md:z-10 keeps the collapsed-nav hover tooltips above <main>, whose
          // `isolate` stacking context would otherwise paint over them.
          "fixed inset-y-0 left-0 z-50 transition-transform duration-200 ease-out md:static md:z-10 md:translate-x-0",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <Sidebar
          status={status}
          onClose={() => setMobileOpen(false)}
          isCollapsed={sidebarCollapsed}
          onCollapsedChange={setSidebarCollapsed}
        />
      </div>

      <main
        id="main-content"
        className={cn(
          // The grey canvas, inset into the chrome shell on desktop — rounded,
          // with a small vertical gap so the chrome frames it on all sides.
          "relative isolate flex min-w-0 flex-1 flex-col overflow-hidden bg-background md:my-3 md:rounded-2xl",
          onChatRoute && "hidden",
        )}
      >
        <div aria-hidden className="aurora" />
        <LoadingSweep />
        <header className="flex shrink-0 items-center gap-4 px-5 py-5 sm:px-8">
          <HeaderIconButton
            label={t("app.openMenu")}
            onClick={() => {
              setChatOpen(false);
              setMobileOpen(true);
            }}
            className="shrink-0 md:hidden"
          >
            <Menu />
          </HeaderIconButton>
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-bold tracking-tight text-foreground">{meta.title}</h1>
            <p className="truncate text-sm text-muted-foreground">{meta.description}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {/* Reads as a field on desktop so the shortcut is discoverable; an icon on mobile. */}
            <button
              type="button"
              onClick={() => openSearch()}
              className="hidden h-9 w-56 shrink-0 items-center gap-2 rounded-md bg-surface-2 px-2.5 text-left text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:flex"
            >
              <Search className="h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{t("search.openButton")}</span>
              <Kbd className="bg-background/70 px-1.5">{MOD_LABEL}K</Kbd>
            </button>
            <HeaderIconButton
              label={t("search.openButton")}
              onClick={() => openSearch()}
              className="shrink-0 sm:hidden"
            >
              <Search />
            </HeaderIconButton>
            <HeaderIconButton
              label={theme === "dark" ? t("sidebar.lightMode") : t("sidebar.darkMode")}
              onClick={toggleTheme}
              className="shrink-0"
            >
              {theme === "dark" ? <Sun /> : <Moon />}
            </HeaderIconButton>
            {!onChatRoute && agentCollapsed && (
              <HeaderIconButton
                label={t("app.expandChat")}
                onClick={() => setAgentCollapsed(false)}
                className="hidden shrink-0 md:inline-flex"
              >
                <ChevronLeft />
              </HeaderIconButton>
            )}
            <HeaderIconButton
              label={t("app.openChat")}
              onClick={() => {
                setMobileOpen(false);
                setChatOpen(true);
              }}
              className="shrink-0 md:hidden"
            >
              <MessagesSquare />
            </HeaderIconButton>
          </div>
        </header>

        <div
          className={cn(
            "min-h-0 flex-1 overflow-y-auto scroll-stable @container",
            // The Knowledge browser is a workspace, not a reading column: it
            // fills the canvas edge to edge instead of scrolling (only small
            // side/bottom insets), so the scroller becomes a flex column the
            // wrapper can size against. Ternaries, not overrides: tailwind-merge
            // can't cancel the breakpoint/container-query variants of these.
            currentPath === "knowledge" ? "flex flex-col px-3 pb-3" : "px-5 pb-10 pt-1 sm:px-8",
          )}
        >
          <div
            className={cn(
              currentPath === "knowledge"
                ? "min-h-0 w-full flex-1"
                : // Steps up with the canvas (not the viewport — the sidebar and
                  // chat panel eat variable width), so large monitors aren't all
                  // gutter.
                  "mx-auto max-w-3xl @6xl:max-w-4xl @7xl:max-w-5xl",
              // DEV showcase — remove with the route. Its inner nav hugs the
              // canvas's left edge, so the gallery spans the full width.
              import.meta.env.DEV && currentPath === "showcase" && "max-w-none",
            )}
          >
            <Routes>
              {/* The full-page Chat tab is rendered by the persistent chat instance below,
                  not here — this route just keeps the URL valid so it isn't redirected home. */}
              <Route path="/chat" element={null} />
              <Route path="/settings" element={<SettingsPanel onStatusChanged={refreshStatus} />} />
              {/* Leads exist only alongside a connected onOffice CRM. While status
                  is still loading nothing renders — redirecting then would kick a
                  direct /leads visit home on every reload. */}
              <Route
                path="/leads"
                element={
                  status === null ? null : status.onofficeConfigured ? (
                    <LeadsPanel />
                  ) : (
                    <Navigate to="/" replace />
                  )
                }
              />
              <Route path="/automations" element={<AutomationsPanel />} />
              <Route path="/knowledge" element={<KnowledgePanel />} />
              {/* DEV showcase / theme lab — delete this line and the ShowcasePanel file to remove. */}
              {import.meta.env.DEV && <Route path="/showcase" element={<ShowcasePanel />} />}
              <Route
                path="/"
                element={
                  <HomePanel
                    setupIncomplete={status !== null && !isSetupComplete(status)}
                    offline={Boolean(status?.pipedreamConfigured) && !status?.emailAccountsKnown}
                    onNavigate={select}
                  />
                }
              />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </div>
        </div>
      </main>

      {/* Chat backdrop — mobile slide-over (panel mode only) */}
      {!onChatRoute && chatOpen && <Backdrop onClick={() => setChatOpen(false)} />}

      {/* History-rail backdrop — full-page Chat tab on mobile, where the rail is a drawer */}
      {onChatRoute && historyOpen && <Backdrop onClick={() => setHistoryOpen(false)} />}

      {/* Drag handle — desktop panel mode only. Hidden in the full-page Chat tab (the chat fills its column).
          A focusable, value-bearing separator (not <hr>, which is a void element and can't host the
          grip child or take the drag/focus interaction this splitter needs). */}
      {/* biome-ignore lint/a11y/useSemanticElements: interactive draggable splitter, not a static divider — <hr> can't be focusable or hold the grip child */}
      <div
        onPointerDown={onChatResizeStart}
        role="separator"
        aria-orientation="vertical"
        aria-label={t("chat.resize")}
        aria-valuenow={chatWidth}
        aria-valuemin={CHAT_WIDTH_MIN}
        aria-valuemax={CHAT_WIDTH_MAX}
        tabIndex={0}
        className={cn(
          "group z-40 hidden w-2 shrink-0 cursor-col-resize touch-none items-center justify-center md:flex",
          (onChatRoute || agentCollapsed) && "md:hidden",
        )}
      >
        <div className="h-8 w-1 rounded-full bg-foreground/10 transition-colors group-hover:bg-foreground/30 group-active:bg-accent/60" />
      </div>

      {/* Chat — ONE persistent instance for both surfaces: the full-page Chat tab
          (in flow, flex-1, history rail on the left) and the floating overlay /
          slide-over on every other page. It is a single node in the tree, so
          switching tabs never remounts it or drops an in-flight stream. */}
      <div
        className={cn(
          "flex flex-col min-h-0 min-w-0 overflow-hidden",
          onChatRoute
            ? // Same inset rounded canvas as <main> — the Chat tab replaces it in flow.
              "static z-auto min-w-0 flex-1 translate-x-0 bg-background md:my-3 md:rounded-2xl"
            : cn(
                "fixed inset-y-0 right-0 w-full max-w-sm transition-[transform,width] duration-200 ease-out md:static md:z-auto md:max-w-none md:translate-x-0",
                agentCollapsed ? "md:w-0" : "md:w-[var(--chat-width)]",
                chatOpen ? "z-50 translate-x-0" : "z-40 translate-x-full md:translate-x-0",
              ),
        )}
        style={{ "--chat-width": `${chatWidth}px` } as React.CSSProperties}
      >
        <div
          className={cn(
            "flex min-h-0 min-w-0 flex-1 overflow-hidden pointer-events-auto",
            // Chat tab: a grey canvas gutter framing the conversation. The history
            // rail sits bare on it (chrome, like the nav); the chat column below
            // becomes a rounded card with a free top row — same as every panel.
            onChatRoute ? "flex-row gap-4 p-4 sm:p-6" : "flex-col bg-sidebar",
            // Panel mode: pin the content to the full panel width while the
            // outer shell animates closed/open, so the text is clipped by the
            // shrinking edge instead of re-wrapping on every frame.
            !onChatRoute && "md:w-[var(--chat-width)]",
          )}
        >
          {/* History rail — Chat tab only. Static column on desktop, slide-over drawer on mobile. */}
          {onChatRoute && (
            <div
              className={cn(
                "fixed inset-y-0 left-0 z-50 flex w-72 flex-col bg-background transition-transform duration-200 ease-out md:static md:z-auto md:w-64 md:translate-x-0",
                historyOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0",
                historyCollapsed && "md:hidden",
              )}
            >
              <div className="flex shrink-0 items-center gap-2.5 px-4 pb-3 pt-6">
                <p className="text-sm font-semibold tracking-tight">{t("chat.history")}</p>
                <HeaderIconButton
                  label={t("chat.newConversation")}
                  onClick={() => {
                    sendChatCommand({ kind: "new" });
                    setHistoryOpen(false);
                  }}
                  className="ml-auto"
                >
                  <Plus />
                </HeaderIconButton>
                <HeaderIconButton
                  label={t("chat.collapseHistory")}
                  onClick={() => setHistoryCollapsed(true)}
                  className="hidden md:inline-flex"
                >
                  <ChevronLeft />
                </HeaderIconButton>
                <HeaderIconButton
                  label={t("common.close")}
                  onClick={() => setHistoryOpen(false)}
                  className="md:hidden"
                >
                  <X />
                </HeaderIconButton>
              </div>
              <div className="px-4 pb-2">
                <SearchField
                  value={historyQuery}
                  onChange={setHistoryQuery}
                  placeholder={t("chat.searchPlaceholder")}
                />
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto scroll-stable px-2 pb-4">
                <HistoryList
                  activeId={activeConversationId}
                  query={historyQuery}
                  onPick={(id) => {
                    sendChatCommand({ kind: "open", conversationId: id });
                    setHistoryOpen(false);
                  }}
                />
              </div>
            </div>
          )}

          {/* Chat column — always present; the stable slot that owns the ChatPanel instance.
              White surface (a rounded card on the Chat tab, flush chrome in panel mode), so
              its neutral controls (composer, focus chip, code blocks) recess to grey rather
              than rising to white as they would on the canvas. */}
          <div
            className={cn(
              "surface-fills flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden @container",
              onChatRoute && "rounded-2xl bg-surface",
            )}
          >
            <div className="flex shrink-0 items-center gap-2.5 px-5 pb-4 pt-6">
              {/* Full-page tab has no app header, so mobile users still need a way into the nav drawer. */}
              {onChatRoute && (
                <HeaderIconButton
                  label={t("app.openMenu")}
                  onClick={() => setMobileOpen(true)}
                  className="shrink-0 md:hidden"
                >
                  <Menu />
                </HeaderIconButton>
              )}
              {/* Reopen the collapsed history rail (desktop). */}
              {onChatRoute && historyCollapsed && (
                <HeaderIconButton
                  label={t("chat.showHistory")}
                  onClick={() => setHistoryCollapsed(false)}
                  className="hidden shrink-0 md:inline-flex"
                >
                  <ChevronRight />
                </HeaderIconButton>
              )}
              <p className="shrink-0 text-sm font-semibold tracking-tight">
                {t("views.chat.title")}
              </p>
              <FocusChip
                conversationId={activeConversationId}
                pendingFocusAccountId={pendingFocusAccountId}
                onPendingFocusChange={setPendingFocusAccountId}
              />
              {onChatRoute && (
                <HeaderIconButton
                  label={theme === "dark" ? t("sidebar.lightMode") : t("sidebar.darkMode")}
                  onClick={toggleTheme}
                  className="ml-auto shrink-0"
                >
                  {theme === "dark" ? <Sun /> : <Moon />}
                </HeaderIconButton>
              )}
              <HeaderIconButton
                label={t("chat.newConversation")}
                onClick={() => sendChatCommand({ kind: "new" })}
                className={cn(!onChatRoute && "ml-auto", onChatRoute && "md:hidden")}
              >
                <Plus />
              </HeaderIconButton>
              <HeaderIconButton
                label={t("chat.history")}
                onClick={() => setHistoryOpen((open) => !open)}
                className={cn(historyOpen && "text-foreground", onChatRoute && "md:hidden")}
              >
                <History />
              </HeaderIconButton>
              {!onChatRoute && (
                <HeaderIconButton
                  label={t("app.collapseChat")}
                  onClick={() => setAgentCollapsed(true)}
                  className="hidden md:inline-flex"
                >
                  <ChevronRight />
                </HeaderIconButton>
              )}
              {!onChatRoute && (
                <HeaderIconButton
                  label={t("app.closeChat")}
                  onClick={() => setChatOpen(false)}
                  className="md:hidden"
                >
                  <X />
                </HeaderIconButton>
              )}
            </div>
            <div className="flex flex-col min-h-0 flex-1 px-5 pb-5 overflow-hidden">
              <ChatPanel
                historyOpen={historyOpen}
                setHistoryOpen={setHistoryOpen}
                layout={onChatRoute ? "page" : "panel"}
                onConversationChange={setActiveConversationId}
                pendingFocusAccountId={pendingFocusAccountId}
              />
            </div>
          </div>
        </div>
      </div>

      <Dialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} title="Keyboard shortcuts">
        <div>
          {[
            ["Show keyboard shortcuts", MOD_LABEL, "Shift", "7"],
            ["Swap light / dark theme", MOD_LABEL, "Shift", "L"],
            ["Toggle navigation sidebar", MOD_LABEL, "B"],
            ["Toggle agent chat sidebar", MOD_LABEL, "Shift", "B"],
            ["Open search", MOD_LABEL, "K"],
          ].map(([label, ...keys]) => (
            <div key={label} className="flex items-center justify-between gap-4 py-3 text-sm">
              <span>{label}</span>
              <span className="flex gap-1">
                {keys.map((key) => (
                  <Kbd key={key}>{key}</Kbd>
                ))}
              </span>
            </div>
          ))}
        </div>
      </Dialog>
      <Toaster />
      <CursorTooltip />
      <SearchPalette onofficeConfigured={Boolean(status?.onofficeConfigured)} />
      <AttachmentViewer />
    </div>
  );
}
