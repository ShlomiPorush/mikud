import { and, eq } from "drizzle-orm"
import {
  CLOSED_STATUSES,
  type ItemStatus,
  type ItemType,
  type Severity,
  type SuppressionKind,
} from "../../shared/enums.ts"
import { comments, goals, items, itemThreads, projects, suppressions } from "../db/schema.ts"
import { AppError, invalid, notFound } from "../errors.ts"
import {
  type By,
  type Ctx,
  checkAgentText,
  type DbOrTx,
  inLinkTx,
  inTx,
  requireOwner,
  type Tx,
  writeAudit,
} from "./context.ts"

export type ItemRow = typeof items.$inferSelect
export type ThreadLinkRow = typeof itemThreads.$inferSelect
export type CommentRow = typeof comments.$inferSelect

const closed = (status: ItemStatus) => (CLOSED_STATUSES as readonly ItemStatus[]).includes(status)

export const TITLE_MAX = 300

/** Trims a title and refuses an empty one. */
export function cleanTitle(title: string): string {
  const t = title.replace(/\s+/g, " ").trim()
  if (!t) throw invalid("The title is empty.")
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t
}

export async function getItemRow(tx: DbOrTx, id: string): Promise<ItemRow> {
  const [row] = await tx.select().from(items).where(eq(items.id, id))
  if (!row) throw notFound("The item")
  return row
}

async function lockItem(tx: Tx, id: string): Promise<ItemRow> {
  const [row] = await tx.select().from(items).where(eq(items.id, id)).for("update")
  if (!row) throw notFound("The item")
  return row
}

async function requireProject(tx: DbOrTx, projectId: string) {
  const [row] = await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId))
  if (!row) throw notFound("The project")
}

/** A goal must belong to the item's project. */
async function requireGoal(tx: DbOrTx, goalId: string, projectId: string | null) {
  const [row] = await tx.select({ projectId: goals.projectId }).from(goals).where(eq(goals.id, goalId))
  if (!row) throw notFound("The goal")
  if (row.projectId !== projectId) throw invalid("The goal belongs to another project.")
}

export async function isSuppressed(tx: DbOrTx, kind: SuppressionKind, externalId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: suppressions.id })
    .from(suppressions)
    .where(and(eq(suppressions.kind, kind), eq(suppressions.externalId, externalId)))
  return Boolean(row)
}

export type CreateItemInput = {
  projectId?: string | null
  type: ItemType
  status?: ItemStatus
  title: string
  body?: string
  severity?: Severity | null
  goalId?: string | null
}

/** Creates an item inside a transaction the caller holds. `imported` is for the first sync run only. */
export async function createItemTx(
  ctx: Ctx,
  tx: Tx,
  by: By,
  input: CreateItemInput,
  extra: { imported?: boolean } = {},
): Promise<ItemRow> {
  checkAgentText(ctx, by, { title: input.title, body: input.body })
  const projectId = input.projectId ?? null
  if (projectId) await requireProject(tx, projectId)
  if (input.goalId) await requireGoal(tx, input.goalId, projectId)
  if (input.severity && input.type !== "security") throw invalid("Only security items have a severity.")
  const status = input.status ?? "todo"
  const now = ctx.clock()
  const [row] = await tx
    .insert(items)
    .values({
      projectId,
      type: input.type,
      status,
      title: cleanTitle(input.title),
      body: input.body ?? "",
      severity: input.type === "security" ? (input.severity ?? null) : null,
      goalId: input.goalId ?? null,
      statusSetBy: by.actor.kind,
      statusSetAt: now,
      createdBy: by.actor.kind,
      imported: extra.imported ?? false,
      createdAt: now,
      updatedAt: now,
      closedAt: closed(status) ? now : null,
    })
    .returning()
  if (!row) throw new Error("insert returned no row")
  await writeAudit(ctx, tx, by, { action: "item.create", entityType: "item", entityId: row.id, after: row })
  return row
}

export async function createItem(ctx: Ctx, by: By, input: CreateItemInput): Promise<ItemRow> {
  return inTx(ctx, (tx) => createItemTx(ctx, tx, by, input))
}

export type CaptureInput = { text: string; projectId?: string | null }

/** Quick capture: an idea in the inbox (or in the given project), status future. */
export async function captureItem(ctx: Ctx, by: By, input: CaptureInput): Promise<ItemRow> {
  return inTx(ctx, (tx) => captureItemTx(ctx, tx, by, input))
}

/** Quick capture inside a transaction the caller holds (the Telegram bot records its update in it). */
export async function captureItemTx(ctx: Ctx, tx: Tx, by: By, input: CaptureInput): Promise<ItemRow> {
  const text = input.text.trim()
  if (!text) throw invalid("The text is empty.")
  const firstLine = text.split(/\r?\n/, 1)[0] ?? text
  const title = cleanTitle(firstLine)
  const body = text === title ? "" : text
  return createItemTx(ctx, tx, by, {
    projectId: input.projectId ?? null,
    type: "idea",
    status: "future",
    title,
    body,
  })
}

export type ItemPatch = {
  title?: string
  body?: string
  type?: ItemType
  status?: ItemStatus
  severity?: Severity | null
  projectId?: string | null
  goalId?: string | null
}

/**
 * Applies a patch when `version` is the item's current version (optimistic concurrency); otherwise
 * `version_conflict` with the current version. Entering done or not_relevant sets closed_at; leaving
 * them clears it.
 */
export async function updateItemTx(ctx: Ctx, tx: Tx, by: By, id: string, version: number, patch: ItemPatch) {
  checkAgentText(ctx, by, { title: patch.title, body: patch.body })
  const before = await lockItem(tx, id)
  if (before.version !== version)
    throw new AppError("version_conflict", "The item changed since you read it. Read it again and retry.", {
      currentVersion: before.version,
    })

  const next: Partial<ItemRow> = {}
  if (patch.title !== undefined) next.title = cleanTitle(patch.title)
  if (patch.body !== undefined) next.body = patch.body
  if (patch.type !== undefined) next.type = patch.type

  const projectId = patch.projectId !== undefined ? patch.projectId : before.projectId
  if (patch.projectId !== undefined && patch.projectId !== before.projectId) {
    if (projectId) await requireProject(tx, projectId)
    next.projectId = projectId
    // A goal belongs to one project: moving the item drops it unless a new one is given.
    if (patch.goalId === undefined) next.goalId = null
  }
  if (patch.goalId !== undefined) {
    if (patch.goalId) await requireGoal(tx, patch.goalId, projectId)
    next.goalId = patch.goalId
  }

  const type = next.type ?? before.type
  if (patch.severity !== undefined) {
    if (patch.severity && type !== "security") throw invalid("Only security items have a severity.")
    next.severity = patch.severity
  }
  if (type !== "security" && (next.severity ?? before.severity)) next.severity = null

  const now = ctx.clock()
  if (patch.status !== undefined && patch.status !== before.status) {
    next.status = patch.status
    next.statusSetBy = by.actor.kind
    next.statusSetAt = now
    if (closed(patch.status) && !closed(before.status)) next.closedAt = now
    if (!closed(patch.status)) next.closedAt = null
  }

  const changed = Object.entries(next).filter(([k, v]) => !same(before[k as keyof ItemRow], v))
  if (changed.length === 0) return before

  const [after] = await tx
    .update(items)
    .set({ ...Object.fromEntries(changed), version: before.version + 1, updatedAt: now })
    .where(and(eq(items.id, id), eq(items.version, version)))
    .returning()
  if (!after) throw new AppError("version_conflict", "The item changed since you read it. Read it again and retry.")
  await writeAudit(ctx, tx, by, { action: "item.update", entityType: "item", entityId: id, before, after })
  return after
}

function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime()
  return a === b
}

export async function updateItem(ctx: Ctx, by: By, id: string, version: number, patch: ItemPatch): Promise<ItemRow> {
  return inTx(ctx, (tx) => updateItemTx(ctx, tx, by, id, version, patch))
}

/**
 * Owner only. Deletes an item with its links and comments, and suppresses its T3 threads so the sync never
 * recreates the item. `version`, when given, must be current.
 */
export async function deleteItem(ctx: Ctx, by: By, id: string, version?: number): Promise<void> {
  requireOwner(by, "delete items")
  // Under the link structure lock no link is added, moved or removed until commit, so the suppressions
  // cover exactly the thread ids this delete removes.
  return inLinkTx(ctx, async (tx) => {
    const before = await lockItem(tx, id)
    if (version !== undefined && before.version !== version)
      throw new AppError("version_conflict", "The item changed since you read it. Read it again and retry.", {
        currentVersion: before.version,
      })
    const links = await tx.select().from(itemThreads).where(eq(itemThreads.itemId, id))
    for (const link of links) {
      const [s] = await tx
        .insert(suppressions)
        .values({ kind: "thread", externalId: link.threadId, label: before.title, createdAt: ctx.clock() })
        .onConflictDoNothing()
        .returning()
      if (s)
        await writeAudit(ctx, tx, by, {
          action: "suppression.create",
          entityType: "suppression",
          entityId: s.id,
          after: s,
        })
    }
    await tx.delete(items).where(eq(items.id, id))
    await writeAudit(ctx, tx, by, {
      action: "item.delete",
      entityType: "item",
      entityId: id,
      before: { ...before, threads: links.map((l) => l.threadId) },
    })
  })
}

export type CommentInput = {
  text: string
  threadId?: string | null
  /** The note the comment points to (the Telegram bot moved the item's text into it). */
  noteId?: string | null
}

export async function addComment(ctx: Ctx, by: By, itemId: string, input: CommentInput): Promise<CommentRow> {
  return inTx(ctx, (tx) => addCommentTx(ctx, tx, by, itemId, input))
}

/** Adds a comment inside a transaction the caller holds, so it commits or rolls back with the caller's change. */
export async function addCommentTx(ctx: Ctx, tx: Tx, by: By, itemId: string, input: CommentInput): Promise<CommentRow> {
  const text = input.text.trim()
  if (!text) throw invalid("The comment is empty.")
  checkAgentText(ctx, by, { comment: text })
  await getItemRow(tx, itemId)
  const [row] = await tx
    .insert(comments)
    .values({
      itemId,
      authorKind: by.actor.kind,
      authorLabel: by.actor.label,
      text,
      threadId: input.threadId ?? null,
      noteId: input.noteId ?? null,
      createdAt: ctx.clock(),
    })
    .returning()
  if (!row) throw new Error("insert returned no row")
  await writeAudit(ctx, tx, by, { action: "comment.create", entityType: "item", entityId: itemId, after: row })
  return row
}

export type LinkThreadInput = {
  threadId: string
  parentThreadId?: string | null
  t3ProjectId?: string | null
  title?: string | null
}

export function refuseChildThread(parentThreadId: string | null | undefined): void {
  if (parentThreadId)
    throw new AppError(
      "not_top_level",
      "This is a subagent or review thread. Only top-level T3 threads are tracked; do not call Mikud from it.",
    )
}

/**
 * Links a T3 thread to an item inside the caller's transaction, which holds the link structure lock
 * (`inLinkTx`). Returns the link, or the existing link when the thread is linked to this item already. A
 * thread linked to another item is a `conflict`.
 */
export async function linkThreadTx(
  ctx: Ctx,
  tx: Tx,
  by: By,
  itemId: string,
  input: LinkThreadInput,
): Promise<{ link: ThreadLinkRow; created: boolean }> {
  refuseChildThread(input.parentThreadId)
  checkAgentText(ctx, by, { title: input.title })
  if (await isSuppressed(tx, "thread", input.threadId)) {
    if (by.actor.kind !== "owner")
      throw new AppError("suppressed", "The owner deleted the item of this thread; it is not tracked again.")
    // The owner links it on purpose: the suppression goes.
    const removed = await tx
      .delete(suppressions)
      .where(and(eq(suppressions.kind, "thread"), eq(suppressions.externalId, input.threadId)))
      .returning()
    for (const s of removed)
      await writeAudit(ctx, tx, by, {
        action: "suppression.delete",
        entityType: "suppression",
        entityId: s.id,
        before: s,
      })
  }
  const inserted = await insertLinkTx(ctx, tx, by, itemId, input)
  if (inserted) return { link: inserted, created: true }
  const [existing] = await tx.select().from(itemThreads).where(eq(itemThreads.threadId, input.threadId))
  if (!existing) throw new AppError("conflict", "The thread link changed at the same time. Retry.")
  if (existing.itemId !== itemId)
    throw new AppError("conflict", "This thread is linked to another item.", { itemId: existing.itemId })
  return { link: existing, created: false }
}

/** Inserts a link unless the thread is linked already (then null). Audited. Under the link structure lock. */
export async function insertLinkTx(
  ctx: Ctx,
  tx: Tx,
  by: By,
  itemId: string,
  input: LinkThreadInput,
): Promise<ThreadLinkRow | null> {
  const [inserted] = await tx
    .insert(itemThreads)
    .values({
      itemId,
      threadId: input.threadId,
      t3ProjectId: input.t3ProjectId ?? null,
      title: input.title ?? null,
      linkedAt: ctx.clock(),
    })
    .onConflictDoNothing({ target: itemThreads.threadId })
    .returning()
  if (inserted)
    await writeAudit(ctx, tx, by, { action: "thread.link", entityType: "item", entityId: itemId, after: inserted })
  return inserted ?? null
}

export async function linkThread(ctx: Ctx, by: By, itemId: string, input: LinkThreadInput) {
  return inLinkTx(ctx, async (tx) => {
    await getItemRow(tx, itemId)
    return linkThreadTx(ctx, tx, by, itemId, input)
  })
}
