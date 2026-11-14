import { eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { SecuritySnapshot, T3Snapshot } from "../../shared/api.ts"
import { audit, items, itemThreads, projects, securitySources, suppressions, syncRuns } from "../db/schema.ts"
import { agent, createTestDatabase, owner, type TestDatabase } from "../testing/db.ts"
import { lockLinkStructure } from "./context.ts"
import { createItem, deleteItem, getItemRow, linkThread, updateItem } from "./items.ts"
import { createProject, deleteProject } from "./projects.ts"
import { REDACTED } from "./secrets.ts"
import { applySecuritySnapshot, applyT3Snapshot, SYNC_CLOCK_SKEW_MS } from "./sync.ts"
import { startThread } from "./threads.ts"

let t: TestDatabase

beforeAll(async () => {
  t = await createTestDatabase("sync", ["corp.example"])
})
afterAll(async () => {
  await t?.close()
})
beforeEach(async () => {
  await t.reset()
})

type Thread = T3Snapshot["threads"][number]
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const ago = (ms: number) => new Date(t.ctx.clock().getTime() - ms)

function thread(threadId: string, extra: Partial<Thread> = {}): Thread {
  return {
    threadId,
    t3ProjectId: "t3-garden",
    title: `Thread ${threadId}`,
    status: "running",
    settled: false,
    settledAt: null,
    parentThreadId: null,
    updatedAt: ago(HOUR),
    ...extra,
  }
}

function snapshot(threads: Thread[], extra: Partial<T3Snapshot> = {}): T3Snapshot {
  return {
    collectedAt: t.ctx.clock(),
    projects: [{ t3ProjectId: "t3-garden", title: "Garden Planner", repo: "example/garden" }],
    threads,
    ...extra,
  }
}

const itemOf = async (threadId: string) => {
  const [row] = await t.ctx.db
    .select({ item: items })
    .from(itemThreads)
    .innerJoin(items, eq(items.id, itemThreads.itemId))
    .where(eq(itemThreads.threadId, threadId))
  return row?.item
}

/** An item linked to the given threads, in the given status, as an agent would leave it. */
async function linkedItem(status: "in_progress" | "todo" | "future" | "done" | "waiting_on_you", threadIds: string[]) {
  const item = await createItem(t.ctx, agent, { type: "task", title: "Linked", status })
  for (const threadId of threadIds) await linkThread(t.ctx, agent, item.id, { threadId })
  return item
}

describe("applyT3Snapshot", () => {
  it("creates projects without a stage and items for unsettled threads, flagged imported on the first run", async () => {
    const result = await applyT3Snapshot(
      t.ctx,
      snapshot([thread("a"), thread("b", { status: "waiting" }), thread("c", { status: "completed" })]),
    )
    expect(result.outcome).toBe("succeeded")
    expect(result.counts).toMatchObject({ projectsCreated: 1, itemsCreated: 3 })
    const [project] = await t.ctx.db.select().from(projects)
    expect(project).toMatchObject({ name: "Garden Planner", stage: null, githubRepo: "example/garden" })
    expect(await itemOf("a")).toMatchObject({ status: "in_progress", imported: true, projectId: project?.id })
    expect(await itemOf("b")).toMatchObject({ status: "waiting_on_you", createdBy: "sync" })
    expect(await itemOf("c")).toMatchObject({ status: "in_progress" })

    const second = await applyT3Snapshot(t.ctx, snapshot([thread("a"), thread("d")]))
    expect(second.counts).toMatchObject({ itemsCreated: 1 })
    expect(await itemOf("d")).toMatchObject({ imported: false })
    const runs = await t.ctx.db.select().from(syncRuns)
    expect(runs.map((r) => r.outcome)).toEqual(["succeeded", "succeeded"])
  })

  it("is idempotent: the same snapshot twice changes nothing the second time", async () => {
    const snap = snapshot([thread("a"), thread("b", { status: "waiting" })])
    await applyT3Snapshot(t.ctx, snap)
    const auditBefore = (await t.ctx.db.select().from(audit)).length
    const again = await applyT3Snapshot(t.ctx, snap)
    expect(again.counts).toEqual({})
    expect(await t.ctx.db.select().from(audit)).toHaveLength(auditBefore)
  })

  it("redacts secrets in thread and project titles", async () => {
    await applyT3Snapshot(
      t.ctx,
      snapshot([thread("a", { title: "Deploy to app01.corp.example with password=Hunter2024" })], {
        projects: [{ t3ProjectId: "t3-garden", title: "Garden on db.corp.example" }],
      }),
    )
    expect((await itemOf("a"))?.title).toBe(`Deploy to ${REDACTED} with password=${REDACTED}`)
    const [link] = await t.ctx.db.select().from(itemThreads)
    expect(link?.title).toBe(`Deploy to ${REDACTED} with password=${REDACTED}`)
    expect((await t.ctx.db.select().from(projects))[0]?.name).toBe(`Garden on ${REDACTED}`)
  })

  it("never renames a project the owner named, and never recreates one the owner deleted", async () => {
    await applyT3Snapshot(t.ctx, snapshot([]))
    const [p] = await t.ctx.db.select().from(projects)
    await t.ctx.db
      .update(projects)
      .set({ name: "Owner's name" })
      .where(eq(projects.id, p?.id ?? ""))
    await applyT3Snapshot(t.ctx, snapshot([]))
    expect((await t.ctx.db.select().from(projects))[0]?.name).toBe("Owner's name")

    await deleteProject(t.ctx, owner, p?.id ?? "")
    const result = await applyT3Snapshot(t.ctx, snapshot([thread("a")]))
    expect(result.counts).toMatchObject({ projectsSuppressed: 1, threadsSuppressed: 1 })
    expect(await t.ctx.db.select().from(projects)).toHaveLength(0)
    expect(await t.ctx.db.select().from(items)).toHaveLength(0)
  })

  it("never recreates an item the owner deleted", async () => {
    await applyT3Snapshot(t.ctx, snapshot([thread("a")]))
    const item = await itemOf("a")
    await deleteItem(t.ctx, owner, item?.id ?? "")
    const result = await applyT3Snapshot(t.ctx, snapshot([thread("a")]))
    expect(result.counts).toMatchObject({ threadsSuppressed: 1 })
    expect(await t.ctx.db.select().from(items)).toHaveLength(0)
  })

  it("never recreates an item or a project the owner deletes while a run is under way", async () => {
    await applyT3Snapshot(t.ctx, snapshot([thread("a")]))
    const item = await itemOf("a")
    // The delete commits after the run read its starting state and before it reaches the thread.
    const result = await applyT3Snapshot(t.ctx, snapshot([thread("a", { updatedAt: ago(HOUR / 2) })]), {
      afterLoad: () => deleteItem(t.ctx, owner, item?.id ?? ""),
    })
    expect(result.counts).toMatchObject({ threadsSuppressed: 1 })
    expect(await t.ctx.db.select().from(items)).toHaveLength(0)

    const [p] = await t.ctx.db.select().from(projects)
    const again = await applyT3Snapshot(t.ctx, snapshot([]), {
      afterLoad: () => deleteProject(t.ctx, owner, p?.id ?? ""),
    })
    expect(again.counts).toMatchObject({ projectsSuppressed: 1 })
    expect(await t.ctx.db.select().from(projects)).toHaveLength(0)
  })

  describe("an owner delete while the sync folds the item's child link", () => {
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
    // No projects: the sync's first transaction is the fold, so it queues for the lock before the delete.
    const folding = () =>
      snapshot([thread("root-1"), thread("child-1", { parentThreadId: "root-1" })], { projects: [] })
    const moves = () => t.ctx.db.select().from(audit).where(eq(audit.action, "thread.move"))
    const suppressed = async () => (await t.ctx.db.select().from(suppressions)).map((s) => s.externalId).sort()

    /** Holds the link structure lock until `release`, as a concurrent transaction would. */
    function holdLinkLock() {
      let release = () => {}
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      const done = t.ctx.db.transaction(async (tx) => {
        await lockLinkStructure(tx)
        await held
      })
      return { release, done }
    }

    it("waits for a delete that read the child's link: the link is not moved under it", async () => {
      const item = await linkedItem("in_progress", ["child-1"])
      const lock = holdLinkLock()
      await pause(50)
      // The delete waits for the lock first; the sync's fold waits behind it.
      const deleting = deleteItem(t.ctx, owner, item.id)
      await pause(100)
      const syncing = applyT3Snapshot(t.ctx, folding())
      await pause(300)
      lock.release()
      await lock.done
      await deleting
      await syncing
      // Before the fix the fold moved the link to root-1 meanwhile, and the delete removed root-1's link
      // while it suppressed only child-1.
      expect(await moves()).toHaveLength(0)
      expect(await suppressed()).toEqual(["child-1"])
    })

    it("suppresses the top-level thread when the fold moved the link first", async () => {
      const item = await linkedItem("in_progress", ["child-1"])
      const lock = holdLinkLock()
      await pause(50)
      const syncing = applyT3Snapshot(t.ctx, folding())
      await pause(200)
      const deleting = deleteItem(t.ctx, owner, item.id)
      await pause(100)
      lock.release()
      await lock.done
      await syncing
      await deleting
      expect(await moves()).toHaveLength(1)
      expect(await suppressed()).toEqual(["root-1"])
      const again = await applyT3Snapshot(t.ctx, folding())
      expect(again.counts).toMatchObject({ threadsSuppressed: 1 })
      expect(await t.ctx.db.select().from(items)).toHaveLength(0)
    })
  })

  it("ignores a thread record that is not newer than the stored one (snapshots out of order)", async () => {
    const newer = ago(HOUR)
    await applyT3Snapshot(t.ctx, snapshot([thread("a", { status: "running", updatedAt: newer })]))
    const older = snapshot([
      thread("a", { status: "completed", settled: true, settledAt: ago(2 * HOUR), updatedAt: ago(2 * HOUR) }),
    ])
    const result = await applyT3Snapshot(t.ctx, older)
    expect(result.counts).toEqual({})
    expect(await itemOf("a")).toMatchObject({ status: "in_progress" })
    const [link] = await t.ctx.db.select().from(itemThreads)
    expect(link).toMatchObject({ lastStatus: "running", settled: false, lastActivityAt: newer })
    // The same time with other data is a no-op too.
    await applyT3Snapshot(t.ctx, snapshot([thread("a", { status: "waiting", updatedAt: newer })]))
    expect((await t.ctx.db.select().from(itemThreads))[0]).toMatchObject({ lastStatus: "running" })
  })

  it("never lets a thread record dated in the future freeze the link against later honest records", async () => {
    const FUTURE = new Date(Date.UTC(2099, 0, 1))
    await applyT3Snapshot(t.ctx, snapshot([thread("a", { status: "running", updatedAt: ago(HOUR) })]))
    const item = await itemOf("a")
    expect(item).toMatchObject({ status: "in_progress" })
    const refused = await applyT3Snapshot(t.ctx, snapshot([thread("a", { status: "running", updatedAt: FUTURE })]))
    expect(refused.errors).toEqual([{ record: "thread:a", code: "time_in_future" }])
    expect(refused.outcome).toBe("partial")
    await updateItem(t.ctx, owner, item?.id ?? "", item?.version ?? 0, { status: "todo" })
    t.clock.travel(HOUR)
    // Activity after the owner's change: completed but not settled, which changes no status.
    await applyT3Snapshot(t.ctx, snapshot([thread("a", { status: "completed", updatedAt: ago(0) })]))
    const [link] = await t.ctx.db.select().from(itemThreads)
    expect(link).toMatchObject({ lastStatus: "completed" })
    expect(link?.lastActivityAt?.getTime()).toBeLessThanOrEqual(t.ctx.clock().getTime())
    expect(await getItemRow(t.ctx.db, item?.id ?? "")).toMatchObject({ status: "todo", statusSetBy: "owner" })
  })

  it("accepts thread times up to five minutes ahead of the server's clock and refuses later ones alone", async () => {
    const now = t.ctx.clock()
    const at = { ...t.ctx, clock: () => now }
    const edge = new Date(now.getTime() + SYNC_CLOCK_SKEW_MS)
    const beyond = new Date(edge.getTime() + 1)
    const result = await applyT3Snapshot(
      at,
      snapshot(
        [
          // Later than collectedAt (taken before the threads are read) but within the bound: accepted.
          thread("edge", { updatedAt: edge }),
          thread("late", { updatedAt: beyond }),
          thread("settled-late", { status: "completed", settled: true, settledAt: beyond, updatedAt: ago(HOUR) }),
        ],
        { collectedAt: new Date(now.getTime() - 10 * 60_000) },
      ),
    )
    expect(result.outcome).toBe("partial")
    expect(result.errors).toEqual([
      { record: "thread:late", code: "time_in_future" },
      { record: "thread:settled-late", code: "time_in_future" },
    ])
    expect(result.counts).toMatchObject({ projectsCreated: 1, itemsCreated: 1 })
    expect(await itemOf("edge")).toMatchObject({ status: "in_progress" })
    expect(await itemOf("late")).toBeUndefined()
    expect(await itemOf("settled-late")).toBeUndefined()
  })

  it("folds a child under a refused root without taking the root's times", async () => {
    const FUTURE = new Date(Date.UTC(2099, 0, 1))
    const item = await linkedItem("in_progress", ["child"])
    const result = await applyT3Snapshot(
      t.ctx,
      snapshot([
        thread("root", { status: "waiting", updatedAt: FUTURE }),
        thread("child", { parentThreadId: "root", updatedAt: ago(HOUR) }),
      ]),
    )
    expect(result.errors).toEqual([{ record: "thread:root", code: "time_in_future" }])
    expect(result.counts).toMatchObject({ childLinksFolded: 1 })
    const [link] = await t.ctx.db.select().from(itemThreads)
    expect(link).toMatchObject({ itemId: item.id, threadId: "root" })
    expect(link?.lastActivityAt?.getTime() ?? 0).toBeLessThan(FUTURE.getTime())
    expect(link?.lastStatus).not.toBe("waiting")
  })

  it("refuses a whole snapshot collected later than the server's clock allows, and records the run as failed", async () => {
    const now = t.ctx.clock()
    const at = { ...t.ctx, clock: () => now }
    const edge = snapshot([thread("a")], { collectedAt: new Date(now.getTime() + SYNC_CLOCK_SKEW_MS) })
    expect((await applyT3Snapshot(at, edge)).outcome).toBe("succeeded")
    await t.reset()
    const beyond = snapshot([thread("a")], { collectedAt: new Date(now.getTime() + SYNC_CLOCK_SKEW_MS + 1) })
    await expect(applyT3Snapshot(at, beyond)).rejects.toMatchObject({ code: "validation_failed" })
    expect(await t.ctx.db.select().from(projects)).toEqual([])
    expect(await t.ctx.db.select().from(items)).toEqual([])
    const runs = await t.ctx.db.select().from(syncRuns)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      kind: "t3",
      outcome: "failed",
      errors: [{ record: "snapshot", code: "time_in_future" }],
    })
    expect(runs[0]?.finishedAt).not.toBeNull()
  })

  it("imports a settled thread without an item only when it settled in the last 7 days", async () => {
    const result = await applyT3Snapshot(
      t.ctx,
      snapshot([
        thread("recent", { status: "completed", settled: true, settledAt: ago(6 * DAY) }),
        thread("old", { status: "completed", settled: true, settledAt: ago(8 * DAY), updatedAt: ago(HOUR) }),
        thread("ancient-open", { status: "completed", updatedAt: ago(400 * DAY) }),
      ]),
    )
    expect(result.counts).toMatchObject({ itemsCreated: 2, threadsTooOld: 1 })
    const recent = await itemOf("recent")
    expect(recent).toMatchObject({ status: "done" })
    expect(recent?.closedAt).toBeInstanceOf(Date)
    expect(await itemOf("old")).toBeUndefined()
    expect(await itemOf("ancient-open")).toBeDefined()
  })

  it("decides over all linked threads: one running keeps the item in_progress", async () => {
    const item = await linkedItem("waiting_on_you", ["one", "two"])
    await applyT3Snapshot(
      t.ctx,
      snapshot([thread("one", { status: "completed", settled: true }), thread("two", { status: "running" })]),
    )
    expect((await getItemRow(t.ctx.db, item.id)).status).toBe("in_progress")
    await applyT3Snapshot(
      t.ctx,
      snapshot([thread("one", { status: "completed", settled: true }), thread("two", { status: "waiting" })]),
    )
    expect((await getItemRow(t.ctx.db, item.id)).status).toBe("waiting_on_you")
    await applyT3Snapshot(
      t.ctx,
      snapshot([
        thread("one", { status: "completed", settled: true }),
        thread("two", { status: "completed", settled: true }),
      ]),
    )
    const done = await getItemRow(t.ctx.db, item.id)
    expect(done).toMatchObject({ status: "done", statusSetBy: "sync" })
    expect(done.closedAt).toBeInstanceOf(Date)
  })

  it("changes nothing for a completed but unsettled thread", async () => {
    const item = await linkedItem("in_progress", ["one"])
    await applyT3Snapshot(t.ctx, snapshot([thread("one", { status: "completed", settled: false })]))
    expect(await getItemRow(t.ctx.db, item.id)).toMatchObject({ status: "in_progress", version: 1 })
  })

  it("never moves an item out of done, and never sets done on future or todo", async () => {
    const done = await linkedItem("done", ["d"])
    const future = await linkedItem("future", ["f"])
    const todo = await linkedItem("todo", ["t"])
    await applyT3Snapshot(
      t.ctx,
      snapshot([
        thread("d", { status: "running" }),
        thread("f", { status: "completed", settled: true }),
        thread("t", { status: "completed", settled: true }),
      ]),
    )
    expect((await getItemRow(t.ctx.db, done.id)).status).toBe("done")
    expect((await getItemRow(t.ctx.db, future.id)).status).toBe("future")
    expect((await getItemRow(t.ctx.db, todo.id)).status).toBe("todo")
  })

  it("lets the owner win: a status the owner set after the threads' last activity stays", async () => {
    const item = await linkedItem("in_progress", ["one"])
    await updateItem(t.ctx, owner, item.id, 1, { status: "todo" })
    await applyT3Snapshot(t.ctx, snapshot([thread("one", { status: "running", updatedAt: ago(HOUR) })]))
    expect(await getItemRow(t.ctx.db, item.id)).toMatchObject({ status: "todo", statusSetBy: "owner" })
    // New activity in the thread after the owner's change: the sync decides again.
    t.clock.travel(2 * HOUR)
    await applyT3Snapshot(t.ctx, snapshot([thread("one", { status: "running", updatedAt: ago(HOUR) })]))
    expect(await getItemRow(t.ctx.db, item.id)).toMatchObject({ status: "in_progress", statusSetBy: "sync" })
  })

  it("skips an item the owner edits between the read and the apply, and decides it again next run", async () => {
    const item = await linkedItem("in_progress", ["one"])
    const result = await applyT3Snapshot(t.ctx, snapshot([thread("one", { status: "waiting" })]), {
      beforeApply: async () => {
        await updateItem(t.ctx, owner, item.id, 1, { title: "Renamed by the owner" })
      },
    })
    expect(result.counts).toMatchObject({ itemsSkipped: 1 })
    expect(result.outcome).toBe("succeeded")
    expect(await getItemRow(t.ctx.db, item.id)).toMatchObject({
      status: "in_progress",
      title: "Renamed by the owner",
      version: 2,
    })
    const next = await applyT3Snapshot(t.ctx, snapshot([thread("one", { status: "waiting" })]))
    expect(next.counts).toMatchObject({ itemsUpdated: 1 })
    expect(await getItemRow(t.ctx.db, item.id)).toMatchObject({ status: "waiting_on_you", version: 3 })
  })

  it("folds child threads into their parent: no item of their own, links moved", async () => {
    // A child linked to an item while its parent has none: the link moves to the parent thread.
    const orphanItem = await linkedItem("in_progress", ["child-1"])
    // A child linked to an item while its parent has its own: the child's link goes.
    const parentItem = await linkedItem("in_progress", ["parent-2"])
    const strayItem = await linkedItem("in_progress", ["child-2"])
    const result = await applyT3Snapshot(
      t.ctx,
      snapshot([
        thread("parent-1", { status: "waiting" }),
        thread("child-1", { parentThreadId: "parent-1" }),
        thread("grandchild-1", { parentThreadId: "child-1" }),
        thread("parent-2"),
        thread("child-2", { parentThreadId: "parent-2" }),
        thread("child-3", { parentThreadId: "parent-2" }),
      ]),
    )
    expect(result.counts).toMatchObject({ childLinksFolded: 2 })
    expect((await itemOf("parent-1"))?.id).toBe(orphanItem.id)
    expect(await itemOf("child-1")).toBeUndefined()
    expect(await itemOf("grandchild-1")).toBeUndefined()
    expect(await itemOf("child-3")).toBeUndefined()
    expect((await itemOf("parent-2"))?.id).toBe(parentItem.id)
    expect(await itemOf("child-2")).toBeUndefined()
    expect(await t.ctx.db.select().from(itemThreads).where(eq(itemThreads.itemId, strayItem.id))).toHaveLength(0)
    expect((await getItemRow(t.ctx.db, orphanItem.id)).status).toBe("waiting_on_you")
    expect(await t.ctx.db.select().from(items)).toHaveLength(3)
  })

  it("never folds a child's link into a top-level thread the owner suppressed", async () => {
    // The owner deleted the item of root-1: root-1 is suppressed and has no link.
    const deleted = await linkedItem("in_progress", ["root-1"])
    await deleteItem(t.ctx, owner, deleted.id)
    const item = await linkedItem("in_progress", ["child-1"])

    // The parent is not in the snapshot: it is still the top-level thread the fold would move the link to.
    const result = await applyT3Snapshot(t.ctx, snapshot([thread("child-1", { parentThreadId: "root-1" })]))
    expect(result.counts).toMatchObject({ childLinksSuppressed: 1 })
    expect(result.counts.childLinksFolded).toBeUndefined()
    expect((await itemOf("child-1"))?.id).toBe(item.id)
    expect(await itemOf("root-1")).toBeUndefined()
    expect(await t.ctx.db.select().from(audit).where(eq(audit.action, "thread.move"))).toHaveLength(0)

    const before = await getItemRow(t.ctx.db, item.id)
    await expect(
      startThread(t.ctx, agent, { threadId: "root-1", parentThreadId: null, title: "Root" }),
    ).rejects.toMatchObject({ code: "suppressed" })
    const again = await applyT3Snapshot(t.ctx, snapshot([thread("root-1", { updatedAt: ago(HOUR / 2) })]))
    expect(again.counts).toMatchObject({ threadsSuppressed: 1 })
    expect(again.counts.threadsUpdated).toBeUndefined()
    expect(await getItemRow(t.ctx.db, item.id)).toMatchObject({ version: before.version })
  })

  it("never folds a child's link into a top-level thread of a project the owner deleted", async () => {
    const gone = await createProject(t.ctx, owner, { name: "Gone", t3ProjectId: "t3-gone" })
    await deleteProject(t.ctx, owner, gone.id)
    const item = await linkedItem("in_progress", ["child-1"])

    const result = await applyT3Snapshot(
      t.ctx,
      snapshot([thread("root-1", { t3ProjectId: "t3-gone" }), thread("child-1", { parentThreadId: "root-1" })], {
        projects: [],
      }),
    )
    expect(result.counts).toMatchObject({ childLinksSuppressed: 1, threadsSuppressed: 1 })
    expect(result.counts.childLinksFolded).toBeUndefined()
    expect((await itemOf("child-1"))?.id).toBe(item.id)
    expect(await itemOf("root-1")).toBeUndefined()
  })

  it("keeps going when a record fails and records it in sync_runs", async () => {
    const result = await applyT3Snapshot(
      t.ctx,
      snapshot([thread("a"), thread("b", { t3ProjectId: "t3-broken" })], {
        projects: [
          { t3ProjectId: "t3-broken", title: "Broken", repo: "not a repository" },
          { t3ProjectId: "t3-garden", title: "Garden Planner" },
        ],
      }),
    )
    expect(result.outcome).toBe("partial")
    expect(result.errors).toEqual([{ record: "project:t3-broken", code: "validation_failed" }])
    expect(result.counts).toMatchObject({ projectsCreated: 1, itemsCreated: 2 })
    // The thread of the failed project still gets its item, in the inbox.
    expect(await itemOf("b")).toMatchObject({ projectId: null })
    const [run] = await t.ctx.db.select().from(syncRuns)
    expect(run).toMatchObject({ kind: "t3", outcome: "partial", errors: result.errors })
    expect(run?.finishedAt).toBeInstanceOf(Date)
  })

  it("logs a failing record without the query's text or parameters", async () => {
    const lines: string[] = []
    const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => void lines.push(String(line)))
    let result: Awaited<ReturnType<typeof applyT3Snapshot>>
    try {
      // PostgreSQL refuses a NUL character in text: the record fails with the title as a parameter.
      result = await applyT3Snapshot(
        t.ctx,
        snapshot([thread("a", { title: `private-title-0815${String.fromCharCode(0)}` })]),
      )
    } finally {
      spy.mockRestore()
    }
    expect(result.errors).toEqual([{ record: "thread:a", code: "internal_error" }])
    const logged = lines.join(" ")
    expect(logged).toContain('"sqlstate":"22021"')
    expect(logged).not.toContain("private-title-0815")
    expect(logged).not.toMatch(/insert into|params/i)
  })

  it("records a run with unread projects as partial and never decides their items", async () => {
    await applyT3Snapshot(t.ctx, snapshot([thread("n1", { t3ProjectId: "t3-notes", status: "waiting" })]))
    const item = await itemOf("n1")
    await updateItem(t.ctx, agent, item?.id ?? "", item?.version ?? 0, { status: "in_progress" })
    // The threads of t3-notes could not be read: its item keeps the agent's status in this run.
    const result = await applyT3Snapshot(t.ctx, snapshot([thread("a")], { failedProjects: ["t3-notes"] }))
    expect(result.outcome).toBe("partial")
    expect(result.errors).toEqual([{ record: "threads:t3-notes", code: "threads_not_read" }])
    expect(result.counts).toMatchObject({ itemsCreated: 1, itemsNotDecided: 1 })
    expect(await itemOf("n1")).toMatchObject({ status: "in_progress" })
    const runs = await t.ctx.db.select().from(syncRuns)
    expect(runs.map((r) => r.outcome)).toEqual(["succeeded", "partial"])
  })

  it("leaves items an agent linked through startThread to the agent's status until the threads say otherwise", async () => {
    const started = await startThread(t.ctx, agent, { threadId: "s-1", parentThreadId: null, title: "Started" })
    await applyT3Snapshot(t.ctx, snapshot([thread("s-1", { status: "running" })]))
    expect(await getItemRow(t.ctx.db, started.item.id)).toMatchObject({ status: "in_progress", version: 1 })
  })
})

describe("applySecuritySnapshot", () => {
  function security(extra: Partial<SecuritySnapshot["repos"][number]> = {}): SecuritySnapshot {
    return {
      collectedAt: t.ctx.clock(),
      repos: [
        {
          repo: "Example/Garden",
          openIssues: 4,
          issuesAsOf: ago(HOUR),
          families: [
            {
              family: "dependabot",
              coverage: "enabled",
              counts: { critical: 1, high: 2, medium: 0, low: 3 },
              asOf: ago(HOUR),
            },
            {
              family: "code_scanning",
              coverage: "not_enabled",
              counts: { critical: 0, high: 0, medium: 0, low: 0 },
              asOf: null,
            },
          ],
          ...extra,
        },
        { repo: "example/unknown", openIssues: 1, issuesAsOf: ago(HOUR), families: [] },
      ],
    }
  }

  it("maps repositories to projects case-insensitively and stores sources and open Issues", async () => {
    const project = await createProject(t.ctx, owner, { name: "Garden", githubRepo: "example/garden" })
    const snap = security()
    const result = await applySecuritySnapshot(t.ctx, snap)
    expect(result).toMatchObject({ outcome: "succeeded", counts: { projectsUpdated: 1, reposUnmatched: 1 } })
    const [p] = await t.ctx.db.select().from(projects).where(eq(projects.id, project.id))
    expect(p?.openIssuesCount).toBe(4)
    const sources = await t.ctx.db.select().from(securitySources).where(eq(securitySources.projectId, project.id))
    expect(sources.map((s) => [s.family, s.coverage, s.critical, s.high]).sort()).toEqual([
      ["code_scanning", "not_enabled", 0, 0],
      ["dependabot", "enabled", 1, 2],
    ])
    const auditCount = (await t.ctx.db.select().from(audit).where(eq(audit.action, "security.update"))).length
    expect(auditCount).toBe(1)
    // The same data again changes nothing.
    const again = await applySecuritySnapshot(t.ctx, snap)
    expect(again.counts).toEqual({ reposUnmatched: 1 })
    expect(await t.ctx.db.select().from(audit).where(eq(audit.action, "security.update"))).toHaveLength(auditCount)
  })

  it("never rolls back counts with an older snapshot applied after a newer one", async () => {
    const project = await createProject(t.ctx, owner, { name: "Garden", githubRepo: "example/garden" })
    await applySecuritySnapshot(t.ctx, security())
    const older = security({
      openIssues: 9,
      issuesAsOf: ago(3 * HOUR),
      families: [
        {
          family: "dependabot",
          coverage: "enabled",
          counts: { critical: 7, high: 7, medium: 7, low: 7 },
          asOf: ago(3 * HOUR),
        },
      ],
    })
    const result = await applySecuritySnapshot(t.ctx, older)
    expect(result.counts).toEqual({ reposUnmatched: 1 })
    const [p] = await t.ctx.db.select().from(projects).where(eq(projects.id, project.id))
    expect(p?.openIssuesCount).toBe(4)
    const sources = await t.ctx.db.select().from(securitySources).where(eq(securitySources.projectId, project.id))
    expect(sources.find((s) => s.family === "dependabot")).toMatchObject({ critical: 1, high: 2, low: 3 })
  })

  it("never lets counts dated in the future hold back a later honest snapshot", async () => {
    const FUTURE = new Date(Date.UTC(2099, 0, 1))
    const project = await createProject(t.ctx, owner, { name: "Garden", githubRepo: "example/garden" })
    await applySecuritySnapshot(t.ctx, security())
    const zero = { critical: 0, high: 0, medium: 0, low: 0 }
    const refused = await applySecuritySnapshot(
      t.ctx,
      security({
        openIssues: 0,
        issuesAsOf: FUTURE,
        families: [{ family: "dependabot", coverage: "enabled", counts: zero, asOf: FUTURE }],
      }),
    )
    expect(refused.errors).toEqual([{ record: "repo:Example/Garden", code: "time_in_future" }])
    t.clock.travel(HOUR)
    await applySecuritySnapshot(
      t.ctx,
      security({
        openIssues: 6,
        issuesAsOf: ago(0),
        families: [{ family: "dependabot", coverage: "enabled", counts: { ...zero, critical: 5 }, asOf: ago(0) }],
      }),
    )
    const [p] = await t.ctx.db.select().from(projects).where(eq(projects.id, project.id))
    expect(p?.openIssuesCount).toBe(6)
    const sources = await t.ctx.db.select().from(securitySources).where(eq(securitySources.projectId, project.id))
    expect(sources.find((s) => s.family === "dependabot")).toMatchObject({ critical: 5 })
  })

  it("refuses a repository when any one of its times is later than the server's clock allows, writing none of it", async () => {
    const now = t.ctx.clock()
    const at = { ...t.ctx, clock: () => now }
    const beyond = new Date(now.getTime() + SYNC_CLOCK_SKEW_MS + 1)
    const edge = new Date(now.getTime() + SYNC_CLOCK_SKEW_MS)
    const project = await createProject(t.ctx, owner, { name: "Garden", githubRepo: "example/garden" })
    const zero = { critical: 0, high: 0, medium: 0, low: 0 }
    const valid = { family: "dependabot" as const, coverage: "enabled" as const, counts: zero, asOf: ago(HOUR) }
    const cases = [
      security({ openIssues: 9, issuesAsOf: beyond, families: [valid] }),
      security({ families: [valid, { ...valid, family: "code_scanning", asOf: beyond }] }),
    ]
    for (const snap of cases) {
      const result = await applySecuritySnapshot(at, snap)
      // The other repository in the snapshot is still read (it matches no project).
      expect(result).toMatchObject({ outcome: "partial", counts: { reposUnmatched: 1 } })
      expect(result.errors).toEqual([{ record: "repo:Example/Garden", code: "time_in_future" }])
      const [p] = await t.ctx.db.select().from(projects).where(eq(projects.id, project.id))
      expect(p?.openIssuesCount).toBeNull()
      expect(await t.ctx.db.select().from(securitySources)).toEqual([])
    }
    // Exactly at the bound is accepted.
    const accepted = await applySecuritySnapshot(
      at,
      security({ issuesAsOf: edge, families: [{ ...valid, asOf: edge }] }),
    )
    expect(accepted).toMatchObject({ outcome: "succeeded", counts: { projectsUpdated: 1 } })
  })

  it("refuses a whole security snapshot collected later than the server's clock allows", async () => {
    const now = t.ctx.clock()
    const at = { ...t.ctx, clock: () => now }
    await createProject(t.ctx, owner, { name: "Garden", githubRepo: "example/garden" })
    const snap = { ...security(), collectedAt: new Date(now.getTime() + SYNC_CLOCK_SKEW_MS + 1) }
    await expect(applySecuritySnapshot(at, snap)).rejects.toMatchObject({ code: "validation_failed" })
    expect(await t.ctx.db.select().from(securitySources)).toEqual([])
    const [run] = await t.ctx.db.select().from(syncRuns)
    expect(run).toMatchObject({
      kind: "security",
      outcome: "failed",
      errors: [{ record: "snapshot", code: "time_in_future" }],
    })
  })

  it("never overwrites known counts with a record that has no time (a failed or unknown read)", async () => {
    const project = await createProject(t.ctx, owner, { name: "Garden", githubRepo: "example/garden" })
    await applySecuritySnapshot(t.ctx, security())
    const failed = security({
      openIssues: null,
      issuesAsOf: null,
      families: [
        { family: "dependabot", coverage: "error", counts: { critical: 0, high: 0, medium: 0, low: 0 }, asOf: null },
      ],
    })
    const [stored] = await t.ctx.db.select().from(projects).where(eq(projects.id, project.id))
    const result = await applySecuritySnapshot(t.ctx, failed)
    expect(result.counts).toEqual({ reposUnmatched: 1 })
    const [p] = await t.ctx.db.select().from(projects).where(eq(projects.id, project.id))
    expect(p).toMatchObject({ openIssuesCount: 4, openIssuesAsOf: stored?.openIssuesAsOf })
    const sources = await t.ctx.db.select().from(securitySources).where(eq(securitySources.projectId, project.id))
    expect(sources.find((s) => s.family === "dependabot")).toMatchObject({ coverage: "enabled", critical: 1 })
  })

  it("records in the audit row the Issues count that was stored, not a refused older one", async () => {
    const project = await createProject(t.ctx, owner, { name: "Garden", githubRepo: "example/garden" })
    await applySecuritySnapshot(t.ctx, security())
    const [stored] = await t.ctx.db.select().from(projects).where(eq(projects.id, project.id))
    // Older Issues (refused) with a newer dependabot record (applied).
    const mixed = security({
      openIssues: 9,
      issuesAsOf: ago(3 * HOUR),
      families: [
        {
          family: "dependabot",
          coverage: "enabled",
          counts: { critical: 0, high: 0, medium: 0, low: 0 },
          asOf: ago(HOUR / 2),
        },
      ],
    })
    expect((await applySecuritySnapshot(t.ctx, mixed)).counts).toMatchObject({ projectsUpdated: 1 })
    const rows = await t.ctx.db.select().from(audit).where(eq(audit.action, "security.update"))
    const last = rows.find((r) => r.id === Math.max(...rows.map((x) => x.id)))
    expect(last?.after).toMatchObject({ openIssuesCount: 4, openIssuesAsOf: stored?.openIssuesAsOf?.toISOString() })
  })
})
