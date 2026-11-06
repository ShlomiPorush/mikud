// Every page and its address. refresh.guard.test.ts reads PAGES and fails on a page module that
// registers no refresh of its own (v3 SV-10), unless it is listed there with its reason.

import type { ComponentType } from "react"
import { createBrowserRouter, Navigate, useParams } from "react-router"
import { AccountPage } from "./pages/AccountPage.tsx"
import { ActivityPage } from "./pages/ActivityPage.tsx"
import { ArchivePage } from "./pages/ArchivePage.tsx"
import { ConnectDevicePage } from "./pages/auth/ConnectDevicePage.tsx"
import { LoginPage } from "./pages/auth/LoginPage.tsx"
import { SetupPage } from "./pages/auth/SetupPage.tsx"
import { InboxPage } from "./pages/InboxPage.tsx"
import { MorningPage } from "./pages/MorningPage.tsx"
import { NotePage } from "./pages/NotePage.tsx"
import { NotesPage } from "./pages/NotesPage.tsx"
import { NotFoundPage } from "./pages/NotFoundPage.tsx"
import { ProjectPage } from "./pages/ProjectPage.tsx"
import { ProjectsPage } from "./pages/ProjectsPage.tsx"
import { SettingsPage } from "./pages/SettingsPage.tsx"
import { Root } from "./shell/Root.tsx"
import { Shell } from "./shell/Shell.tsx"

type PageRoute = { id: string; path: string; Component: ComponentType }

export const PAGES: readonly PageRoute[] = [
  { id: "morning", path: "/", Component: MorningPage },
  { id: "projects", path: "/projects", Component: ProjectsPage },
  { id: "project", path: "/projects/:projectId", Component: ProjectPage },
  { id: "inbox", path: "/inbox", Component: InboxPage },
  { id: "notes", path: "/notes", Component: NotesPage },
  // /notes/new writes a new note; any other id opens that note.
  { id: "note", path: "/notes/:noteId", Component: NotePage },
  { id: "archive", path: "/archive", Component: ArchivePage },
  { id: "activity", path: "/activity", Component: ActivityPage },
  { id: "account", path: "/account", Component: AccountPage },
  // One route for /settings and every /settings/<section>, so the page and its draft stay mounted between sections.
  { id: "settings", path: "/settings/:section?", Component: SettingsPage },
  { id: "not-found", path: "*", Component: NotFoundPage },
]

/** A deep link /items/:id (Telegram) opens the item over the morning view. */
function ItemLink() {
  const { itemId = "" } = useParams()
  return <Navigate to={`/?item=${encodeURIComponent(itemId)}`} replace />
}

export function createRouter() {
  return createBrowserRouter([
    {
      element: <Root />,
      children: [
        { path: "/login", element: <LoginPage /> },
        { path: "/setup", element: <SetupPage /> },
        // Inside the session gate, outside the frame: a signed-out browser signs in and comes back with its code.
        { path: "/connect/device", element: <ConnectDevicePage /> },
        {
          element: <Shell />,
          children: [
            ...PAGES.map(({ path, Component }) => ({ path, element: <Component /> })),
            { path: "/items/:itemId", element: <ItemLink /> },
            // Account was a Settings section before it had a page of its own.
            { path: "/settings/account", element: <Navigate to="/account" replace /> },
          ],
        },
      ],
    },
  ])
}
