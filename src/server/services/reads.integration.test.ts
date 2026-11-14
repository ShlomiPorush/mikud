import { eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { audit, items, securitySources, syncRuns } from "../db/schema.ts"
import { agent, createTestDatabase, owner, type TestDatabase } from "../testing/db.ts"
import { recordVisit, updateSettings } from "./admin.ts"
import { addComment, captureItem, createItem, createItemTx, linkThread, updateItem } from "./items.ts"
import { createProject, proposeStage, updateProject } from "./projects.ts"
import { archive, auditLog, findItems, inbox, itemDetail, morning, projectDetail } from "./reads.ts"
import { applyT3Snapshot } from "./sync.ts"

let t: TestDatabase

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

beforeAll(async () => {
  t = await createTestDatabase("reads")
})
afterAll(async () => {
  await t?.close()
})
beforeEach(async () => {
  await t.reset()
})

async function source(projectId: string, critical: number, high: number, asOf: Date | null, coverage = "enabled") {
  await t.ctx.db.insert(securitySources).values({
    projectId,
    family: "dependabot",
    coverage: coverage as "enabled",
    critical,
    high,
    asOf,
  })
}

describe("morning", () => {
  it("uses the owner's previous visit in any browser as since, or 24 hours ago when there is none", async () => {
    const first = await morning(t.ctx)
    expect(t.ctx.clock().getTime() - first.since.getTime()).toBeGreaterThanOrEqual(DAY - 1000)
    const visit = await recordVisit(t.ctx)
    t.clock.travel(1000)
    expect((await morning(t.ctx)).since.getTime()).toBe(visit.getTime())
    // The latest visit counts, whichever browser recorded it.
    t.clock.travel(HOUR)
    const later = await recordVisit(t.ctx)
    t.clock.travel(1000)
    expect((await morning(t.ctx)).since.getTime()).toBe(later.getTime())
  })

  it("shows a write as new on the next visit when its transaction was open across the read and the visit", async () => {
    const titles = (view: Awaited<ReturnType<typeof morning>>) => view.new.map((n) => n.item.title)
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let written = () => {}
    const inside = new Promise<void>((resolve) => {
      written = resolve
    })
    // The item's time is taken inside its transaction, which commits only after the visit.
    const writing = t.ctx.db.transaction(async (tx) => {
      await createItemTx(t.ctx, tx, agent, { type: "task", title: "Slow write" })
      written()
      await held
    })
    await inside
    t.clock.travel(5_000)
    const shown = await morning(t.ctx)
    expect(titles(shown)).not.toContain("Slow write")
    await recordVisit(t.ctx, shown.now)
    release()
    await writing
    t.clock.travel(5_000)
    expect(titles(await morning(t.ctx))).toContain("Slow write")
  })

  it("lists waiting items and open stage proposals under waiting", async () => {
    const p = await createProject(t.ctx, owner, { name: "Kite" })
    const item = await createItem(t.ctx, agent, { projectId: p.id, type: "decision", title: "Pick a name" })
    await updateItem(t.ctx, agent, item.id, 1, { status: "waiting_on_you" })
    await proposeStage(t.ctx, agent, p.id, { stage: "poc", reason: "Demo works" })
    const view = await morning(t.ctx)
    expect(view.waiting.map((w) => w.kind).sort()).toEqual(["item", "stage_proposal"])
    const proposal = view.waiting.find((w) => w.kind === "stage_proposal")
    expect(proposal).toMatchObject({ proposal: { projectName: "Kite", proposedStage: "poc", currentStage: null } })
  })

  it("shows new and changed items since the last visit, but not items imported by the first sync", async () => {
    await applyT3Snapshot(t.ctx, {
      collectedAt: t.ctx.clock(),
      projects: [{ t3ProjectId: "t3-kite", title: "Kite" }],
      threads: [
        {
          threadId: "imported",
          t3ProjectId: "t3-kite",
          title: "Imported work",
          status: "running",
          settled: false,
          updatedAt: t.ctx.clock(),
        },
      ],
    })
    const created = await createItem(t.ctx, agent, { type: "task", title: "Fresh" })
    const view = await morning(t.ctx)
    expect(view.new.map((n) => [n.change, n.item.title])).toEqual([["created", "Fresh"]])

    // A later change to the imported item does show.
    const [imported] = await t.ctx.db.select().from(items).where(eq(items.imported, true))
    t.clock.travel(1000)
    await updateItem(t.ctx, agent, imported?.id ?? "", 1, { status: "waiting_on_you" })
    const after = await morning(t.ctx)
    expect(after.new.map((n) => [n.change, n.item.title]).sort()).toEqual([
      ["created", "Fresh"],
      ["updated", "Imported work"],
    ])
    expect(created.imported).toBe(false)
  })

  it("counts critical findings everywhere and high ones only at stage production, with freshness", async () => {
    const prod = await createProject(t.ctx, owner, { name: "Prod", stage: "production" })
    const dev = await createProject(t.ctx, owner, { name: "Dev", stage: "development" })
    const quiet = await createProject(t.ctx, owner, { name: "Quiet", stage: "development" })
    const off = await createProject(t.ctx, owner, { name: "Off", stage: "production" })
    await source(prod.id, 0, 3, new Date(t.ctx.clock().getTime() - HOUR))
    await source(dev.id, 1, 5, new Date(t.ctx.clock().getTime() - 27 * HOUR))
    await source(quiet.id, 0, 9, new Date(t.ctx.clock().getTime() - HOUR))
    await source(off.id, 4, 4, null, "not_enabled")
    await createItem(t.ctx, agent, {
      projectId: prod.id,
      type: "security",
      title: "Audit finding",
      severity: "critical",
    })

    const lines = (await morning(t.ctx)).security
    expect(lines.map((l) => [l.projectName, l.critical, l.high, l.stale])).toEqual([
      ["Prod", 1, 3, false],
      ["Dev", 1, 0, true],
    ])
    expect(lines.find((l) => l.projectName === "Prod")).toMatchObject({
      alerts: { critical: 0, high: 3 },
      items: { critical: 1, high: 0 },
    })
  })

  it("groups agent comments and status changes by project, and leaves out the owner's", async () => {
    const p = await createProject(t.ctx, owner, { name: "Kite" })
    const item = await createItem(t.ctx, agent, { projectId: p.id, type: "task", title: "Build" })
    await addComment(t.ctx, agent, item.id, { text: "Built the parser." })
    await updateItem(t.ctx, agent, item.id, 1, { status: "in_progress" })
    await updateItem(t.ctx, owner, item.id, 2, { status: "todo" })
    await addComment(t.ctx, owner, item.id, { text: "Owner note" })
    const updates = (await morning(t.ctx)).agentUpdates
    expect(updates).toHaveLength(1)
    expect(updates[0]?.projectName).toBe("Kite")
    expect(
      updates[0]?.updates
        .map((u) => (u.kind === "status" ? `${u.from}->${u.to}` : u.kind === "comment" ? u.text : u.noteTitle))
        .sort(),
    ).toEqual(["Built the parser.", "todo->in_progress"])
  })

  it("lists projects with open items with goal progress, and the inbox count", async () => {
    const busy = await createProject(t.ctx, owner, { name: "Busy", githubRepo: "example/busy" })
    await createProject(t.ctx, owner, { name: "Idle" })
    await updateProject(t.ctx, agent, busy.id, { whereWeAre: "Halfway", goal: "Beta" })
    const detail = await projectDetail(t.ctx, busy.id)
    await createItem(t.ctx, agent, { projectId: busy.id, type: "task", title: "Open", goalId: detail.goal?.id })
    await captureItem(t.ctx, agent, { text: "An idea" })
    const view = await morning(t.ctx)
    expect(view.projects).toEqual([
      expect.objectContaining({
        name: "Busy",
        whereWeAre: "Halfway",
        repo: "example/busy",
        openItems: 1,
        goal: expect.objectContaining({ text: "Beta", done: 0, total: 1 }),
      }),
    ])
    expect(view.inboxCount).toBe(1)
    expect((await inbox(t.ctx)).map((i) => i.title)).toEqual(["An idea"])
  })

  it("leaves closed items out after the closed-item days and keeps them in the archive", async () => {
    await updateSettings(t.ctx, owner, { closedItemDays: 2 })
    const old = await createItem(t.ctx, agent, { type: "task", title: "Old" })
    await updateItem(t.ctx, agent, old.id, 1, { status: "done" })
    t.clock.travel(3 * DAY)
    const recent = await createItem(t.ctx, agent, { type: "task", title: "Recent" })
    await updateItem(t.ctx, agent, recent.id, 1, { status: "not_relevant" })
    const view = await morning(t.ctx)
    expect(view.new.map((n) => n.item.title)).toEqual(["Recent"])

    const first = await archive(t.ctx, { limit: 1 })
    expect(first.data.map((i) => i.title)).toEqual(["Recent"])
    expect(first.nextCursor).not.toBeNull()
    const second = await archive(t.ctx, { limit: 1, cursor: first.nextCursor ?? "" })
    expect(second).toMatchObject({ data: [expect.objectContaining({ title: "Old" })], nextCursor: null })
    await expect(archive(t.ctx, { cursor: "not-a-cursor" })).rejects.toMatchObject({ code: "validation_failed" })
  })

  it("reports the last successful sync and whether it is stale", async () => {
    expect((await morning(t.ctx)).sync).toMatchObject({ lastSuccessAt: null, stale: true })
    await applyT3Snapshot(t.ctx, { collectedAt: t.ctx.clock(), projects: [], threads: [] })
    expect((await morning(t.ctx)).sync.stale).toBe(false)
    t.clock.travel(27 * HOUR)
    expect((await morning(t.ctx)).sync.stale).toBe(true)
  })

  it("takes freshness from the last complete sync and shows a later partial one as such", async () => {
    await applyT3Snapshot(t.ctx, { collectedAt: t.ctx.clock(), projects: [], threads: [] })
    t.clock.travel(27 * HOUR)
    await applyT3Snapshot(t.ctx, { collectedAt: t.ctx.clock(), projects: [], threads: [], failedProjects: ["t3-a"] })
    const [complete, partial] = await t.ctx.db.select().from(syncRuns).orderBy(syncRuns.startedAt)
    expect(partial?.outcome).toBe("partial")
    const sync = (await morning(t.ctx)).sync
    expect(sync).toMatchObject({ lastSuccessAt: complete?.finishedAt, stale: true, lastPartialAt: partial?.finishedAt })
  })
})

describe("other read models", () => {
  it("returns an item with its threads, comments and history", async () => {
    const item = await createItem(t.ctx, agent, { type: "task", title: "Detail" })
    await addComment(t.ctx, agent, item.id, { text: "Note" })
    const detail = await itemDetail(t.ctx, item.id)
    expect(detail.comments.map((c) => c.text)).toEqual(["Note"])
    expect(detail.audit.map((a) => a.action)).toEqual(["comment.create", "item.create"])
    await expect(itemDetail(t.ctx, "00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({
      code: "not_found",
    })
  })

  it("finds items by text, status and thread", async () => {
    const a = await createItem(t.ctx, agent, { type: "task", title: "Parser for 100% coverage" })
    await createItem(t.ctx, agent, { type: "bug", title: "Other", status: "done" })
    await linkThread(t.ctx, agent, a.id, { threadId: "thread-find" })
    expect((await findItems(t.ctx, { threadId: "thread-find" })).map((i) => i.id)).toEqual([a.id])
    expect((await findItems(t.ctx, { q: "100%" })).map((i) => i.id)).toEqual([a.id])
    expect(await findItems(t.ctx, { q: "Other" })).toHaveLength(0)
    expect(await findItems(t.ctx, { q: "Other", includeClosed: true })).toHaveLength(1)
    expect(await findItems(t.ctx, { status: ["done"] })).toHaveLength(1)
  })

  it("pages the audit log by cursor, newest first", async () => {
    for (const title of ["One", "Two", "Three"]) await createItem(t.ctx, agent, { type: "task", title })
    const first = await auditLog(t.ctx, owner, { limit: 2 })
    expect(first.data).toHaveLength(2)
    const second = await auditLog(t.ctx, owner, { limit: 2, cursor: first.nextCursor ?? "" })
    expect(second.data).toHaveLength(1)
    expect(second.nextCursor).toBeNull()
    const ids = [...first.data, ...second.data].map((r) => r.id)
    expect(ids).toEqual([...ids].sort((x, y) => y - x))
  })
})

describe("ids in capitals", () => {
  /** Every entity id the audit stored for an entity type. */
  async function storedIds(entityType: string): Promise<string[]> {
    const rows = await t.ctx.db.select({ entityId: audit.entityId }).from(audit).where(eq(audit.entityType, entityType))
    return rows.map((row) => row.entityId ?? "")
  }

  it("records a change made through an item id in capitals under the item's own id", async () => {
    const p = await createProject(t.ctx, owner, { name: "Lantern" })
    const item = await createItem(t.ctx, agent, { projectId: p.id, type: "task", title: "Build" })
    const upper = item.id.toUpperCase()
    await updateItem(t.ctx, agent, upper, 1, { status: "waiting_on_you", body: "Changed" })
    await addComment(t.ctx, agent, upper, { text: "Through capitals." })
    await linkThread(t.ctx, agent, upper, { threadId: "thread-capitals" })

    expect(await storedIds("item")).toEqual([item.id, item.id, item.id, item.id])
    const detail = await itemDetail(t.ctx, item.id)
    expect(detail.audit.map((row) => row.action)).toEqual([
      "thread.link",
      "comment.create",
      "item.update",
      "item.create",
    ])
    const updates = (await morning(t.ctx)).agentUpdates.flatMap((group) => group.updates)
    expect(updates.filter((u) => u.kind === "status")).toEqual([
      expect.objectContaining({ itemId: item.id, from: "todo", to: "waiting_on_you" }),
    ])
  })

  it("records a change made through a project id in capitals under the project's own id", async () => {
    const p = await createProject(t.ctx, owner, { name: "Compass" })
    const upper = p.id.toUpperCase()
    await updateProject(t.ctx, agent, upper, { whereWeAre: "Parser done", goal: "First import" })
    await updateProject(t.ctx, agent, upper, { goal: "Second import" })
    await proposeStage(t.ctx, agent, upper, { stage: "poc", reason: "Runs end to end" })
    await proposeStage(t.ctx, agent, upper, { stage: "poc", reason: "Runs end to end, twice" })
    const rows = await t.ctx.db
      .select({ action: audit.action, entityId: audit.entityId })
      .from(audit)
      .where(eq(audit.entityType, "project"))
    expect(rows.filter((row) => row.entityId !== p.id)).toEqual([])
    expect(rows.map((row) => row.action).sort()).toEqual([
      "goal.close",
      "goal.create",
      "goal.create",
      "project.create",
      "project.update",
      "proposal.create",
      "proposal.update",
    ])
  })

  it("shows a row stored earlier under an id in capitals in the item's history and the morning updates", async () => {
    const item = await createItem(t.ctx, agent, { type: "task", title: "Older row" })
    const [after] = await t.ctx.db
      .update(items)
      .set({ status: "in_progress", version: 2 })
      .where(eq(items.id, item.id))
      .returning()
    await t.ctx.db.insert(audit).values({
      at: t.ctx.clock(),
      actorKind: "agent",
      actorLabel: "agent",
      action: "item.update",
      entityType: "item",
      entityId: item.id.toUpperCase(),
      before: item,
      after,
      source: "mcp",
    })
    expect((await itemDetail(t.ctx, item.id)).audit.map((row) => row.action)).toEqual(["item.update", "item.create"])
    const updates = (await morning(t.ctx)).agentUpdates.flatMap((group) => group.updates)
    expect(updates.filter((u) => u.kind === "status")).toEqual([
      expect.objectContaining({ itemId: item.id, from: "todo", to: "in_progress" }),
    ])
  })
})
