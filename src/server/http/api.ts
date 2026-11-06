import { type Context, Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { z } from "zod"
import {
  auditFilterSchema,
  captureBody,
  commentBody,
  createItemBody,
  createNoteBody,
  createProjectBody,
  decideProposalBody,
  LIMITS,
  linkThreadBody,
  morningQuery,
  proposeStageBody,
  restoreNoteBody,
  securitySnapshotBody,
  settingsBody,
  startThreadBody,
  t3SnapshotBody,
  updateItemBody,
  updateNoteBody,
  updateProjectBody,
  visitBody,
} from "../../shared/api.ts"
import { actorKindSchema, itemStatusSchema, itemTypeSchema } from "../../shared/enums.ts"
import { forbidden, invalid, notFound } from "../errors.ts"
import { sendTestMorningMessage } from "../jobs/morning.ts"
import {
  getSettings,
  listSuppressions,
  previousVisit,
  recordVisit,
  removeSuppression,
  type SettingsEnv,
  type SettingsRow,
  settingsView,
  updateSettings,
} from "../services/admin.ts"
import { addComment, captureItem, createItem, deleteItem, linkThread, updateItem } from "../services/items.ts"
import {
  createNote,
  deleteNote,
  findNotes,
  getNoteVersion,
  listNoteVersions,
  NOTE_SORTS,
  noteDetail,
  restoreNote,
  updateNote,
} from "../services/notes.ts"
import { createProject, decideProposal, deleteProject, proposeStage, updateProject } from "../services/projects.ts"
import {
  archive,
  auditLog,
  findItems,
  inbox,
  itemDetail,
  listProjects,
  morning,
  projectDetail,
} from "../services/reads.ts"
import { applySecuritySnapshot, applyT3Snapshot, recentSyncRuns } from "../services/sync.ts"
import { startThread } from "../services/threads.ts"
import { TELEGRAM_OFF, type TelegramRuntime, telegramStatus } from "../telegram/status.ts"
import { type AuthDeps, authenticate, byOf, type Env, requireOwnerAuth } from "./auth.ts"

/** The settings that hold secrets or may be set by the environment, and how a save takes effect without a restart. */
export type SettingsHandle = { env: SettingsEnv; apply(row: SettingsRow): Promise<void> }

/** Parses and validates a JSON body; anything else is `validation_failed` with the issues. */
async function body<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    throw invalid("The request body must be JSON.")
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success)
    throw invalid("The request body is not valid.", {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    })
  return parsed.data
}

function query<T>(c: Context, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(flatQuery(c))
  if (!parsed.success)
    throw invalid("The query is not valid.", {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    })
  return parsed.data
}

/** Single query values as strings; `status` may repeat or be comma-separated. */
function flatQuery(c: Context): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const [key, values] of Object.entries(c.req.queries())) {
    out[key] = key === "status" ? values.flatMap((v) => v.split(",")).filter(Boolean) : (values[0] ?? "")
  }
  return out
}

const uuid = z.uuid()
/** A path id that is not a UUID cannot name anything: `not_found`. */
function idParam(c: Context, name = "id"): string {
  const value = c.req.param(name) ?? ""
  if (!uuid.safeParse(value).success) throw notFound("The resource")
  return value
}

const bool = z.enum(["true", "false"]).transform((v) => v === "true")
const limit = z.coerce.number().int().min(1).max(200).optional()

const findItemsQuery = z.object({
  q: z.string().max(200).optional(),
  projectId: z.uuid().optional(),
  inbox: bool.optional(),
  status: z.array(itemStatusSchema).optional(),
  type: itemTypeSchema.optional(),
  threadId: z.string().max(200).optional(),
  includeClosed: bool.optional(),
  limit,
})
const archiveQuery = z.object({ projectId: z.uuid().optional(), cursor: z.string().max(500).optional(), limit })
/** The activity filters (shared with the page's address) and the entity filters that came before them. */
const auditQuery = auditFilterSchema.extend({
  cursor: z.string().max(500).optional(),
  limit,
  entityType: z.string().max(50).optional(),
  entityId: z.string().max(200).optional(),
})
const versionQuery = z.object({ version: z.coerce.number().int().min(1).optional() })
const findNotesQuery = z.object({
  q: z.string().max(200).optional(),
  projectId: z.uuid().optional(),
  general: bool.optional(),
  createdBy: actorKindSchema.optional(),
  sort: z.enum(NOTE_SORTS).optional(),
  cursor: z.string().max(LIMITS.noteCursor).optional(),
  limit,
})
const pageQuery = z.object({ cursor: z.string().max(500).optional(), limit })
/** Deleting a note needs the version the owner saw: an edit he did not see is never deleted with it. */
const requiredVersionQuery = z.object({ version: z.coerce.number().int().min(1) })

/** A version number in the path; anything else cannot name a version: `not_found`. */
function versionParam(c: Context): number {
  const value = Number(c.req.param("version"))
  if (!Number.isInteger(value) || value < 1) throw notFound("The version")
  return value
}

/** Sync pushes come from the sync tool with a token, never from a browser. */
function requireToken(c: Context<Env>) {
  if (c.get("auth").via !== "token") throw forbidden("Sync data is pushed with an agent key.")
}

export function apiRoutes(deps: AuthDeps & { version: string; telegram?: TelegramRuntime; settings: SettingsHandle }) {
  const { ctx } = deps
  const api = new Hono<Env>()

  // Snapshots from the sync tool are large; everything else is small.
  const syncLimit = bodyLimit({ maxSize: 16 * 1024 * 1024, onError: tooLarge })
  const defaultLimit = bodyLimit({ maxSize: 512 * 1024, onError: tooLarge })
  api.use("*", (c, next) => (c.req.path.includes("/sync/") ? syncLimit : defaultLimit)(c, next))

  api.use("*", authenticate(deps, { allowSession: true }))

  // --- Session and visits ---
  api.use("/session", noStore)
  api.get("/session", (c) => {
    const auth = c.get("auth")
    return c.json({
      data: {
        actor: auth.actor,
        via: auth.via,
        browserId: auth.via === "session" ? auth.browserId : null,
        expiresAt: auth.via === "session" ? auth.expiresAt : null,
      },
    })
  })
  api.get("/morning", async (c) => {
    const { since } = query(c, morningQuery)
    const auth = c.get("auth")
    return c.json({ data: await morning(ctx, { deviceId: auth.via === "session" ? auth.browserId : null, since }) })
  })
  api.post("/visits", async (c) => {
    const auth = c.get("auth")
    if (auth.via !== "session") throw forbidden("Visits are recorded for signed-in browsers only.")
    // An empty body records the visit now; the UI sends the time of the read it showed.
    const { at } = (await c.req.text()).trim() ? await body(c, visitBody) : {}
    const previous = await previousVisit(ctx, auth.browserId)
    return c.json({ data: { at: await recordVisit(ctx, auth.browserId, at), previous } }, 201)
  })

  // --- Projects ---
  api.get("/projects", async (c) => c.json({ data: await listProjects(ctx) }))
  api.post("/projects", async (c) =>
    c.json({ data: await createProject(ctx, byOf(c), await body(c, createProjectBody)) }, 201),
  )
  api.get("/projects/:id", async (c) => c.json({ data: await projectDetail(ctx, idParam(c)) }))
  api.patch("/projects/:id", async (c) =>
    c.json({ data: await updateProject(ctx, byOf(c), idParam(c), await body(c, updateProjectBody)) }),
  )
  api.delete("/projects/:id", async (c) => {
    await deleteProject(ctx, byOf(c), idParam(c))
    return c.body(null, 204)
  })
  api.post("/projects/:id/stage-proposals", async (c) =>
    c.json({ data: await proposeStage(ctx, byOf(c), idParam(c), await body(c, proposeStageBody)) }, 201),
  )
  api.post("/stage-proposals/:id/decision", async (c) => {
    const { decision } = await body(c, decideProposalBody)
    return c.json({ data: await decideProposal(ctx, byOf(c), idParam(c), decision) })
  })

  // --- Items ---
  api.get("/items", async (c) => c.json({ data: await findItems(ctx, query(c, findItemsQuery)) }))
  api.post("/items", async (c) => c.json({ data: await createItem(ctx, byOf(c), await body(c, createItemBody)) }, 201))
  api.get("/items/:id", async (c) => c.json({ data: await itemDetail(ctx, idParam(c)) }))
  api.patch("/items/:id", async (c) => {
    const { version, ...patch } = await body(c, updateItemBody)
    return c.json({ data: await updateItem(ctx, byOf(c), idParam(c), version, patch) })
  })
  api.delete("/items/:id", async (c) => {
    await deleteItem(ctx, byOf(c), idParam(c), query(c, versionQuery).version)
    return c.body(null, 204)
  })
  api.post("/items/:id/comments", async (c) =>
    c.json({ data: await addComment(ctx, byOf(c), idParam(c), await body(c, commentBody)) }, 201),
  )
  api.post("/items/:id/threads", async (c) => {
    const { link, created } = await linkThread(ctx, byOf(c), idParam(c), await body(c, linkThreadBody))
    return c.json({ data: { link, created } }, created ? 201 : 200)
  })
  api.post("/capture", async (c) => c.json({ data: await captureItem(ctx, byOf(c), await body(c, captureBody)) }, 201))
  api.get("/inbox", async (c) => c.json({ data: await inbox(ctx) }))
  api.get("/archive", async (c) => c.json(await archive(ctx, query(c, archiveQuery))))
  api.get("/audit", async (c) => c.json(await auditLog(ctx, query(c, auditQuery))))

  // --- Notes ---
  api.get("/notes", async (c) => c.json(await findNotes(ctx, query(c, findNotesQuery))))
  api.post("/notes", async (c) => c.json({ data: await createNote(ctx, byOf(c), await body(c, createNoteBody)) }, 201))
  api.get("/notes/:id", async (c) => c.json({ data: await noteDetail(ctx, idParam(c)) }))
  api.patch("/notes/:id", async (c) => {
    const { version, ...patch } = await body(c, updateNoteBody)
    return c.json({ data: await updateNote(ctx, byOf(c), idParam(c), version, patch) })
  })
  api.delete("/notes/:id", async (c) => {
    await deleteNote(ctx, byOf(c), idParam(c), query(c, requiredVersionQuery).version)
    return c.body(null, 204)
  })
  api.get("/notes/:id/versions", async (c) => c.json(await listNoteVersions(ctx, idParam(c), query(c, pageQuery))))
  api.get("/notes/:id/versions/:version", async (c) =>
    c.json({ data: await getNoteVersion(ctx, idParam(c), versionParam(c)) }),
  )
  api.post("/notes/:id/restore", async (c) =>
    c.json({ data: await restoreNote(ctx, byOf(c), idParam(c), await body(c, restoreNoteBody)) }),
  )

  // --- T3 ---
  api.post("/threads/start", async (c) => {
    const result = await startThread(ctx, byOf(c), await body(c, startThreadBody))
    return c.json({ data: result }, result.created ? 201 : 200)
  })
  api.post("/sync/t3", async (c) => {
    requireToken(c)
    return c.json({ data: await applyT3Snapshot(ctx, await body(c, t3SnapshotBody)) })
  })
  api.post("/sync/security", async (c) => {
    requireToken(c)
    return c.json({ data: await applySecuritySnapshot(ctx, await body(c, securitySnapshotBody)) })
  })
  api.get("/sync/runs", async (c) =>
    c.json({ data: await recentSyncRuns(ctx, query(c, z.object({ limit })).limit ?? 20) }),
  )

  // --- Owner only: settings, suppressions ---
  api.use("/settings", noStore)
  api.get("/settings", requireOwnerAuth, async (c) =>
    c.json({ data: settingsView(await getSettings(ctx.db), deps.settings.env) }),
  )
  api.patch("/settings", async (c) => {
    const row = await updateSettings(ctx, byOf(c), await body(c, settingsBody), deps.settings.env)
    // After the commit: the Better Auth instance, the bot and the secret check pick up what changed.
    await deps.settings.apply(row)
    return c.json({ data: settingsView(row, deps.settings.env) })
  })
  api.get("/suppressions", async (c) => c.json({ data: await listSuppressions(ctx, byOf(c)) }))
  api.delete("/suppressions/:id", async (c) => {
    await removeSuppression(ctx, byOf(c), idParam(c))
    return c.body(null, 204)
  })
  api.get("/telegram/status", requireOwnerAuth, async (c) =>
    c.json({ data: await telegramStatus(ctx, deps.telegram ?? TELEGRAM_OFF) }),
  )
  api.post("/telegram/test-message", requireOwnerAuth, async (c) => {
    const send = deps.telegram?.configured ? deps.telegram.send?.bind(deps.telegram) : undefined
    return c.json({ data: await sendTestMorningMessage(ctx, byOf(c), deps.config.publicUrl, send) })
  })
  return api
}

function tooLarge(c: Context) {
  return c.json({ error: { code: "validation_failed", message: "The request body is too large." } }, 413)
}

async function noStore(c: Context, next: () => Promise<void>) {
  await next()
  c.header("Cache-Control", "no-store")
}
