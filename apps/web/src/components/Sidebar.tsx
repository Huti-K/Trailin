import { type AppStatus, isSetupComplete } from "@trailin/shared";
import { ChevronLeft, ChevronRight, type LucideIcon, TriangleAlert, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { UpdatePill, usePendingUpdate } from "@/components/UpdatePill";
import { Button } from "@/components/ui/button";
import { visibleNavItems } from "@/lib/nav";
import { cn, withViewTransition } from "@/lib/utils";

interface SidebarProps {
  status: AppStatus | null;
  onClose: () => void;
  isCollapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
}

interface SidebarNavLinkProps {
  to: string;
  icon: LucideIcon;
  label: string;
  isCollapsed: boolean;
  onClick: () => void;
  active?: boolean;
  /** "warning" is the "finish setup" nudge — always warning-toned, never tracks route match. */
  tone?: "default" | "warning";
}

/** Icon + label nav link, with the shared collapsed-sidebar hover tooltip. */
function SidebarNavLink({
  to,
  icon: Icon,
  label,
  isCollapsed,
  onClick,
  active = false,
  tone = "default",
}: SidebarNavLinkProps) {
  const isWarning = tone === "warning";
  const navigate = useNavigate();
  return (
    <Link
      to={to}
      onClick={(event) => {
        onClick();
        // A modified click still means "open elsewhere", so leave those to the
        // browser and keep the real href. A plain one navigates here instead,
        // inside a view transition: BrowserRouter is not a data router, so
        // react-router's own `viewTransition` never fires.
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        withViewTransition(() => navigate(to));
      }}
      aria-current={!isWarning && active ? "page" : undefined}
      className={cn(
        "group relative flex items-center gap-3 rounded-lg py-2 text-sm font-medium transition-colors",
        isCollapsed ? "md:px-0 md:w-10 md:justify-center px-3" : isWarning ? "px-3 w-full" : "px-3",
        isWarning
          ? "text-warning hover:bg-accent/[0.08]"
          : active
            ? "tint-accent"
            : "text-muted-foreground hover:bg-accent/[0.08] hover:text-foreground",
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className={cn(isCollapsed && "md:hidden")}>{label}</span>
      {isCollapsed && (
        <div className="absolute left-full top-1/2 ml-2 -translate-y-1/2 rounded-md bg-foreground px-2 py-1 text-xs font-medium text-background opacity-0 transition-all group-hover:translate-x-1 group-hover:opacity-100 pointer-events-none z-50 md:block hidden whitespace-nowrap">
          {label}
        </div>
      )}
    </Link>
  );
}

export function Sidebar({ status, onClose, isCollapsed, onCollapsedChange }: SidebarProps) {
  const { t } = useTranslation();
  const location = useLocation();
  const pendingUpdate = usePendingUpdate();
  const setupIncomplete = status !== null && !isSetupComplete(status);

  return (
    <aside
      className={cn(
        "surface-fills flex h-dvh shrink-0 flex-col bg-sidebar transition-[width] duration-200",
        isCollapsed ? "w-64 md:w-16" : "w-64",
      )}
    >
      <div
        className={cn(
          // titlebar-pad/drag are inert unless the desktop shell floats the
          // window controls over this corner (macOS); then this row clears them
          // and doubles as the window drag handle.
          "titlebar-pad titlebar-drag flex items-center gap-2 pb-3 pt-4",
          isCollapsed ? "px-3 md:justify-center md:px-0" : "px-3",
        )}
      >
        <Link
          to="/"
          onClick={onClose}
          className="flex items-center gap-2 shrink-0 transition-all duration-200"
          title="Go to Homepage"
        >
          <img
            src="/logo.svg"
            alt="Trailin Logo"
            className="h-8 w-auto object-contain transition-opacity hover:opacity-80"
          />
          <span
            className={cn(
              "font-semibold tracking-tight text-lg transition-all duration-200",
              isCollapsed && "md:hidden",
            )}
          >
            Trailin
          </span>
        </Link>

        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          className="ml-auto shrink-0 md:hidden"
          aria-label={t("sidebar.closeMenu")}
          data-tooltip={t("sidebar.closeMenu")}
        >
          <X />
        </Button>
      </div>

      <nav
        className={cn(
          "flex flex-1 flex-col gap-1 pt-3",
          isCollapsed ? "px-3 md:px-2 md:items-center" : "px-3",
        )}
      >
        {visibleNavItems(Boolean(status?.onofficeConfigured)).map(({ id, path, icon }) => {
          const isActive =
            location.pathname === path || (path !== "/" && location.pathname.startsWith(path));
          return (
            <SidebarNavLink
              key={id}
              to={path}
              icon={icon}
              label={t(`views.${id}.title`)}
              isCollapsed={isCollapsed}
              onClick={onClose}
              active={isActive}
            />
          );
        })}
      </nav>

      <div
        className={cn("mt-auto flex flex-col gap-2 p-3", isCollapsed && "md:items-center md:px-0")}
      >
        {setupIncomplete && (
          <SidebarNavLink
            to="/settings"
            icon={TriangleAlert}
            label={t("sidebar.finishSetup")}
            isCollapsed={isCollapsed}
            onClick={onClose}
            tone="warning"
          />
        )}

        <Button
          variant="ghost"
          size="icon"
          onClick={() => onCollapsedChange(!isCollapsed)}
          className={cn("hidden md:flex shrink-0", !isCollapsed && "ml-auto")}
          aria-label={t(isCollapsed ? "sidebar.expand" : "sidebar.collapse")}
          data-tooltip={t(isCollapsed ? "sidebar.expand" : "sidebar.collapse")}
        >
          {isCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
        </Button>

        {pendingUpdate && <UpdatePill version={pendingUpdate} isCollapsed={isCollapsed} />}
      </div>
    </aside>
  );
}
