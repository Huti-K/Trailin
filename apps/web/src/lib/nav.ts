import { BookOpen, CalendarClock, Inbox, MessagesSquare, Settings2, type LucideIcon } from "lucide-react";

export type View = "home" | "chat" | "automations" | "knowledge" | "settings";

export interface NavItem {
  id: View;
  path: string;
  icon: LucideIcon;
}

/**
 * Single source of truth for the 5-item primary nav. The Sidebar, the
 * command palette's shortcut list, and App.tsx's route-name validation all
 * read from this one array instead of keeping their own copies in sync.
 */
export const NAV_ITEMS: NavItem[] = [
  { id: "home", path: "/", icon: Inbox },
  { id: "chat", path: "/chat", icon: MessagesSquare },
  { id: "automations", path: "/automations", icon: CalendarClock },
  { id: "knowledge", path: "/knowledge", icon: BookOpen },
  { id: "settings", path: "/settings", icon: Settings2 },
];

export const NAV_VIEWS: View[] = NAV_ITEMS.map((item) => item.id);
