// The pages in the navigation, in one list for the sidebar, the rail, the phone tab bar and the
// phone More sheet.

import {
  Archive,
  FolderKanban,
  History,
  Inbox,
  LayoutDashboard,
  type LucideIcon,
  NotebookText,
  Settings,
} from "lucide-react"

export type NavPage = {
  id: "morning" | "projects" | "inbox" | "notes" | "archive" | "activity" | "settings"
  to: string
  icon: LucideIcon
  /** In the phone tab bar; the others are in the More sheet. */
  tab: boolean
}

export const NAV: readonly NavPage[] = [
  { id: "morning", to: "/", icon: LayoutDashboard, tab: true },
  { id: "projects", to: "/projects", icon: FolderKanban, tab: true },
  { id: "inbox", to: "/inbox", icon: Inbox, tab: true },
  { id: "notes", to: "/notes", icon: NotebookText, tab: false },
  { id: "activity", to: "/activity", icon: History, tab: true },
  { id: "archive", to: "/archive", icon: Archive, tab: false },
  { id: "settings", to: "/settings", icon: Settings, tab: false },
]

/** The Account page: outside the navigation, opened from the account menu. */
export const ACCOUNT_PATH = "/account"

/** The navigation item that a path belongs to. */
export function navPageFor(pathname: string): NavPage | null {
  if (pathname === "/") return NAV[0] ?? null
  return NAV.find((page) => page.to !== "/" && (pathname === page.to || pathname.startsWith(`${page.to}/`))) ?? null
}

export function navIdFor(pathname: string): NavPage["id"] | null {
  return navPageFor(pathname)?.id ?? null
}
