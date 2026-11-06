// @vitest-environment happy-dom
// The morning view's two columns (Q-1, v3 NL-17): the parts are in the DOM in the reading order (waiting,
// security, new, agent updates, projects), waiting and security inside the first column's wrapper, new and agent
// updates inside the second's, projects after both; the Tab order follows the DOM, and no CSS rule of the layout
// reorders it. The data is invented.

import { readFileSync } from "node:fs"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, StrictMode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { createMemoryRouter, RouterProvider } from "react-router"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { setTransport, type TransportRequest } from "../api/client.ts"
import { qk } from "../api/endpoints.ts"
import type { ItemSummary, Morning } from "../api/types.ts"
import { I18nProvider } from "../i18n/i18n.tsx"
import { ConfirmHost } from "../ui/confirm.tsx"
import { ToastHost } from "../ui/Toast.tsx"
import { UnsavedProvider } from "../ui/unsaved.tsx"
import { MorningPage } from "./MorningPage.tsx"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const AT = "2026-11-02T06:30:00.000Z"

const item = (id: string, title: string, status: ItemSummary["status"]): ItemSummary => ({
  id,
  projectId: "p-lantern",
  projectName: "Lantern",
  type: "task",
  status,
  title,
  severity: null,
  goalId: null,
  version: 1,
  statusSetBy: "owner",
  createdAt: AT,
  updatedAt: AT,
  closedAt: null,
})

const MORNING: Morning = {
  now: "2026-11-02T07:00:00.000Z",
  since: "2026-11-01T07:00:00.000Z",
  waiting: [
    { kind: "item", at: AT, item: item("i-wait", "Approve the trellis plan", "waiting_on_you") },
    {
      kind: "stage_proposal",
      at: AT,
      proposal: {
        id: "sp-1",
        projectId: "p-lantern",
        projectName: "Lantern",
        currentStage: "development",
        proposedStage: "production",
        reason: null,
        authorKind: "agent",
        authorLabel: "Garden agent",
        createdAt: AT,
      },
    },
  ],
  new: [{ change: "created", item: item("i-new", "Water the moss garden", "todo") }],
  security: [
    {
      projectId: "p-lantern",
      projectName: "Lantern",
      stage: "production",
      critical: 1,
      high: 0,
      alerts: { critical: 1, high: 0 },
      items: { critical: 0, high: 0 },
      asOf: AT,
      stale: false,
    },
  ],
  agentUpdates: [
    {
      projectId: "p-lantern",
      projectName: "Lantern",
      generalNotes: false,
      updates: [
        {
          kind: "comment",
          at: AT,
          itemId: "i-new",
          itemTitle: "Water the moss garden",
          actorKind: "agent",
          actorLabel: "Garden agent",
          text: "The hose is in the shed.",
        },
      ],
    },
  ],
  projects: [
    {
      id: "p-lantern",
      name: "Lantern",
      slug: "lantern",
      stage: "production",
      goal: null,
      whereWeAre: "Planting the second bed",
      openItems: 2,
      openIssues: null,
      openIssuesAsOf: null,
      repo: null,
    },
  ],
  inboxCount: 0,
  sync: { lastSuccessAt: AT, stale: false, lastPartialAt: null, securityLastSuccessAt: AT },
}

let morning: Morning = MORNING

async function transport({ method, path }: TransportRequest) {
  if (path.startsWith("/morning") && method === "GET") return { status: 200, body: { data: morning } }
  if (path === "/visits") return { status: 200, body: { data: { at: MORNING.now, previous: null } } }
  return { status: 404, body: { error: { code: "not_found", message: "Not here." } } }
}

let mounted: { root: Root; host: HTMLElement } | null = null

async function render(): Promise<void> {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  mounted = { root, host }
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(qk.session, { actor: { kind: "owner", label: "owner.name" } })
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: (
          <UnsavedProvider>
            <MorningPage />
            <ConfirmHost />
            <ToastHost />
          </UnsavedProvider>
        ),
      },
    ],
    { initialEntries: ["/"] },
  )
  await act(async () => {
    root.render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <I18nProvider>
            <RouterProvider router={router} />
          </I18nProvider>
        </QueryClientProvider>
      </StrictMode>,
    )
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60))
  })
}

/** What Tab reaches, in order: no element in the page has a positive tabindex, so it is the DOM order. */
const tabStops = (scope: ParentNode) =>
  Array.from(
    scope.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), summary, [tabindex]:not([tabindex='-1'])"),
  )

/** The section that holds an element, by its id. */
const sectionOf = (element: Element) => element.closest("section")?.id

beforeEach(() => {
  morning = MORNING
  localStorage.setItem("mikud.language", "en")
  setTransport(transport)
})

afterEach(() => {
  if (mounted) {
    const { root, host } = mounted
    act(() => root.unmount())
    host.remove()
    mounted = null
  }
  localStorage.clear()
})

describe("the morning view's columns", () => {
  it("puts the parts in the reading order, each column in its own wrapper", async () => {
    await render()
    const layout = document.querySelector(".ui-morning")
    expect(layout).toBeTruthy()
    const order = Array.from(layout?.querySelectorAll("section.ui-panel") ?? []).map((section) => section.id)
    expect(order).toEqual(["waiting", "security", "new", "updates", "projects"])

    const columns = Array.from(layout?.children ?? [])
    expect(columns.map((child) => child.getAttribute("data-column") ?? child.id)).toEqual([
      "first",
      "second",
      "projects",
    ])
    const ids = (column: Element | undefined) =>
      Array.from(column?.querySelectorAll(":scope > section") ?? []).map((section) => section.id)
    expect(columns[0]?.classList.contains("ui-morning-col")).toBe(true)
    expect(ids(columns[0])).toEqual(["waiting", "security"])
    expect(columns[1]?.classList.contains("ui-morning-col")).toBe(true)
    expect(ids(columns[1])).toEqual(["new", "updates"])
  })

  it("lets Tab walk the parts in the same order", async () => {
    await render()
    const layout = document.querySelector(".ui-morning") as HTMLElement
    expect(
      Array.from(layout.querySelectorAll("[tabindex]")).every(
        (element) => Number(element.getAttribute("tabindex")) <= 0,
      ),
    ).toBe(true)
    const visited: string[] = []
    for (const stop of tabStops(layout)) {
      const id = sectionOf(stop)
      if (id && visited.at(-1) !== id) visited.push(id)
    }
    expect(visited).toEqual(["waiting", "security", "new", "updates", "projects"])
  })

  it("has no CSS rule that reorders the layout", () => {
    const css = readFileSync("src/web/styles/ui.css", "utf8")
    const rules = Array.from(css.matchAll(/([^{}]*\.ui-morning[^{}]*)\{([^{}]*)\}/g))
    expect(rules.length).toBeGreaterThan(0)
    for (const [, selector, body] of rules) {
      expect(body, selector?.trim()).not.toMatch(
        /(^|[\s;])(order|grid-row|grid-area|direction)\s*:|display:\s*contents/,
      )
    }
  })
})

describe("agent updates", () => {
  it("link an agent and the sync to their own activity, and leave other labels as text (A-2)", async () => {
    const update = MORNING.agentUpdates[0]?.updates[0]
    if (!update) throw new Error("no update")
    morning = {
      ...MORNING,
      agentUpdates: [
        {
          projectId: "p-lantern",
          projectName: "Lantern",
          generalNotes: false,
          updates: [
            { ...update, actorLabel: "agent:garden" },
            { ...update, at: "2026-11-02T06:20:00.000Z", actorKind: "sync", actorLabel: "sync" },
            { ...update, at: "2026-11-02T06:10:00.000Z", actorLabel: "Garden agent" },
          ],
        },
      ],
    }
    await render()
    const links = Array.from(document.querySelectorAll<HTMLAnchorElement>("#updates .ui-update a.ui-link"))
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/activity?agent=agent%3Agarden",
      "/activity?actorKind=sync",
    ])
    expect(document.querySelector("#updates")?.textContent).toContain("Garden agent")
  })
})
