import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm"
import type { SecuritySnapshot, T3Snapshot } from "../../shared/api.ts"
import { items, itemThreads, projects, securitySources, syncRuns } from "../db/schema.ts"
import { AppError, invalid } from "../errors.ts"
import { errorFacts, log } from "../log.ts"
import { type By, type Ctx, inLinkTx, inTx, writeAudit } from "./context.ts"
import { createItemTx, type ItemRow, isSuppressed, type ThreadLinkRow, updateItemTx } from "./items.ts"
import { createProjectTx } from "./projects.ts"
import { newItemStatus, rootThreadId, syncDecision, wantsItem } from "./sync-rules.ts"

export type SyncRunRow = typeof syncRuns.$inferSelect

export type SyncResult = {
  runId: string
  outcome: "succeeded" | "partial" | "failed"
  counts: Record<string, number>
  errors: { record: string; code: string }[]
}

const SYNC: By = { actor: { kind: "sync", label: "sync" }, source: "sync" }
const SUCCESSFUL = ["succeeded", "partial"] as const

/**
 * How far ahead of the server's clock a pushed time may be. A later time is refused: the newer record always
 * wins, so one far in the future would stand against every honest snapshot after it.
 */
export const SYNC_CLOCK_SKEW_MS = 5 * 60_000
const TIME_IN_FUTURE = "time_in_future"

const latestAllowed = (ctx: Ctx) => ctx.clock().getTime() + SYNC_CLOCK_SKEW_MS
const later = (time: Date | null | undefined, limit: number) => time != null && time.getTime() > limit

/** Collects per-record results: a failing record is recorded and never stops the run. */
class Run {
  readonly counts: Record<string, number> = {}
  readonly errors: { record: string; code: string }[] = []
  private attempted = 0
  private failed = 0
  private incomplete = false

  constructor(readonly kind: string) {}

  add(name: string, by = 1) {
    this.counts[name] = (this.counts[name] ?? 0) + by
  }

  async record(name: string, work: () => Promise<void>) {
    this.attempted++
    try {
      await work()
    } catch (error) {
      this.failed++
      const code = error instanceof AppError ? error.code : "internal_error"
      this.errors.push({ record: name, code })
      // The record's name is an id; its text (titles) and a failed query's parameters are never logged.
      log.warn("sync record failed", { kind: this.kind, record: name, ...errorFacts(error), code })
    }
  }

  /** A record refused before any of it was applied: it counts as a failed record. */
  refuse(name: string, code: string) {
    this.attempted++
    this.failed++
    this.errors.push({ record: name, code })
    log.warn("sync record refused", { kind: this.kind, record: name, code })
  }

  /** The input itself was incomplete (projects the sync tool could not read): at best partial. */
  missing(name: string, code: string) {
    this.incomplete = true
    this.errors.push({ record: name, code })
  }

  get outcome(): SyncResult["outcome"] {
    if (this.failed === 0) return this.incomplete ? "partial" : "succeeded"
    return this.failed === this.attempted ? "failed" : "partial"
  }
}

async function startRun(ctx: Ctx, kind: string): Promise<string> {
  const [row] = await ctx.db.insert(syncRuns).values({ kind, startedAt: ctx.clock() }).returning({ id: syncRuns.id })
  if (!row) throw new Error("insert returned no row")
  return row.id
}

async function finishRun(ctx: Ctx, id: string, run: Run): Promise<SyncResult> {
  const outcome = run.outcome
  await ctx.db
    .update(syncRuns)
    .set({ finishedAt: ctx.clock(), outcome, counts: run.counts, errors: run.errors })
    .where(eq(syncRuns.id, id))
  return { runId: id, outcome, counts: run.counts, errors: run.errors }
}

/** Marks a run that stopped on an unexpected error as failed, then rethrows. */
async function guarded(ctx: Ctx, id: string, run: Run, work: () => Promise<void>): Promise<SyncResult> {
  try {
    await work()
  } catch (error) {
    await ctx.db
      .update(syncRuns)
      .set({
        finishedAt: ctx.clock(),
        outcome: "failed",
        counts: run.counts,
        errors: [...run.errors, { record: "run", code: "internal_error" }],
      })
      .where(eq(syncRuns.id, id))
      .catch(() => {})
    throw error
  }
  return finishRun(ctx, id, run)
}

/**
 * A snapshot collected later than the server's clock allows is refused whole, and nothing of it is applied. The
 * run is recorded as failed, in one insert, so the sync status shows the refusal and no run is left open.
 */
async function refuseFutureSnapshot(ctx: Ctx, kind: string, collectedAt: Date, limit: number) {
  if (!later(collectedAt, limit)) return
  const now = ctx.clock()
  const errors = [{ record: "snapshot", code: TIME_IN_FUTURE }]
  await ctx.db.insert(syncRuns).values({ kind, startedAt: now, finishedAt: now, outcome: "failed", counts: {}, errors })
  log.warn("sync snapshot refused", { kind, code: TIME_IN_FUTURE })
  throw invalid("collectedAt is later than the server's clock allows.", { field: "collectedAt" })
}

export type ApplyHooks = {
  /** Test seam: runs after the run read its starting state, before any record is processed. */
  afterLoad?: () => Promise<void>
  /** Test seam: runs after the item states were read and before any change is applied. */
  beforeApply?: () => Promise<void>
}

/**
 * Applies a full T3 snapshot (every top-level thread of every project): projects, missing items, thread
 * links, then the per-item status decision. Idempotent; keeps no boundary between runs.
 */
export async function applyT3Snapshot(ctx: Ctx, snapshot: T3Snapshot, hooks: ApplyHooks = {}): Promise<SyncResult> {
  const limit = latestAllowed(ctx)
  await refuseFutureSnapshot(ctx, "t3", snapshot.collectedAt, limit)
  const runId = await startRun(ctx, "t3")
  const run = new Run("t3")
  return guarded(ctx, runId, run, async () => {
    const [previous] = await ctx.db
      .select({ id: syncRuns.id })
      .from(syncRuns)
      .where(and(eq(syncRuns.kind, "t3"), inArray(syncRuns.outcome, SUCCESSFUL)))
      .limit(1)
    const firstRun = !previous

    const projectIds = new Map<string, string>()
    const unread = new Set(snapshot.failedProjects ?? [])
    for (const id of unread) run.missing(`threads:${id}`, "threads_not_read")
    await hooks.afterLoad?.()

    // 1. Projects: upsert by T3 project id, except those the owner deleted.
    for (const p of snapshot.projects) {
      await run.record(`project:${p.t3ProjectId}`, async () => {
        // Under the link structure lock: an owner delete that commits during the run wins.
        await inLinkTx(ctx, async (tx) => {
          const [existing] = await tx
            .select()
            .from(projects)
            .where(eq(projects.t3ProjectId, p.t3ProjectId))
            .for("update")
          if (existing) {
            projectIds.set(p.t3ProjectId, existing.id)
            // The owner names projects in Adiutor; the sync only fills a missing repository.
            if (p.repo && !existing.githubRepo) {
              const [after] = await tx
                .update(projects)
                .set({ githubRepo: p.repo, updatedAt: ctx.clock() })
                .where(eq(projects.id, existing.id))
                .returning()
              await writeAudit(ctx, tx, SYNC, {
                action: "project.update",
                entityType: "project",
                entityId: existing.id,
                before: existing,
                after,
              })
              run.add("projectsUpdated")
            }
            return
          }
          if (await isSuppressed(tx, "project", p.t3ProjectId)) return run.add("projectsSuppressed")
          const name = ctx.secrets.redact(p.title).trim() || p.t3ProjectId
          const created = await createProjectTx(ctx, tx, SYNC, {
            name,
            t3ProjectId: p.t3ProjectId,
            githubRepo: p.repo ?? null,
          })
          projectIds.set(p.t3ProjectId, created.id)
          run.add("projectsCreated")
        })
      })
    }
    for (const row of await ctx.db
      .select({ id: projects.id, t3: projects.t3ProjectId })
      .from(projects)
      .where(isNotNull(projects.t3ProjectId))) {
      if (row.t3 && !projectIds.has(row.t3)) projectIds.set(row.t3, row.id)
    }

    // 2. Threads. A child thread never has its own item: its link folds into the top-level thread.
    // A thread whose times are later than the server's clock allows is refused alone; the tree still counts it.
    const parentOf = new Map(snapshot.threads.map((t) => [t.threadId, t.parentThreadId ?? null]))
    const threads = snapshot.threads.filter((t) => {
      if (!later(t.updatedAt, limit) && !later(t.settledAt, limit)) return true
      run.refuse(`thread:${t.threadId}`, TIME_IN_FUTURE)
      return false
    })
    const byId = new Map(threads.map((t) => [t.threadId, t]))
    for (const thread of threads) {
      if (!thread.parentThreadId) continue
      await run.record(`thread:${thread.threadId}`, async () => {
        const root = rootThreadId(thread.threadId, parentOf)
        if (root) await foldChildLink(ctx, run, thread.threadId, root, byId.get(root))
      })
    }

    for (const thread of threads) {
      if (thread.parentThreadId) continue
      await run.record(`thread:${thread.threadId}`, async () => {
        const title = ctx.secrets.redact(thread.title).trim()
        // Under the link structure lock, as an owner delete and an agent's link: the suppression and link
        // checks below stay true until this transaction commits.
        await inLinkTx(ctx, async (tx) => {
          const [link] = await tx
            .select()
            .from(itemThreads)
            .where(eq(itemThreads.threadId, thread.threadId))
            .for("update")
          const fields = {
            t3ProjectId: thread.t3ProjectId,
            title: title || null,
            lastStatus: thread.status,
            settled: thread.settled,
            lastActivityAt: thread.updatedAt,
          }
          if (link) {
            // An older snapshot applied after a newer one: the stored state is newer (equal: nothing new).
            if (link.lastActivityAt && thread.updatedAt.getTime() <= link.lastActivityAt.getTime()) return
            if (!linkChanged(link, fields)) return
            const [after] = await tx.update(itemThreads).set(fields).where(eq(itemThreads.id, link.id)).returning()
            await writeAudit(ctx, tx, SYNC, {
              action: "thread.update",
              entityType: "item",
              entityId: link.itemId,
              before: link,
              after,
            })
            return run.add("threadsUpdated")
          }
          if (await isSuppressed(tx, "thread", thread.threadId)) return run.add("threadsSuppressed")
          if (thread.t3ProjectId && (await isSuppressed(tx, "project", thread.t3ProjectId)))
            return run.add("threadsSuppressed")
          if (!wantsItem(thread, snapshot.collectedAt)) return run.add("threadsTooOld")

          const item = await createItemTx(
            ctx,
            tx,
            SYNC,
            {
              projectId: thread.t3ProjectId ? (projectIds.get(thread.t3ProjectId) ?? null) : null,
              type: "task",
              status: newItemStatus(thread),
              title: title || "Untitled T3 thread",
            },
            { imported: firstRun },
          )
          const [inserted] = await tx
            .insert(itemThreads)
            .values({ itemId: item.id, threadId: thread.threadId, linkedAt: ctx.clock(), ...fields })
            .onConflictDoNothing({ target: itemThreads.threadId })
            .returning()
          // An agent linked the thread at the same moment: roll this item back; the next run sees the link.
          if (!inserted) throw new AppError("conflict", "The thread was linked at the same time.")
          await writeAudit(ctx, tx, SYNC, {
            action: "thread.link",
            entityType: "item",
            entityId: item.id,
            after: inserted,
          })
          run.add("itemsCreated")
        })
      })
    }

    // 3. Read every item with a linked thread, and decide its status over all of its threads.
    const rows = await ctx.db
      .select({ item: items, link: itemThreads })
      .from(items)
      .innerJoin(itemThreads, eq(itemThreads.itemId, items.id))
    const grouped = new Map<string, { item: ItemRow; links: ThreadLinkRow[] }>()
    for (const { item, link } of rows) {
      const entry = grouped.get(item.id) ?? { item, links: [] }
      entry.links.push(link)
      grouped.set(item.id, entry)
    }
    // An item of a project whose threads were not read is not decided in this run.
    const unreadProjectIds = new Set([...unread].map((id) => projectIds.get(id)).filter((id) => id !== undefined))
    const decisions = [...grouped.values()]
      .filter(({ item, links }) => {
        const notRead =
          (item.projectId !== null && unreadProjectIds.has(item.projectId)) ||
          links.some((l) => l.t3ProjectId !== null && unread.has(l.t3ProjectId))
        if (notRead) run.add("itemsNotDecided")
        return !notRead
      })
      .map(({ item, links }) => ({ item, target: syncDecision(item, links) }))
      .filter((d) => d.target !== null)

    await hooks.beforeApply?.()

    // 4. Apply each decision as a compare-and-set on the version read in step 3.
    for (const { item, target } of decisions) {
      if (!target) continue
      await run.record(`item:${item.id}`, async () => {
        try {
          await inTx(ctx, (tx) => updateItemTx(ctx, tx, SYNC, item.id, item.version, { status: target }))
          run.add("itemsUpdated")
        } catch (error) {
          // Changed since the read (the owner, an agent) or deleted: decided again on the next run.
          if (error instanceof AppError && (error.code === "version_conflict" || error.code === "not_found"))
            return run.add("itemsSkipped")
          throw error
        }
      })
    }
  })
}

function linkChanged(link: ThreadLinkRow, next: Partial<ThreadLinkRow>): boolean {
  return (
    link.t3ProjectId !== next.t3ProjectId ||
    link.title !== next.title ||
    link.lastStatus !== next.lastStatus ||
    link.settled !== next.settled ||
    link.lastActivityAt?.getTime() !== next.lastActivityAt?.getTime()
  )
}

/**
 * A link on a child thread moves to the top-level thread: when the root has its own link, the child's
 * link goes; otherwise the link is re-pointed at the root thread, unless the owner suppressed the root
 * thread or its T3 project (when the snapshot names it): the child's link then stays as it is.
 */
async function foldChildLink(
  ctx: Ctx,
  run: Run,
  childId: string,
  rootId: string,
  root: T3Snapshot["threads"][number] | undefined,
) {
  // Under the link structure lock: an owner delete or an agent's link of the root thread runs entirely
  // before or after this fold, so a delete suppresses either the child's link or the moved one.
  await inLinkTx(ctx, async (tx) => {
    const [child] = await tx.select().from(itemThreads).where(eq(itemThreads.threadId, childId)).for("update")
    if (!child) return
    const [rootLink] = await tx.select().from(itemThreads).where(eq(itemThreads.threadId, rootId))
    if (rootLink) {
      await tx.delete(itemThreads).where(eq(itemThreads.id, child.id))
      await writeAudit(ctx, tx, SYNC, {
        action: "thread.unlink",
        entityType: "item",
        entityId: child.itemId,
        before: child,
        after: { foldedInto: rootId, itemId: rootLink.itemId },
      })
    } else if (
      (await isSuppressed(tx, "thread", rootId)) ||
      (root?.t3ProjectId && (await isSuppressed(tx, "project", root.t3ProjectId)))
    ) {
      // The owner deleted the root thread's item (or its project): only the owner tracks it again.
      return run.add("childLinksSuppressed")
    } else {
      const [after] = await tx
        .update(itemThreads)
        .set({
          threadId: rootId,
          ...(root && {
            t3ProjectId: root.t3ProjectId,
            title: ctx.secrets.redact(root.title).trim() || null,
            lastStatus: root.status,
            settled: root.settled,
            lastActivityAt: root.updatedAt,
          }),
        })
        .where(eq(itemThreads.id, child.id))
        .returning()
      await writeAudit(ctx, tx, SYNC, {
        action: "thread.move",
        entityType: "item",
        entityId: child.itemId,
        before: child,
        after,
      })
    }
    run.add("childLinksFolded")
  })
}

/**
 * Applies the security and Issues counts the overview collector gathered, per GitHub repository, to every
 * project linked to that repository. Families missing from the snapshot keep their last values.
 */
export async function applySecuritySnapshot(ctx: Ctx, snapshot: SecuritySnapshot): Promise<SyncResult> {
  const limit = latestAllowed(ctx)
  await refuseFutureSnapshot(ctx, "security", snapshot.collectedAt, limit)
  const runId = await startRun(ctx, "security")
  const run = new Run("security")
  return guarded(ctx, runId, run, async () => {
    for (const repo of snapshot.repos) {
      // Any time later than the server's clock allows refuses the whole repository record, before any write.
      if (later(repo.issuesAsOf, limit) || repo.families.some((f) => later(f.asOf, limit))) {
        run.refuse(`repo:${repo.repo}`, TIME_IN_FUTURE)
        continue
      }
      await run.record(`repo:${repo.repo}`, async () => {
        const matches = await ctx.db
          .select({ id: projects.id })
          .from(projects)
          .where(sql`lower(${projects.githubRepo}) = ${repo.repo.toLowerCase()}`)
        if (matches.length === 0) return run.add("reposUnmatched")
        for (const { id } of matches) {
          await inTx(ctx, async (tx) => {
            const [project] = await tx.select().from(projects).where(eq(projects.id, id)).for("update")
            if (!project) return
            const sourcesBefore = await tx.select().from(securitySources).where(eq(securitySources.projectId, id))
            const now = ctx.clock()
            let changed = false
            // What is stored after this record: the audit row records that, not the snapshot.
            let issues = { openIssuesCount: project.openIssuesCount, openIssuesAsOf: project.openIssuesAsOf }
            if (
              !staleAgainst(repo.issuesAsOf, project.openIssuesAsOf) &&
              (project.openIssuesCount !== repo.openIssues ||
                project.openIssuesAsOf?.getTime() !== repo.issuesAsOf?.getTime())
            ) {
              await tx
                .update(projects)
                .set({ openIssuesCount: repo.openIssues, openIssuesAsOf: repo.issuesAsOf, updatedAt: now })
                .where(eq(projects.id, id))
              issues = { openIssuesCount: repo.openIssues, openIssuesAsOf: repo.issuesAsOf }
              changed = true
            }
            for (const f of repo.families) {
              const old = sourcesBefore.find((s) => s.family === f.family)
              // An older snapshot applied after a newer one, or a failed read, never rolls the counts back.
              if (old && staleAgainst(f.asOf, old.asOf)) continue
              const values = { coverage: f.coverage, ...f.counts, asOf: f.asOf }
              if (
                old &&
                old.coverage === values.coverage &&
                old.critical === values.critical &&
                old.high === values.high &&
                old.medium === values.medium &&
                old.low === values.low &&
                old.asOf?.getTime() === values.asOf?.getTime()
              )
                continue
              await tx
                .insert(securitySources)
                .values({ projectId: id, family: f.family, ...values, updatedAt: now })
                .onConflictDoUpdate({
                  target: [securitySources.projectId, securitySources.family],
                  set: { ...values, updatedAt: now },
                })
              changed = true
            }
            if (!changed) return
            const sourcesAfter = await tx.select().from(securitySources).where(eq(securitySources.projectId, id))
            await writeAudit(ctx, tx, SYNC, {
              action: "security.update",
              entityType: "project",
              entityId: id,
              before: {
                openIssuesCount: project.openIssuesCount,
                openIssuesAsOf: project.openIssuesAsOf,
                sources: sourcesBefore,
              },
              after: { ...issues, sources: sourcesAfter },
            })
            run.add("projectsUpdated")
          })
        }
      })
    }
  })
}

/**
 * True when an incoming record must not replace the stored one: the stored record has a time and the
 * incoming one is older, or has no time at all (a failed or unknown read never overwrites a known one).
 */
function staleAgainst(next: Date | null, stored: Date | null): boolean {
  return stored !== null && (next === null || next.getTime() < stored.getTime())
}

/** The latest runs, newest first. */
export function recentSyncRuns(ctx: Ctx, limit = 20): Promise<SyncRunRow[]> {
  return ctx.db.select().from(syncRuns).orderBy(desc(syncRuns.startedAt)).limit(limit)
}
