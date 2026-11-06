import { createHash } from "node:crypto"
import { and, asc, desc, eq, ilike, isNull, lt, or, type SQL, sql } from "drizzle-orm"
import { LIMITS } from "../../shared/api.ts"
import type { ActorKind } from "../../shared/enums.ts"
import { notes, noteVersions, projects } from "../db/schema.ts"
import { AppError, invalid, notFound } from "../errors.ts"
import { type By, type Ctx, checkAgentText, type DbOrTx, inTx, requireOwner, type Tx, writeAudit } from "./context.ts"
import { cleanTitle } from "./items.ts"
import { decodeCursor, encodeCursor, type Page } from "./reads.ts"

// Notes (requirements section 10): knowledge the owner and agents keep. Every change writes a row in
// note_versions and an audit row in the same transaction. Agents may create and edit any note; only the owner
// restores a version or deletes a note. Audit rows carry what changed, never the body: the body lives in the
// versions.

export type NoteRow = typeof notes.$inferSelect
export type NoteVersionRow = typeof noteVersions.$inferSelect

/** What the audit log keeps of a note. */
function auditView(note: NoteRow) {
  return {
    id: note.id,
    projectId: note.projectId,
    title: note.title,
    version: note.version,
    bodyLength: note.body.length,
  }
}

function cleanNoteTitle(title: string): string {
  return cleanTitle(title).slice(0, LIMITS.noteTitle)
}

function checkBody(body: string): void {
  if (body.length > LIMITS.noteBody)
    throw invalid(`The note is longer than ${LIMITS.noteBody} characters.`, { max: LIMITS.noteBody })
}

function versionConflict(current: number): AppError {
  return new AppError("version_conflict", "The note changed since you read it. Read it again and retry.", {
    currentVersion: current,
  })
}

/**
 * The project must exist; its row is held with a key share lock until commit, so a project delete that runs at
 * the same time either waits and then sees this note (and refuses), or deleted first and this write fails here.
 */
async function holdProject(tx: Tx, projectId: string): Promise<void> {
  const [row] = await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).for("key share")
  if (!row) throw notFound("The project")
}

async function lockNote(tx: Tx, id: string): Promise<NoteRow> {
  const [row] = await tx.select().from(notes).where(eq(notes.id, id)).for("update")
  if (!row) throw notFound("The note")
  return row
}

async function writeVersion(ctx: Ctx, tx: Tx, by: By, note: NoteRow, restoredFrom: number | null = null) {
  await tx.insert(noteVersions).values({
    noteId: note.id,
    version: note.version,
    title: note.title,
    body: note.body,
    projectId: note.projectId,
    authorKind: by.actor.kind,
    authorLabel: by.actor.label,
    restoredFrom,
    createdAt: ctx.clock(),
  })
}

export type CreateNoteInput = { projectId?: string | null; title: string; body?: string }

/** Creates a note inside a transaction the caller holds (the Telegram bot moves a capture in one). */
export async function createNoteTx(ctx: Ctx, tx: Tx, by: By, input: CreateNoteInput): Promise<NoteRow> {
  const body = input.body ?? ""
  checkAgentText(ctx, by, { title: input.title, body })
  checkBody(body)
  const title = cleanNoteTitle(input.title)
  const projectId = input.projectId ?? null
  if (projectId) await holdProject(tx, projectId)
  const now = ctx.clock()
  const [row] = await tx
    .insert(notes)
    .values({
      projectId,
      title,
      body,
      version: 1,
      createdBy: by.actor.kind,
      createdByLabel: by.actor.label,
      updatedBy: by.actor.kind,
      updatedByLabel: by.actor.label,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
  if (!row) throw new Error("insert returned no row")
  await writeVersion(ctx, tx, by, row)
  await writeAudit(ctx, tx, by, { action: "note.create", entityType: "note", entityId: row.id, after: auditView(row) })
  return row
}

export async function createNote(ctx: Ctx, by: By, input: CreateNoteInput): Promise<NoteRow> {
  return inTx(ctx, (tx) => createNoteTx(ctx, tx, by, input))
}

export type NotePatch = { title?: string; body?: string; projectId?: string | null }

/**
 * Writes the next version of a locked note. An edit that changes nothing returns the note as it is; a restore
 * always writes its version, so the owner's restore is on record even when the text is already the same.
 */
async function writeNext(
  ctx: Ctx,
  tx: Tx,
  by: By,
  before: NoteRow,
  next: { title: string; body: string; projectId: string | null },
  action: "note.update" | "note.restore",
  restoredFrom: number | null,
): Promise<NoteRow> {
  const same = next.title === before.title && next.body === before.body && next.projectId === before.projectId
  if (same && action === "note.update") return before
  if (next.projectId && next.projectId !== before.projectId) await holdProject(tx, next.projectId)
  const [row] = await tx
    .update(notes)
    .set({
      ...next,
      version: before.version + 1,
      updatedBy: by.actor.kind,
      updatedByLabel: by.actor.label,
      updatedAt: ctx.clock(),
    })
    .where(eq(notes.id, before.id))
    .returning()
  if (!row) throw new Error("update returned no row")
  await writeVersion(ctx, tx, by, row, restoredFrom)
  await writeAudit(ctx, tx, by, {
    action,
    entityType: "note",
    entityId: row.id,
    before: auditView(before),
    after: { ...auditView(row), ...(restoredFrom === null ? {} : { restoredFrom }) },
  })
  return row
}

/**
 * Applies a patch when `version` is the note's current version; otherwise `version_conflict` with the current
 * version. A patch that changes nothing writes neither a version nor an audit row.
 */
export async function updateNote(ctx: Ctx, by: By, id: string, version: number, patch: NotePatch): Promise<NoteRow> {
  checkAgentText(ctx, by, { title: patch.title, body: patch.body })
  if (patch.body !== undefined) checkBody(patch.body)
  return inTx(ctx, async (tx) => {
    const before = await lockNote(tx, id)
    if (before.version !== version) throw versionConflict(before.version)
    return writeNext(
      ctx,
      tx,
      by,
      before,
      {
        title: patch.title !== undefined ? cleanNoteTitle(patch.title) : before.title,
        body: patch.body ?? before.body,
        projectId: patch.projectId !== undefined ? patch.projectId : before.projectId,
      },
      "note.update",
      null,
    )
  })
}

/**
 * Owner only. Makes an old version the newest one, as a new version, when `expectedVersion` is still the current
 * one. A version whose project was deleted is refused with `conflict`: move the note instead.
 */
export async function restoreNote(
  ctx: Ctx,
  by: By,
  id: string,
  input: { expectedVersion: number; fromVersion: number },
): Promise<NoteRow> {
  requireOwner(by, "restore a version of a note")
  return inTx(ctx, async (tx) => {
    const before = await lockNote(tx, id)
    if (before.version !== input.expectedVersion) throw versionConflict(before.version)
    const [from] = await tx
      .select()
      .from(noteVersions)
      .where(and(eq(noteVersions.noteId, id), eq(noteVersions.version, input.fromVersion)))
    if (!from) throw notFound("The version")
    if (from.projectId && from.projectId !== before.projectId) {
      try {
        await holdProject(tx, from.projectId)
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== "not_found") throw error
        throw new AppError("conflict", "The project of that version was deleted. Move the note instead.", {
          fromVersion: input.fromVersion,
        })
      }
    }
    return writeNext(
      ctx,
      tx,
      by,
      before,
      { title: from.title, body: from.body, projectId: from.projectId },
      "note.restore",
      from.version,
    )
  })
}

/** Owner only. Deletes the note and all its versions, when `version` is still the one the owner saw. */
export async function deleteNote(ctx: Ctx, by: By, id: string, version: number): Promise<void> {
  requireOwner(by, "delete notes")
  return inTx(ctx, async (tx) => {
    const before = await lockNote(tx, id)
    if (before.version !== version) throw versionConflict(before.version)
    await tx.delete(notes).where(eq(notes.id, id))
    await writeAudit(ctx, tx, by, {
      action: "note.delete",
      entityType: "note",
      entityId: id,
      before: auditView(before),
    })
  })
}

export async function getNoteRow(db: DbOrTx, id: string): Promise<NoteRow> {
  const [row] = await db.select().from(notes).where(eq(notes.id, id))
  if (!row) throw notFound("The note")
  return row
}

// --- Reads ---

export type NoteDetail = { note: NoteRow; project: { id: string; name: string } | null }

/** One note with its body and the name of its project. */
export async function noteDetail(ctx: Ctx, id: string): Promise<NoteDetail> {
  const note = await getNoteRow(ctx.db, id)
  if (!note.projectId) return { note, project: null }
  const [project] = await ctx.db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(eq(projects.id, note.projectId))
  return { note, project: project ?? null }
}

export const NOTE_SORTS = ["updated", "title"] as const
export type NoteSort = (typeof NOTE_SORTS)[number]

export type FindNotesFilter = {
  q?: string
  projectId?: string
  /** true: only notes without a project. */
  general?: boolean
  /** Who created the note. */
  createdBy?: ActorKind
  sort?: NoteSort
  cursor?: string
  limit?: number
}

export type NoteSummary = {
  id: string
  title: string
  projectId: string | null
  version: number
  createdBy: ActorKind
  createdByLabel: string | null
  updatedBy: ActorKind
  updatedByLabel: string | null
  createdAt: Date
  updatedAt: Date
  /** The start of the body, for lists; the whole body comes with the note. */
  excerpt: string
}

const EXCERPT = 240

function noteSummary(row: NoteRow): NoteSummary {
  const { body, ...rest } = row
  const flat = body.replace(/\s+/g, " ").trim()
  return { ...rest, excerpt: flat.length > EXCERPT ? `${flat.slice(0, EXCERPT - 1)}…` : flat }
}

/** A short hash of the filters and the sort, so a cursor pages only the list it came from. */
function filterHash(filter: FindNotesFilter, sort: NoteSort): string {
  const scope = {
    q: filter.q || null,
    projectId: filter.projectId?.toLowerCase() ?? null,
    general: filter.general ?? false,
    createdBy: filter.createdBy ?? null,
    sort,
  }
  return createHash("sha256").update(JSON.stringify(scope)).digest("base64url").slice(0, 16)
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Notes, newest change first or by title, paged by a cursor that is bound to the filters. */
export async function findNotes(ctx: Ctx, filter: FindNotesFilter = {}): Promise<Page<NoteSummary>> {
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200)
  const sort = filter.sort ?? "updated"
  const hash = filterHash(filter, sort)
  const where: SQL[] = []
  if (filter.q) {
    const pattern = `%${filter.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    const match = or(ilike(notes.title, pattern), ilike(notes.body, pattern))
    if (match) where.push(match)
  }
  if (filter.projectId) where.push(eq(notes.projectId, filter.projectId))
  if (filter.general) where.push(isNull(notes.projectId))
  if (filter.createdBy) where.push(eq(notes.createdBy, filter.createdBy))
  if (filter.cursor) {
    const [key, id, cursorHash, ...rest] = decodeCursor(filter.cursor)
    if (typeof key !== "string" || typeof id !== "string" || !UUID.test(id) || rest.length > 0)
      throw invalid("The cursor is not valid.")
    if (cursorHash !== hash) throw invalid("The cursor does not match the filters.")
    if (sort === "updated") {
      if (Number.isNaN(Date.parse(key))) throw invalid("The cursor is not valid.")
      where.push(sql`(${notes.updatedAt}, ${notes.id}) < (${new Date(key).toISOString()}::timestamptz, ${id}::uuid)`)
    } else {
      where.push(sql`(${notes.title}, ${notes.id}) > (${key}, ${id}::uuid)`)
    }
  }
  const order = sort === "updated" ? [desc(notes.updatedAt), desc(notes.id)] : [asc(notes.title), asc(notes.id)]
  const rows = await ctx.db
    .select()
    .from(notes)
    .where(and(...where))
    .orderBy(...order)
    .limit(limit + 1)
  const page = rows.slice(0, limit)
  const last = page[page.length - 1]
  const nextKey = last ? (sort === "updated" ? last.updatedAt.toISOString() : last.title) : null
  return {
    data: page.map(noteSummary),
    nextCursor: rows.length > limit && last && nextKey !== null ? encodeCursor([nextKey, last.id, hash]) : null,
  }
}

export type NoteVersionSummary = {
  version: number
  title: string
  projectId: string | null
  authorKind: ActorKind
  authorLabel: string | null
  restoredFrom: number | null
  createdAt: Date
  bodyLength: number
}

/** A note's versions, newest first, without their bodies. */
export async function listNoteVersions(
  ctx: Ctx,
  noteId: string,
  options: { cursor?: string; limit?: number } = {},
): Promise<Page<NoteVersionSummary>> {
  await getNoteRow(ctx.db, noteId)
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  const where: SQL[] = [eq(noteVersions.noteId, noteId)]
  if (options.cursor) {
    const [version, ...rest] = decodeCursor(options.cursor)
    if (typeof version !== "number" || !Number.isInteger(version) || version < 1 || rest.length > 0)
      throw invalid("The cursor is not valid.")
    where.push(lt(noteVersions.version, version))
  }
  const rows = await ctx.db
    .select({
      version: noteVersions.version,
      title: noteVersions.title,
      projectId: noteVersions.projectId,
      authorKind: noteVersions.authorKind,
      authorLabel: noteVersions.authorLabel,
      restoredFrom: noteVersions.restoredFrom,
      createdAt: noteVersions.createdAt,
      bodyLength: sql<number>`char_length(${noteVersions.body})`.mapWith(Number),
    })
    .from(noteVersions)
    .where(and(...where))
    .orderBy(desc(noteVersions.version))
    .limit(limit + 1)
  const page = rows.slice(0, limit)
  const last = page[page.length - 1]
  return { data: page, nextCursor: rows.length > limit && last ? encodeCursor([last.version]) : null }
}

/** One version with its body. */
export async function getNoteVersion(ctx: Ctx, noteId: string, version: number): Promise<NoteVersionRow> {
  const [row] = await ctx.db
    .select()
    .from(noteVersions)
    .where(and(eq(noteVersions.noteId, noteId), eq(noteVersions.version, version)))
  if (!row) throw notFound("The version")
  return row
}
