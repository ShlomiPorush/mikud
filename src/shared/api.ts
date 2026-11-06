import { z } from "zod"
import { SESSION_IDLE_DAYS_MAX, SESSION_IDLE_DAYS_MIN } from "./auth.ts"
import {
  actorKindSchema,
  itemStatusSchema,
  itemTypeSchema,
  languageSchema,
  securityCoverageSchema,
  securityFamilySchema,
  severitySchema,
  stageSchema,
} from "./enums.ts"

// Request bodies of the HTTP API (docs/api.md) and the MCP tools. The UI, the Telegram bot and the sync
// tool import these, so a change here is a change of the contract.

const id = z.uuid()
const text = (max: number) => z.string().max(max)
const externalId = z.string().trim().min(1).max(200)
const isoDate = z.coerce.date()
const repo = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "owner/name")
  .max(200)

export const LIMITS = {
  title: 300,
  body: 20_000,
  comment: 20_000,
  whereWeAre: 500,
  goal: 300,
  reason: 2_000,
  noteTitle: 300,
  noteBody: 100_000,
} as const

export const createItemBody = z.object({
  projectId: id.nullable().optional(),
  type: itemTypeSchema,
  status: itemStatusSchema.optional(),
  title: text(LIMITS.title),
  body: text(LIMITS.body).optional(),
  severity: severitySchema.nullable().optional(),
  goalId: id.nullable().optional(),
})

export const updateItemBody = z.object({
  version: z.number().int().min(1),
  title: text(LIMITS.title).optional(),
  body: text(LIMITS.body).optional(),
  type: itemTypeSchema.optional(),
  status: itemStatusSchema.optional(),
  severity: severitySchema.nullable().optional(),
  projectId: id.nullable().optional(),
  goalId: id.nullable().optional(),
})

export const commentBody = z.object({
  text: text(LIMITS.comment),
  threadId: externalId.nullable().optional(),
})

export const captureBody = z.object({
  text: text(LIMITS.body),
  projectId: id.nullable().optional(),
})

export const linkThreadBody = z.object({
  threadId: externalId,
  parentThreadId: externalId.nullable().optional(),
  t3ProjectId: externalId.nullable().optional(),
  title: text(LIMITS.title).nullable().optional(),
})

export const startThreadBody = z.object({
  threadId: externalId,
  /** Required on purpose: the caller reads it from T3. null for a top-level thread. */
  parentThreadId: externalId.nullable(),
  projectId: id.nullable().optional(),
  t3ProjectId: externalId.nullable().optional(),
  title: text(LIMITS.title),
  itemId: id.nullable().optional(),
})

export const createProjectBody = z.object({
  name: text(200),
  slug: text(60).optional(),
  t3ProjectId: externalId.nullable().optional(),
  githubRepo: repo.nullable().optional(),
  stage: stageSchema.nullable().optional(),
})

export const updateProjectBody = z.object({
  name: text(200).optional(),
  slug: text(60).optional(),
  githubRepo: repo.nullable().optional(),
  stage: stageSchema.nullable().optional(),
  whereWeAre: text(LIMITS.whereWeAre).nullable().optional(),
  goal: text(LIMITS.goal).nullable().optional(),
})

export const proposeStageBody = z.object({
  stage: stageSchema,
  reason: text(LIMITS.reason).optional(),
})

export const decideProposalBody = z.object({ decision: z.enum(["accept", "reject"]) })

export const settingsBody = z.object({
  closedItemDays: z.number().int().min(1).max(365).optional(),
  dateFormat: text(40).optional(),
  timeFormat: text(40).optional(),
  language: languageSchema.optional(),
  sessionIdleDays: z.number().int().min(SESSION_IDLE_DAYS_MIN).max(SESSION_IDLE_DAYS_MAX).optional(),
  otpViaTelegram: z.boolean().optional(),
  /** A new bot token, or null to remove the stored one. */
  telegramBotToken: z
    .string()
    .regex(/^\d{5,}:[A-Za-z0-9_-]{30,}$/)
    .max(200)
    .nullable()
    .optional(),
  telegramChatId: z
    .string()
    .regex(/^-?\d{1,20}$/)
    .nullable()
    .optional(),
  /** Domains whose host names agents must not write; replaces the list. */
  privateDomains: z
    .array(
      z
        .string()
        .trim()
        .toLowerCase()
        .transform((d) => d.replace(/^\.+|\.+$/g, ""))
        .pipe(
          z
            .string()
            .min(1)
            .max(253)
            .regex(/^[a-z0-9-]+(\.[a-z0-9-]+)*$/),
        ),
    )
    .max(50)
    .optional(),
})

/** A page keeps the boundary of its first read: later refreshes pass it back. */
export const morningQuery = z.object({ since: isoDate.optional() })

/** The visit is recorded at the time of the read that was shown (its `now`), never later than the server's now. */
export const visitBody = z.object({ at: isoDate.optional() })

// --- Sync (pushed by the sync tool on the owner's PC) ---

export const t3SnapshotBody = z.object({
  collectedAt: isoDate,
  projects: z
    .array(
      z.object({
        t3ProjectId: externalId,
        title: text(500),
        repo: repo.nullable().optional(),
      }),
    )
    .max(2_000),
  threads: z
    .array(
      z.object({
        threadId: externalId,
        t3ProjectId: externalId.nullable(),
        title: text(2_000),
        /** T3's status as it reports it: running, starting, queued, preparing, waiting, completed, ... */
        status: text(50),
        settled: z.boolean(),
        settledAt: isoDate.nullable().optional(),
        parentThreadId: externalId.nullable().optional(),
        updatedAt: isoDate,
      }),
    )
    .max(20_000),
  /** T3 projects whose threads could not be read in this run: their items are not decided. */
  failedProjects: z.array(externalId).max(2_000).optional(),
})

const count = z.number().int().min(0)

export const securitySnapshotBody = z.object({
  collectedAt: isoDate,
  repos: z
    .array(
      z.object({
        repo,
        openIssues: count.nullable(),
        issuesAsOf: isoDate.nullable(),
        families: z.array(
          z.object({
            family: securityFamilySchema,
            coverage: securityCoverageSchema,
            counts: z.object({ critical: count, high: count, medium: count, low: count }),
            asOf: isoDate.nullable(),
          }),
        ),
      }),
    )
    .max(2_000),
})

/** The label an agent writes as (`X-Mikud-Agent`, docs/api.md): `agent`, or `agent:` and its name. */
export const AGENT_LABEL = /^agent(:[A-Za-z0-9 ._:-]{1,60})?$/

/**
 * The filters of the activity log: the query of `GET /audit` and the Activity page's address use the same names.
 * `q` is trimmed and an empty one is no filter; `lang` names the language whose labels `q` also matches.
 */
export const auditFilterSchema = z.object({
  actorKind: actorKindSchema.optional(),
  agent: z.string().regex(AGENT_LABEL, "an agent label").optional(),
  action: z
    .string()
    .regex(/^[a-z_]{1,30}\.[a-z_]{1,30}$/, "an action code")
    .optional(),
  // Lowercase, as the database writes a uuid: an address may hold one in capitals.
  projectId: id.transform((value) => value.toLowerCase()).optional(),
  itemId: id.transform((value) => value.toLowerCase()).optional(),
  q: z
    .string()
    .max(200)
    .transform((value) => value.trim() || undefined)
    .optional(),
  lang: languageSchema.optional(),
})
/** The filters the Activity page keeps in its address, in the order they are written there. */
export const AUDIT_FILTER_KEYS = ["actorKind", "agent", "action", "projectId", "itemId", "q"] as const

export type AuditFilters = z.infer<typeof auditFilterSchema>
export type CreateItemBody = z.infer<typeof createItemBody>
export type UpdateItemBody = z.infer<typeof updateItemBody>
export type StartThreadBody = z.infer<typeof startThreadBody>
export type T3Snapshot = z.infer<typeof t3SnapshotBody>
export type SecuritySnapshot = z.infer<typeof securitySnapshotBody>
