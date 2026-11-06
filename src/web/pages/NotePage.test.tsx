// @vitest-environment happy-dom
// The note page under StrictMode against a stand-in server (requirements section 10; plan review P9, P12): a
// background refresh never replaces what the owner types; a save sends the version the typing started on, so an
// agent's edit made meanwhile answers version_conflict, the draft stays and the page says so; saving again goes
// over it knowingly. Restore sends the version on screen. The Markdown preview renders no raw HTML, keeps no
// javascript: link, shows an image as a link and moves headings one level down. The data is invented.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, StrictMode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { createMemoryRouter, RouterProvider } from "react-router"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { setTransport, type TransportRequest, type TransportResponse } from "../api/client.ts"
import { qk } from "../api/endpoints.ts"
import type { Note } from "../api/types.ts"
import { I18nProvider } from "../i18n/i18n.tsx"
import { ConfirmHost } from "../ui/confirm.tsx"
import { Markdown } from "../ui/Markdown.tsx"
import { ToastHost } from "../ui/Toast.tsx"
import { UnsavedProvider } from "../ui/unsaved.tsx"
import { NotePage } from "./NotePage.tsx"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const NOTE_ID = "3e1f0a2b-4c5d-4e6f-8a9b-0c1d2e3f4a5b"
let note: Note
let requests: { method: string; path: string; body: unknown }[]
/** When set, a PATCH waits for it: a save that is still on its way. */
let hold: Promise<void> | null = null

function freshNote(): Note {
  return {
    id: NOTE_ID,
    projectId: null,
    title: "Watering schedule",
    body: "Water the ferns on Sunday.",
    version: 1,
    createdBy: "owner",
    createdByLabel: "owner",
    updatedBy: "owner",
    updatedByLabel: "owner",
    createdAt: "2026-11-05T08:00:00.000Z",
    updatedAt: "2026-11-05T08:00:00.000Z",
  }
}

/** An agent saves a new version on the server, as a background edit would. */
function agentEdits(body: string) {
  note = { ...note, body, version: note.version + 1, updatedBy: "agent", updatedByLabel: "agent:codex" }
}

async function server(request: TransportRequest): Promise<TransportResponse> {
  const path = request.path
  requests.push({ method: request.method, path, body: request.body })
  if (path === "/projects") return { status: 200, body: { data: [] } }
  if (path === `/notes/${NOTE_ID}` && request.method === "GET")
    return { status: 200, body: { data: { note, project: null } } }
  if (path.startsWith(`/notes/${NOTE_ID}/versions`)) return { status: 200, body: { data: [], nextCursor: null } }
  if (path === `/notes/${NOTE_ID}` && request.method === "PATCH") {
    if (hold) await hold
    const body = request.body as { version: number; body?: string }
    if (body.version !== note.version)
      return {
        status: 409,
        body: { error: { code: "version_conflict", message: "Changed.", currentVersion: note.version } },
      }
    note = { ...note, body: body.body ?? note.body, version: note.version + 1, updatedBy: "owner" }
    return { status: 200, body: { data: note } }
  }
  return { status: 404, body: { error: { code: "not_found", message: "Not here." } } }
}

let mounted: { root: Root; host: HTMLElement } | null = null
let queryClient: QueryClient

async function settle(ms = 30) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}

class StandInObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return []
  }
}

async function render(): Promise<void> {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  mounted = { root, host }
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(qk.session, { actor: { kind: "owner", label: "owner" } })
  const router = createMemoryRouter(
    [
      {
        path: "/notes/:noteId",
        element: (
          <UnsavedProvider>
            <NotePage />
            <ConfirmHost />
            <ToastHost />
          </UnsavedProvider>
        ),
      },
    ],
    { initialEntries: [`/notes/${NOTE_ID}`] },
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
  await settle(60)
}

async function click(element: Element | null | undefined) {
  if (!element) throw new Error("nothing to click")
  await act(async () => {
    ;(element as HTMLElement).click()
  })
  await settle()
}

async function type(field: HTMLTextAreaElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set
    setter?.call(field, value)
    field.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await settle()
}

const button = (text: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent?.trim() === text)
const textarea = () => document.querySelector<HTMLTextAreaElement>("#note-body")
const patches = () => requests.filter((r) => r.method === "PATCH").map((r) => r.body as { version: number })

beforeEach(() => {
  localStorage.setItem("mikud.language", "en")
  ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = StandInObserver
  note = freshNote()
  requests = []
  hold = null
  setTransport(server)
})
afterEach(() => {
  act(() => mounted?.root.unmount())
  mounted?.host.remove()
  mounted = null
  document.body.innerHTML = ""
})

describe("the note page", () => {
  it("keeps a draft through a refresh, refuses a save over an agent's edit, and saves again knowingly", async () => {
    await render()
    await click(button("Write"))
    await type(textarea() as HTMLTextAreaElement, "Water the ferns on Sunday and Wednesday.")
    agentEdits("Water the ferns on Sunday. Mist them daily.")
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: qk.note(NOTE_ID) })
    })
    await settle()
    expect(textarea()?.value).toBe("Water the ferns on Sunday and Wednesday.")

    await click(button("Save changes"))
    expect(patches()).toEqual([expect.objectContaining({ version: 1 })])
    expect(document.body.textContent).toContain("The note changed while you were typing")
    expect(textarea()?.value).toBe("Water the ferns on Sunday and Wednesday.")
    expect(note.body).toBe("Water the ferns on Sunday. Mist them daily.")

    await click(button("Save changes"))
    expect(patches().at(-1)).toEqual(
      expect.objectContaining({ version: 2, body: "Water the ferns on Sunday and Wednesday." }),
    )
    expect(note).toMatchObject({ version: 3, body: "Water the ferns on Sunday and Wednesday." })
    expect(document.querySelector(".ui-savebar")).toBeNull()
  })

  it("keeps the fields read only while a save is on its way, so nothing typed then is lost (R4)", async () => {
    await render()
    await click(button("Write"))
    await type(textarea() as HTMLTextAreaElement, "Saved text")
    let release!: () => void
    hold = new Promise<void>((resolve) => {
      release = resolve
    })
    await click(button("Save changes"))
    expect(textarea()?.readOnly).toBe(true)
    await act(async () => release())
    await settle()
    expect(textarea()?.readOnly).toBe(false)
    expect(textarea()?.value).toBe("Saved text")
    expect(note.body).toBe("Saved text")
  })

  it("drops the draft on Reload after a conflict and shows the agent's text", async () => {
    await render()
    await click(button("Write"))
    await type(textarea() as HTMLTextAreaElement, "Mine")
    agentEdits("The agent's")
    await click(button("Save changes"))
    await click(button("Reload"))
    expect(textarea()?.value).toBe("The agent's")
    expect(document.querySelector(".ui-savebar")).toBeNull()
  })
})

describe("the Markdown preview", () => {
  async function renderMarkdown(text: string) {
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    mounted = { root, host }
    await act(async () => root.render(<Markdown text={text} />))
    return host
  }

  it("keeps no javascript: link and renders no raw HTML", async () => {
    const host = await renderMarkdown(
      '[click](javascript:alert(1)) <script>alert(2)</script> <img src="x" onerror="alert(3)"> [ok](https://example.com/a)',
    )
    const links = Array.from(host.querySelectorAll("a"))
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["https://example.com/a"])
    expect(links[0]?.getAttribute("rel")).toBe("noopener noreferrer")
    expect(host.querySelector("script")).toBeNull()
    expect(host.querySelector("img")).toBeNull()
    expect(host.textContent).toContain("click")
  })

  it("shows an image as a link, moves headings one level down and keeps code left to right", async () => {
    const host = await renderMarkdown("# Top\n\n## Second\n\n![chart](https://example.com/c.png)\n\n```\nx = 1\n```")
    expect(host.querySelector("h1")).toBeNull()
    expect(host.querySelector("h2")?.textContent).toBe("Top")
    expect(host.querySelector("h3")?.textContent).toBe("Second")
    expect(host.querySelector("img")).toBeNull()
    expect(host.querySelector("a.ui-md-image")?.getAttribute("href")).toBe("https://example.com/c.png")
    expect(host.querySelector("pre")?.getAttribute("dir")).toBe("ltr")
  })
})
