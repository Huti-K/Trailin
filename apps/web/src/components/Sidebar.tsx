import * as React from "react";
import { Link, useLocation } from "react-router-dom";
import { ChevronLeft, ChevronRight, Palette, TriangleAlert, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { isSetupComplete, type AppStatus } from "@trailin/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NAV_ITEMS } from "@/lib/nav";
import { cn } from "@/lib/utils";

interface SidebarProps {
  status: AppStatus | null;
  onClose: () => void;
  isCollapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
}

export function Sidebar({ status, onClose, isCollapsed, onCollapsedChange }: SidebarProps) {
  const { t } = useTranslation();
  const location = useLocation();
  const setupIncomplete = status !== null && !isSetupComplete(status);

  return (
    <aside className={cn("flex h-dvh shrink-0 flex-col bg-sidebar transition-[width] duration-200", isCollapsed ? "w-64 md:w-16" : "w-64")}>
      <div className={cn("flex items-center gap-2 pb-3 pt-4", isCollapsed ? "px-3 md:justify-center md:px-0" : "px-3")}>
        <Link 
          to="/" 
          onClick={onClose}
          className="flex items-center gap-2 shrink-0 transition-all duration-200"
          title="Go to Homepage"
        >
          <img src="/logo.svg" alt="Trailin Logo" className="h-8 w-auto object-contain transition-opacity hover:opacity-80" />
          <span className={cn("font-semibold tracking-tight text-lg transition-all duration-200", isCollapsed && "md:hidden")}>
            Trailin
          </span>
        </Link>

        {status?.demo && (
          <Badge variant="muted" className={cn("shrink-0", isCollapsed && "md:hidden")}>
            {t("sidebar.demoBadge")}
          </Badge>
        )}

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



      <nav className={cn("flex flex-1 flex-col gap-1 pt-3", isCollapsed ? "px-3 md:px-2 md:items-center" : "px-3")}>
        {NAV_ITEMS.map(({ id, path, icon: Icon }) => {
          const isActive = location.pathname === path || (path !== "/" && location.pathname.startsWith(path));
          return (
            <Link
              key={id}
              to={path}
              onClick={onClose}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "group relative flex items-center gap-3 rounded-lg py-2 text-sm font-medium transition-colors",
                isCollapsed ? "md:px-0 md:w-10 md:justify-center px-3" : "px-3",
                isActive
                  ? "tint-accent"
                  : "text-muted-foreground hover:bg-secondary hover:text-foreground",
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className={cn(isCollapsed && "md:hidden")}>
                {t(`views.${id}.title` as any)}
              </span>
              {isCollapsed && (
                <div className="absolute left-full top-1/2 ml-2 -translate-y-1/2 rounded-md bg-foreground px-2 py-1 text-xs font-medium text-background opacity-0 shadow-sm transition-all group-hover:translate-x-1 group-hover:opacity-100 pointer-events-none z-50 md:block hidden whitespace-nowrap">
                  {t(`views.${id}.title` as any)}
                </div>
              )}
            </Link>
          );
        })}

        {/* DEV showcase — delete this block with the /showcase route. */}
        {import.meta.env.DEV &&
          (() => {
            const isActive = location.pathname.startsWith("/showcase");
            return (
              <Link
                to="/showcase"
                onClick={onClose}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "group relative flex items-center gap-3 rounded-lg py-2 text-sm font-medium transition-colors",
                  isCollapsed ? "md:px-0 md:w-10 md:justify-center px-3" : "px-3",
                  isActive
                    ? "tint-accent"
                    : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                )}
              >
                <Palette className="h-4 w-4 shrink-0" />
                <span className={cn(isCollapsed && "md:hidden")}>
                  Showcase
                </span>
                {isCollapsed && (
                  <div className="absolute left-full top-1/2 ml-2 -translate-y-1/2 rounded-md bg-foreground px-2 py-1 text-xs font-medium text-background opacity-0 shadow-sm transition-all group-hover:translate-x-1 group-hover:opacity-100 pointer-events-none z-50 md:block hidden whitespace-nowrap">
                    Showcase
                  </div>
                )}
              </Link>
            );
          })()}
      </nav>

      <div className={cn("mt-auto flex flex-col gap-2 p-3", isCollapsed && "md:items-center md:px-0")}>
        {setupIncomplete && (
          <Link
            to="/settings"
            onClick={onClose}
            className={cn(
              "group relative flex items-center gap-3 rounded-lg py-2 text-sm font-medium text-warning transition-colors hover:bg-secondary",
              isCollapsed ? "md:px-0 md:w-10 md:justify-center px-3" : "px-3 w-full"
            )}
          >
            <TriangleAlert className="h-4 w-4 shrink-0" />
            <span className={cn(isCollapsed && "md:hidden")}>
              {t("sidebar.finishSetup")}
            </span>
            {isCollapsed && (
              <div className="absolute left-full top-1/2 ml-2 -translate-y-1/2 rounded-md bg-foreground px-2 py-1 text-xs font-medium text-background opacity-0 shadow-sm transition-all group-hover:translate-x-1 group-hover:opacity-100 pointer-events-none z-50 md:block hidden whitespace-nowrap">
                {t("sidebar.finishSetup")}
              </div>
            )}
          </Link>
        )}
        
        <Button
          variant="ghost"
          size="icon"
          onClick={() => onCollapsedChange(!isCollapsed)}
          className={cn("hidden md:flex shrink-0", !isCollapsed && "ml-auto")}
          aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          data-tooltip={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {isCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
        </Button>
      </div>
    </aside>
  );
}
