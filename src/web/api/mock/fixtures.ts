// Invented data for the mock API (development and screenshots only; never in the production build).
// Every project, item and name here is made up. Times are relative to the moment the mock starts.
// scripts/lib/web-dist-check.sh fails when the mock storage key ("mikud.mock.") is found in dist/web.

import type { ItemStatus, ItemType, Severity, Stage } from "../../../shared/enums.ts"
import type {
  AgentKey,
  AuditEntry,
  BrowserSession,
  Comment,
  Item,
  Note,
  NoteVersion,
  Project,
  SecuritySource,
  Settings,
  StageProposal,
  Suppression,
  ThreadLink,
} from "../types.ts"

const now = Date.now()
const HOUR = 3_600_000
export const ago = (hours: number) => new Date(now - hours * HOUR).toISOString()

let counter = 0
/** Stable, valid-looking UUIDs for invented records. */
export function uuid(): string {
  counter++
  const hex = counter.toString(16).padStart(12, "0")
  return `00000000-0000-4000-8000-${hex}`
}

/** The mock starts in the language this browser last used, so both languages can be shown. */
function storedLanguage(): "he" | "en" {
  try {
    return localStorage.getItem("mikud.language") === "en" ? "en" : "he"
  } catch {
    return "he"
  }
}

/**
 * What the mock pretends the environment sets, for screenshots of locked settings (FS-6): `mikud.mock.env` in
 * localStorage holds variable names separated by commas (MIKUD_TELEGRAM_BOT_TOKEN, MIKUD_TELEGRAM_CHAT_ID,
 * MIKUD_PRIVATE_DOMAINS); `mikud.mock.telegram` set to "off" starts with no bot token and no chat id.
 */
function mockEnv(): { variables: Set<string>; telegramOff: boolean } {
  try {
    const variables = (localStorage.getItem("mikud.mock.env") ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean)
    return { variables: new Set(variables), telegramOff: localStorage.getItem("mikud.mock.telegram") === "off" }
  } catch {
    return { variables: new Set(), telegramOff: false }
  }
}

function mockSettings(): Settings {
  const env = mockEnv()
  const lock = (variable: string) =>
    env.variables.has(variable) ? { locked: true, variable } : { locked: false, variable: null }
  const tokenLock = lock("MIKUD_TELEGRAM_BOT_TOKEN")
  const chatLock = lock("MIKUD_TELEGRAM_CHAT_ID")
  const tokenSet = tokenLock.locked || !env.telegramOff
  const chatId = chatLock.locked ? "70012345" : env.telegramOff ? null : "4242"
  const missing = [...(tokenSet ? [] : ["botToken" as const]), ...(chatId ? [] : ["chatId" as const])]
  const state = missing.length === 0 ? "on" : missing.length === 2 ? "off" : "incomplete"
  const domainsLock = lock("MIKUD_PRIVATE_DOMAINS")
  return {
    id: uuid(),
    closedItemDays: 7,
    dateFormat: "dd/MM/yyyy",
    timeFormat: "HH:mm",
    language: storedLanguage(),
    sessionIdleDays: 30,
    otpViaTelegram: false,
    updatedAt: ago(50),
    telegram: {
      botToken: { set: tokenSet, readable: true, ...tokenLock },
      chatId: { value: chatId, ...chatLock },
      state,
      missing: state === "off" ? [] : missing,
    },
    privateDomains: {
      value: domainsLock.locked ? ["corp.example", "lab.example"] : ["corp.example"],
      ...domainsLock,
    },
  }
}

export type MockGoal = { id: string; projectId: string; text: string; createdAt: string; closedAt: string | null }

export type MockState = {
  projects: Project[]
  goals: MockGoal[]
  items: Item[]
  threads: ThreadLink[]
  comments: Comment[]
  proposals: StageProposal[]
  sources: SecuritySource[]
  audit: AuditEntry[]
  notes: Note[]
  noteVersions: NoteVersion[]
  browserId: string
  /** Better Auth's list-sessions, the current one first. */
  sessions: BrowserSession[]
  endedOthers: boolean
  agentKeys: AgentKey[]
  suppressions: Suppression[]
  settings: Settings
  previousVisit: string
}

function project(
  name: string,
  stage: Stage | null,
  repo: string | null,
  where: string | null,
  issues: number | null,
): Project {
  return {
    id: uuid(),
    name,
    slug: name.toLowerCase().replace(/\s+/g, "-"),
    t3ProjectId: `t3-${name.toLowerCase().replace(/\s+/g, "-")}`,
    githubRepo: repo,
    stage,
    whereWeAre: where,
    openIssuesCount: issues,
    openIssuesAsOf: issues === null ? null : ago(9),
    createdAt: ago(24 * 60),
    updatedAt: ago(5),
  }
}

export function createState(): MockState {
  const lantern = project(
    "Lantern",
    "production",
    "example-owner/lantern",
    "Release 2.4 is out; watching error rates after the cache change.",
    7,
  )
  const tidepool = project(
    "Tidepool",
    "development",
    "example-owner/tidepool",
    "Import pipeline works end to end; the review screen is next.",
    3,
  )
  const quill = project(
    "Quill",
    "poc",
    "example-owner/quill",
    "Trying two editors; the second one handles right-to-left text better.",
    0,
  )
  const orchard = project("Orchard", "idea", null, null, null)
  const beacon = project(
    "Beacon",
    "redesign",
    "example-owner/beacon",
    "New navigation drafted; old screens still in use.",
    12,
  )
  const kettle = project("Kettle", null, "example-owner/kettle", null, 1)
  const driftwood = project("Driftwood", "frozen", null, "Paused until the hardware arrives.", null)
  const projects = [lantern, tidepool, quill, orchard, beacon, kettle, driftwood]

  const goals: MockGoal[] = [
    {
      id: uuid(),
      projectId: lantern.id,
      text: "Ship offline mode to every customer",
      createdAt: ago(24 * 20),
      closedAt: null,
    },
    {
      id: uuid(),
      projectId: tidepool.id,
      text: "First public beta with CSV import",
      createdAt: ago(24 * 12),
      closedAt: null,
    },
    { id: uuid(), projectId: beacon.id, text: "Replace the old dashboard", createdAt: ago(24 * 30), closedAt: null },
  ]
  const goalOf = (p: Project) => goals.find((goal) => goal.projectId === p.id)?.id ?? null

  const items: Item[] = []
  const add = (
    p: Project | null,
    type: ItemType,
    status: ItemStatus,
    title: string,
    hours: number,
    extra: Partial<Item> = {},
  ): Item => {
    const closed = status === "done" || status === "not_relevant"
    const item: Item = {
      id: uuid(),
      projectId: p?.id ?? null,
      type,
      status,
      title,
      body: null,
      severity: null,
      goalId: p ? goalOf(p) : null,
      version: 3,
      statusSetBy: "agent",
      statusSetAt: ago(hours),
      createdBy: "agent",
      imported: false,
      createdAt: ago(hours + 30),
      updatedAt: ago(hours),
      closedAt: closed ? ago(hours) : null,
      ...extra,
    }
    items.push(item)
    return item
  }

  const merge = add(lantern, "decision", "waiting_on_you", "Approve the merge of the cache invalidation fix", 2, {
    body: "The fix is ready and reviewed. CI is green. It changes how the cache expires after a deploy, so it needs your approval before it goes to production.",
  })
  add(tidepool, "task", "waiting_on_you", "Manual test: import a 40 MB CSV on the phone", 5)
  add(beacon, "decision", "waiting_on_you", "Pick one of the two navigation drafts", 26)
  add(lantern, "security", "in_progress", "Rotate the signing key used by the webhook relay", 3, {
    severity: "critical" as Severity,
  })
  add(lantern, "bug", "in_progress", "Offline queue drops edits made during a reconnect", 1)
  add(lantern, "task", "todo", "Write the offline mode release notes", 40)
  add(lantern, "task", "done", "Add retry with backoff to the sync worker", 30)
  add(lantern, "task", "done", "Measure cold start on older phones", 70)
  add(tidepool, "task", "in_progress", "Review screen for imported rows", 4)
  add(tidepool, "bug", "todo", "Dates in imported files shift by one day near midnight", 20)
  add(tidepool, "idea", "future", "Let the import remember column mappings per source", 200)
  add(tidepool, "task", "done", "Stream parsing for large files", 50)
  add(quill, "task", "in_progress", "Compare caret movement in mixed Hebrew and English text", 6)
  add(quill, "idea", "future", "Keyboard shortcuts cheat sheet", 300)
  add(beacon, "security", "todo", "Update the image library with the parsing fix", 15, { severity: "high" as Severity })
  add(beacon, "task", "todo", "Move the settings screen to the new layout", 60)
  add(kettle, "task", "todo", "Decide whether Kettle needs its own database", 90)
  add(driftwood, "task", "not_relevant", "Order a second test board", 400)
  add(null, "idea", "future", "A weekly summary that lists what moved stage", 7, {
    createdBy: "owner",
    statusSetBy: "owner",
  })
  add(null, "idea", "future", "Check whether the phone keyboard covers quick add", 30, {
    createdBy: "bot",
    statusSetBy: "bot",
  })
  add(null, "idea", "future", "Group agent updates by thread instead of by project", 52, {
    createdBy: "owner",
    statusSetBy: "owner",
  })

  const threads: ThreadLink[] = [
    {
      id: uuid(),
      itemId: merge.id,
      threadId: "thr_7f3a9c21e4",
      t3ProjectId: lantern.t3ProjectId,
      title: "Fix cache invalidation after deploy",
      lastStatus: "waiting",
      settled: false,
      lastActivityAt: ago(2),
      linkedAt: ago(30),
    },
    {
      id: uuid(),
      itemId: merge.id,
      threadId: "thr_51b0d8aa02",
      t3ProjectId: lantern.t3ProjectId,
      title: "Reproduce stale cache on staging",
      lastStatus: "completed",
      settled: true,
      lastActivityAt: ago(20),
      linkedAt: ago(32),
    },
  ]

  const comments: Comment[] = [
    {
      id: uuid(),
      itemId: merge.id,
      authorKind: "agent",
      authorLabel: "agent:claude",
      text: "Reproduced on staging, fixed the expiry order, added a test that fails on the old code. Waiting for the merge approval.",
      threadId: "thr_7f3a9c21e4",
      noteId: null,
      createdAt: ago(2),
    },
    {
      id: uuid(),
      itemId: items[4]?.id ?? merge.id,
      authorKind: "agent",
      authorLabel: "agent:codex",
      text: "Found the race: the reconnect handler clears the queue before the last flush finishes.",
      threadId: null,
      noteId: null,
      createdAt: ago(1),
    },
  ]

  const proposals: StageProposal[] = [
    {
      id: uuid(),
      projectId: tidepool.id,
      proposedStage: "production",
      reason: "Beta users import daily without errors for two weeks.",
      authorKind: "agent",
      authorLabel: "agent:claude",
      state: "open",
      createdAt: ago(8),
      decidedAt: null,
    },
    {
      id: uuid(),
      projectId: kettle.id,
      proposedStage: "poc",
      reason: "A working prototype exists in the repository.",
      authorKind: "sync",
      authorLabel: "sync",
      state: "open",
      createdAt: ago(14),
      decidedAt: null,
    },
  ]

  const source = (
    p: Project,
    family: SecuritySource["family"],
    coverage: SecuritySource["coverage"],
    counts: [number, number, number, number],
    asOfHours: number | null,
  ): SecuritySource => ({
    id: uuid(),
    projectId: p.id,
    family,
    coverage,
    critical: counts[0],
    high: counts[1],
    medium: counts[2],
    low: counts[3],
    asOf: asOfHours === null ? null : ago(asOfHours),
    updatedAt: ago(9),
  })
  const sources = [
    source(lantern, "dependabot", "enabled", [0, 2, 5, 3], 9),
    source(lantern, "code_scanning", "enabled", [0, 0, 1, 0], 9),
    source(lantern, "secret_scanning", "enabled", [0, 0, 0, 0], 9),
    source(beacon, "dependabot", "enabled", [1, 3, 2, 0], 40),
    source(beacon, "code_scanning", "not_enabled", [0, 0, 0, 0], null),
    source(beacon, "secret_scanning", "no_access", [0, 0, 0, 0], null),
    source(tidepool, "dependabot", "enabled", [0, 1, 0, 2], 9),
  ]

  // Notes: each with its versions, the newest last.
  const notes: Note[] = []
  const noteVersions: NoteVersion[] = []
  const note = (
    p: Project | null,
    title: string,
    versions: { body: string; by: "owner" | "agent"; label: string; hoursAgo: number }[],
  ) => {
    const id = uuid()
    for (const [index, v] of versions.entries())
      noteVersions.push({
        id: uuid(),
        noteId: id,
        version: index + 1,
        title,
        body: v.body,
        projectId: p?.id ?? null,
        authorKind: v.by,
        authorLabel: v.label,
        restoredFrom: null,
        createdAt: ago(v.hoursAgo),
      })
    const first = versions[0]
    const last = versions[versions.length - 1]
    if (!first || !last) return
    notes.push({
      id,
      projectId: p?.id ?? null,
      title,
      body: last.body,
      version: versions.length,
      createdBy: first.by,
      createdByLabel: first.label,
      updatedBy: last.by,
      updatedByLabel: last.label,
      createdAt: ago(first.hoursAgo),
      updatedAt: ago(last.hoursAgo),
    })
  }
  note(lantern, "How the importer retries", [
    {
      body: "The importer retries a failed batch three times.",
      by: "agent",
      label: "agent:claude",
      hoursAgo: 30,
    },
    {
      body: [
        "## Retries",
        "",
        "A failed batch is retried **three times**, 30 seconds apart. After that it waits for the next run.",
        "",
        "- Network errors retry.",
        "- A `422` answer never retries: the data is wrong.",
        "",
        "| Attempt | Wait |",
        "| --- | --- |",
        "| 1 | 30 s |",
        "| 2 | 60 s |",
        "| 3 | 120 s |",
        "",
        "```",
        "IMPORT_RETRIES=3",
        "```",
        "",
        "See [the retry design](https://example.com/retry-design).",
      ].join("\n"),
      by: "agent",
      label: "agent:codex",
      hoursAgo: 3,
    },
  ])
  note(tidepool, "Why the beta stays invite-only", [
    {
      body: "Decided on the call: the beta stays invite-only until imports run clean for a month.\n\n> Reopen the question in December.",
      by: "owner",
      label: "owner",
      hoursAgo: 48,
    },
  ])
  note(null, "Release checklist", [
    { body: "1. Tag\n2. Push", by: "owner", label: "owner", hoursAgo: 72 },
    {
      body: "1. Tag\n2. Push\n3. Watch the CI of main until it is green",
      by: "agent",
      label: "agent:claude",
      hoursAgo: 5,
    },
  ])
  note(null, "Reading list", [
    { body: "- [The Website Specification](https://example.com/spec)", by: "owner", label: "owner", hoursAgo: 200 },
  ])

  const audit: AuditEntry[] = []
  let auditId = 1000
  const log = (entry: Omit<AuditEntry, "id">) => audit.push({ id: auditId--, ...entry })
  log({
    at: ago(1),
    actorKind: "agent",
    actorLabel: "agent:codex",
    action: "comment.create",
    entityType: "item",
    entityId: items[4]?.id ?? merge.id,
    before: null,
    after: { title: items[4]?.title },
    source: "mcp",
  })
  log({
    at: ago(2),
    actorKind: "agent",
    actorLabel: "agent:claude",
    action: "item.update",
    entityType: "item",
    entityId: merge.id,
    before: { status: "in_progress", title: merge.title },
    after: { status: "waiting_on_you", title: merge.title },
    source: "mcp",
  })
  log({
    at: ago(3),
    actorKind: "sync",
    actorLabel: "sync",
    action: "item.update",
    entityType: "item",
    entityId: items[3]?.id ?? merge.id,
    before: { status: "todo", title: items[3]?.title },
    after: { status: "in_progress", title: items[3]?.title },
    source: "sync",
  })
  log({
    at: ago(8),
    actorKind: "agent",
    actorLabel: "agent:claude",
    action: "proposal.create",
    entityType: "project",
    entityId: tidepool.id,
    before: null,
    after: { name: "Tidepool", stage: "production" },
    source: "mcp",
  })
  log({
    at: ago(26),
    actorKind: "owner",
    actorLabel: "owner",
    action: "project.update",
    entityType: "project",
    entityId: beacon.id,
    before: { name: "Beacon", stage: "development" },
    after: { name: "Beacon", stage: "redesign" },
    source: "ui",
  })
  log({
    at: ago(50),
    actorKind: "owner",
    actorLabel: "owner",
    action: "settings.update",
    entityType: "settings",
    entityId: "settings",
    before: { closedItemDays: 5 },
    after: { closedItemDays: 7 },
    source: "ui",
  })
  for (let index = 0; index < 60; index++) {
    const item = items[index % items.length]
    if (!item) continue
    log({
      at: ago(60 + index * 5),
      actorKind: index % 3 ? "agent" : "sync",
      actorLabel: index % 3 ? "agent:claude" : "sync",
      action: "item.update",
      entityType: "item",
      entityId: item.id,
      before: { status: "todo", title: item.title },
      after: { status: "in_progress", title: item.title },
      source: index % 3 ? "mcp" : "sync",
    })
  }

  const desktop =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339 Safari/537.36"
  const phone =
    "Mozilla/5.0 (Linux; Android 15; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339 Mobile Safari/537.36"
  const sessions: BrowserSession[] = [
    {
      id: uuid(),
      token: uuid(),
      createdAt: ago(24 * 3),
      updatedAt: ago(0.5),
      expiresAt: ago(-24 * 30),
      userAgent: desktop,
    },
    {
      id: uuid(),
      token: uuid(),
      createdAt: ago(24 * 9),
      updatedAt: ago(11),
      expiresAt: ago(-24 * 29),
      userAgent: phone,
    },
  ]
  const agentKeys: AgentKey[] = [
    {
      id: uuid(),
      name: "sync",
      start: "mkd_Qe",
      createdAt: ago(24 * 20),
      expiresAt: ago(-24 * 70),
      lastRequest: ago(0.2),
    },
    {
      id: uuid(),
      name: "claude",
      start: "mkd_tR",
      createdAt: ago(24 * 20),
      expiresAt: ago(-24 * 70),
      lastRequest: ago(3),
    },
  ]
  const suppressions: Suppression[] = [
    {
      id: uuid(),
      kind: "thread",
      externalId: "thr_0c9e11fa73",
      label: "Try a different chart library",
      createdAt: ago(24 * 3),
    },
    { id: uuid(), kind: "project", externalId: "t3-scratchpad", label: "Scratchpad", createdAt: ago(24 * 12) },
  ]

  return {
    projects,
    goals,
    items,
    threads,
    comments,
    proposals,
    sources,
    audit,
    notes,
    noteVersions,
    browserId: uuid(),
    sessions,
    endedOthers: false,
    agentKeys,
    suppressions,
    settings: mockSettings(),
    previousVisit: ago(14),
  }
}
