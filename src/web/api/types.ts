// Every shape the web UI reads from /api/v1, as docs/api.md defines it ("Shapes" and "Routes").
// Request bodies are the zod schemas of src/shared/api.ts. Codes are the English codes of
// src/shared/enums.ts; labels come from the locale files. Times are ISO 8601 strings in UTC. When
// the contract changes, this file and endpoints.ts are the only places to follow it.

import type { DateFormat, TimeFormat } from "../../shared/datetime-formats.ts"
import type {
  ActorKind,
  AuditSource,
  ItemStatus,
  ItemType,
  JobState,
  Language,
  ProposalState,
  SecurityCoverage,
  SecurityFamily,
  Severity,
  Stage,
  SuppressionKind,
  SyncOutcome,
} from "../../shared/enums.ts"

/** Error codes the server sends as {error: {code, message, ...details}}. */
export const API_ERROR_CODES = [
  "unauthorized",
  "forbidden",
  "totp_required",
  "not_found",
  "validation_failed",
  "version_conflict",
  "secret_suspected",
  "not_top_level",
  "suppressed",
  "conflict",
  "rate_limited",
  "setting_locked",
  "telegram_failed",
  "telegram_uncertain",
  "internal_error",
] as const
export type ApiErrorCode = (typeof API_ERROR_CODES)[number]

export type Session = {
  actor: { kind: ActorKind; label: string }
  via: "token" | "session"
  browserId: string | null
  /** When this browser's session ends unless the Better Auth client refreshes it first. */
  expiresAt: string | null
}

/** GET /api/setup/status: whether the owner exists, and what this browser's session may do. */
export type SetupStatus = { hasUser: boolean; session: "none" | "enrol" | "active" }

/** GET /api/auth/list-sessions (Better Auth): the owner's signed-in browsers. Dates arrive as Date or string. */
export type BrowserSession = {
  id: string
  /** The raw token: Better Auth's revokeSession takes it (G10). Never shown. */
  token: string
  createdAt: Date | string
  updatedAt: Date | string
  expiresAt: Date | string
  userAgent?: string | null
}

/** GET /api/auth/api-key/list (Better Auth's api-key plugin): an agent key, never the key itself. */
export type AgentKey = {
  id: string
  name: string | null
  start: string | null
  createdAt: Date | string
  expiresAt: Date | string | null
  lastRequest: Date | string | null
}

/** A setting the environment may set: then it is locked and names its variable. */
export type EnvLock = { locked: boolean; variable: string | null }

export type GoalProgress = { id: string; text: string; createdAt: string; done: number; total: number }
export type Goal = { id: string; projectId: string; text: string; createdAt: string; closedAt: string | null }

export type Project = {
  id: string
  name: string
  slug: string
  t3ProjectId: string | null
  /** GitHub repository as owner/name. */
  githubRepo: string | null
  stage: Stage | null
  whereWeAre: string | null
  openIssuesCount: number | null
  openIssuesAsOf: string | null
  createdAt: string
  updatedAt: string
}

export type ProjectListEntry = Project & { goal: GoalProgress | null; openItems: number; openProposals: number }

export type Item = {
  id: string
  projectId: string | null
  type: ItemType
  status: ItemStatus
  title: string
  body: string | null
  severity: Severity | null
  goalId: string | null
  version: number
  statusSetBy: ActorKind | null
  statusSetAt: string | null
  createdBy: ActorKind
  imported: boolean
  createdAt: string
  updatedAt: string
  closedAt: string | null
}

export type ItemSummary = {
  id: string
  projectId: string | null
  projectName: string | null
  type: ItemType
  status: ItemStatus
  title: string
  severity: Severity | null
  goalId: string | null
  version: number
  statusSetBy: ActorKind | null
  createdAt: string
  updatedAt: string
  closedAt: string | null
}

export type ThreadLink = {
  id: string
  itemId: string
  threadId: string
  t3ProjectId: string | null
  title: string | null
  /** T3's own status word: running, waiting, completed, ... */
  lastStatus: string | null
  settled: boolean
  lastActivityAt: string | null
  linkedAt: string
}

export type Comment = {
  id: string
  itemId: string
  authorKind: ActorKind
  authorLabel: string
  text: string
  threadId: string | null
  /** The note this comment points to (the Telegram bot moved the item's text into it); null once deleted. */
  noteId: string | null
  createdAt: string
}

/** A note (docs/api.md, Shapes): knowledge with a Markdown body; `projectId` null for a general note. */
export type Note = {
  id: string
  projectId: string | null
  title: string
  body: string
  version: number
  createdBy: ActorKind
  createdByLabel: string | null
  updatedBy: ActorKind
  updatedByLabel: string | null
  createdAt: string
  updatedAt: string
}

/** A note in a list: no body, the start of it on one line. */
export type NoteSummary = Omit<Note, "body"> & { excerpt: string }

export type NoteDetail = { note: Note; project: { id: string; name: string } | null }

export type NoteVersion = {
  id: string
  noteId: string
  version: number
  title: string
  body: string
  projectId: string | null
  authorKind: ActorKind
  authorLabel: string | null
  restoredFrom: number | null
  createdAt: string
}

export type NoteVersionSummary = Omit<NoteVersion, "id" | "noteId" | "body"> & { bodyLength: number }

export const NOTE_SORTS = ["updated", "title"] as const
export type NoteSort = (typeof NOTE_SORTS)[number]
export type NoteOrder = "asc" | "desc"

/** GET /notes filters, as the Notes page's address holds them. */
export type NoteFilters = {
  q?: string
  projectId?: string
  general?: boolean
  createdBy?: ActorKind
  sort?: NoteSort
  order?: NoteOrder
}

export type NotePatch = { title?: string; body?: string; projectId?: string | null }

export type StageProposal = {
  id: string
  projectId: string
  proposedStage: Stage
  reason: string | null
  authorKind: ActorKind
  authorLabel: string
  state: ProposalState
  createdAt: string
  decidedAt: string | null
}

export type SecuritySource = {
  id: string
  projectId: string
  family: SecurityFamily
  coverage: SecurityCoverage
  critical: number
  high: number
  medium: number
  low: number
  /** When the source last succeeded (not when it was synced). */
  asOf: string | null
  updatedAt: string
}

export type SecurityLine = {
  projectId: string
  projectName: string
  stage: Stage | null
  critical: number
  /** Counted only at stage production (0 elsewhere). */
  high: number
  alerts: { critical: number; high: number }
  items: { critical: number; high: number }
  asOf: string | null
  /** The as-of time is unknown or older than 26 hours. */
  stale: boolean
}

export type AuditEntry = {
  id: number
  at: string
  actorKind: ActorKind
  actorLabel: string
  action: string
  entityType: string
  entityId: string
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  source: AuditSource
}

/** The facet counts of the activity log's first page (docs/api.md, Audit filters). */
export type AuditCounts = {
  actorKind: Record<ActorKind, number>
  agents: { label: string; count: number }[]
  actions: { action: string; count: number }[]
  projects: { projectId: string; count: number }[]
}

/** A page of the activity log; the first page also carries the total and the counts. */
export type AuditPage = Page<AuditEntry> & { total: number | null; counts: AuditCounts | null }

export type ItemDetail = {
  item: Item
  project: { id: string; name: string; slug: string; stage: Stage | null } | null
  goal: Goal | null
  threads: ThreadLink[]
  /** Oldest first. */
  comments: Comment[]
  /** Newest first, up to 100. */
  audit: AuditEntry[]
}

export type ProjectDetail = {
  project: Project
  goal: GoalProgress | null
  pastGoals: Goal[]
  items: ItemSummary[]
  proposals: StageProposal[]
  securitySources: SecuritySource[]
  security: SecurityLine | null
}

export type WaitingProposal = {
  id: string
  projectId: string
  projectName: string
  currentStage: Stage | null
  proposedStage: Stage
  reason: string | null
  authorKind: ActorKind
  authorLabel: string
  createdAt: string
}

export type WaitingEntry =
  | { kind: "item"; at: string; item: ItemSummary }
  | { kind: "stage_proposal"; at: string; proposal: WaitingProposal }

export type AgentUpdate =
  | {
      kind: "comment"
      at: string
      itemId: string
      itemTitle: string
      actorKind: ActorKind
      actorLabel: string
      text: string
    }
  | {
      kind: "status"
      at: string
      itemId: string
      itemTitle: string
      actorKind: ActorKind
      actorLabel: string
      from: ItemStatus | null
      to: ItemStatus
    }
  | {
      kind: "note"
      at: string
      noteId: string
      noteTitle: string
      actorKind: ActorKind
      actorLabel: string
      change: "created" | "updated"
    }

/** `generalNotes`: the group of notes without a project (the inbox's items are `projectId: null` without it). */
export type AgentUpdateGroup = {
  projectId: string | null
  projectName: string | null
  generalNotes: boolean
  updates: AgentUpdate[]
}

export type MorningProject = {
  id: string
  name: string
  slug: string
  stage: Stage | null
  goal: GoalProgress | null
  whereWeAre: string | null
  openItems: number
  openIssues: number | null
  openIssuesAsOf: string | null
  repo: string | null
}

export type Morning = {
  now: string
  /** This device's previous visit (24 hours ago on a first visit). */
  since: string
  waiting: WaitingEntry[]
  new: { change: "created" | "updated"; item: ItemSummary }[]
  security: SecurityLine[]
  agentUpdates: AgentUpdateGroup[]
  projects: MorningProject[]
  inboxCount: number
  sync: {
    lastSuccessAt: string | null
    stale: boolean
    lastPartialAt: string | null
    securityLastSuccessAt: string | null
  }
}

export type Page<T> = { entries: T[]; nextCursor: string | null }

/** Date and time formats as the server stores them (free text up to 40; these are the ones the UI offers). */
export type { DateFormat, TimeFormat }

export type Settings = {
  id: string
  closedItemDays: number
  dateFormat: string
  timeFormat: string
  language: Language
  /** Sign out after this many days without Mikud open. */
  sessionIdleDays: number
  /** Sign-in codes to Telegram as a second factor (off by default). */
  otpViaTelegram: boolean
  updatedAt: string
  telegram: {
    /** The bot token is never returned: only whether it is set and readable. */
    botToken: { set: boolean; readable: boolean } & EnvLock
    chatId: { value: string | null } & EnvLock
    state: "off" | "incomplete" | "on"
    missing: ("botToken" | "chatId")[]
  }
  privateDomains: { value: string[] } & EnvLock
}

export type SettingsPatch = Partial<{
  closedItemDays: number
  dateFormat: DateFormat
  timeFormat: TimeFormat
  language: Language
  sessionIdleDays: number
  otpViaTelegram: boolean
  /** A new token, or null to remove the stored one. */
  telegramBotToken: string | null
  telegramChatId: string | null
  privateDomains: string[]
}>

export type SyncRun = {
  id: string
  kind: "t3" | "security"
  startedAt: string
  finishedAt: string | null
  outcome: SyncOutcome | null
  counts: Record<string, number>
  errors: { record: string; code: string }[]
}

/** GET /telegram/status (docs/api.md, Telegram). */
export type TelegramStatus = {
  configured: boolean
  /** The latest getUpdates call of the bot succeeded. */
  polling: boolean
  lastUpdateAt: string | null
  lastMorning: { localDate: string; state: JobState; at: string | null } | null
}

export type Suppression = {
  id: string
  kind: SuppressionKind
  externalId: string
  label: string | null
  createdAt: string
}

export type ItemPatch = Partial<{
  status: ItemStatus
  type: ItemType
  severity: Severity | null
  title: string
  body: string
  projectId: string | null
  goalId: string | null
}>

export type ProjectPatch = Partial<{
  stage: Stage | null
  whereWeAre: string | null
  goal: string | null
  name: string
}>
