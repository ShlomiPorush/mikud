// The activity filters on PostgreSQL (docs/api.md, Audit filters): every count is the rows that choosing its value
// lists, paged to the end (v3 TB-18); a kind choice replaces the agent, so the kinds ignore both (R1); a project
// covers the items in it now; a cursor pages only the filters it came from, and a cursor written before the
// filters still pages the entity filters (R2); the search matches the stored fields literally and the labels of
// the request's language, in English and in Hebrew. Rows of settings and suppressions show a reader other than the
// owner only the names of the fields that changed, and its search does not match their hidden names. The data is
// invented.

import { desc, eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { ACTOR_KINDS } from "../../shared/enums.ts"
import he from "../../shared/locales/he.json"
import { audit, items } from "../db/schema.ts"
import { createTestDatabase, owner, type TestDatabase } from "../testing/db.ts"
import { listSuppressions, removeSuppression, updateSettings } from "./admin.ts"
import { type By, SYSTEM } from "./context.ts"
import { addComment, captureItem, createItem, deleteItem, linkThread, updateItem } from "./items.ts"
import { createProject, updateProject } from "./projects.ts"
import { type AuditLogOptions, auditLog } from "./reads.ts"

let t: TestDatabase

/** "Changed": the first word of the Hebrew label of settings.update, which three more labels share. */
const CHANGED_HE = he.audit.action.settings_update.split(" ")[0] ?? ""

const codex: By = { actor: { kind: "agent", label: "agent:codex" }, source: "mcp" }
const claude: By = { actor: { kind: "agent", label: "agent:claude" }, source: "api" }
const sync: By = { actor: { kind: "sync", label: "sync" }, source: "sync" }
const bot: By = { actor: { kind: "bot", label: "bot" }, source: "telegram" }

beforeAll(async () => {
  t = await createTestDatabase("audit")
})
afterAll(async () => {
  await t?.close()
})
beforeEach(async () => {
  await t.reset()
})

async function version(id: string): Promise<number> {
  const [row] = await t.ctx.db.select({ version: items.version }).from(items).where(eq(items.id, id))
  if (!row) throw new Error("no item")
  return row.version
}

/** A garden of changes by every kind of actor, with an item that moves from one project to another. */
async function seed() {
  const lantern = await createProject(t.ctx, owner, { name: "Lantern" })
  const moss = await createProject(t.ctx, owner, { name: "Moss garden" })
  await createProject(t.ctx, sync, { name: "Tidepool" })
  const trellis = await createItem(t.ctx, owner, { type: "task", title: "Build the trellis", projectId: lantern.id })
  const hose = await createItem(t.ctx, codex, { type: "task", title: "Coil the hose", projectId: lantern.id })
  const seeds = await createItem(t.ctx, claude, { type: "idea", title: "50% off seeds", projectId: moss.id })
  await updateItem(t.ctx, codex, trellis.id, await version(trellis.id), { status: "in_progress" })
  await addComment(t.ctx, claude, trellis.id, { text: "The posts are in." })
  await linkThread(t.ctx, codex, hose.id, { threadId: "t-hose" })
  await updateProject(t.ctx, owner, moss.id, { whereWeAre: "Planting" })
  await captureItem(t.ctx, bot, { text: "Buy twine" })
  await updateSettings(t.ctx, owner, { closedItemDays: 10 })
  // The hose moves to the moss garden: its rows belong to that project now.
  await updateItem(t.ctx, owner, hose.id, await version(hose.id), { projectId: moss.id })
  return { lantern, moss, trellis, hose, seeds }
}

/** Every row the filters list, page by page through the cursor. */
async function pageAll(options: AuditLogOptions, reader: By = owner) {
  const rows: Awaited<ReturnType<typeof auditLog>>["data"] = []
  let cursor: string | undefined
  for (let pages = 0; pages < 100; pages += 1) {
    const page = await auditLog(t.ctx, reader, { ...options, limit: 2, cursor })
    if (cursor) expect(page.total, "only the first page counts").toBeUndefined()
    rows.push(...page.data)
    if (!page.nextCursor) break
    cursor = page.nextCursor
  }
  const ids = rows.map((row) => row.id)
  expect(new Set(ids).size, "no row twice").toBe(ids.length)
  expect(ids).toEqual([...ids].sort((a, b) => b - a))
  return rows
}

/** Each count of the first page is what choosing its value lists, paged to the end. */
async function expectCountsMatch(base: AuditLogOptions, reader: By = owner) {
  const first = await auditLog(t.ctx, reader, base)
  const counts = first.counts
  if (!counts) throw new Error("no counts on the first page")
  expect(first.total).toBe((await pageAll(base, reader)).length)
  // A kind choice clears the agent: the kinds ignore both (R1).
  for (const kind of ACTOR_KINDS)
    expect((await pageAll({ ...base, agent: undefined, actorKind: kind }, reader)).length, kind).toBe(
      counts.actorKind[kind],
    )
  for (const { label, count } of counts.agents)
    expect((await pageAll({ ...base, agent: label }, reader)).length, label).toBe(count)
  for (const { action, count } of counts.actions)
    expect((await pageAll({ ...base, action }, reader)).length, action).toBe(count)
  for (const { projectId, count } of counts.projects)
    expect((await pageAll({ ...base, projectId }, reader)).length, projectId).toBe(count)
  return counts
}

describe("activity counts", () => {
  it("match the list across pages, for every value of every facet, with and without other filters", async () => {
    const { moss } = await seed()
    const all = await expectCountsMatch({})
    expect(all.actorKind).toMatchObject({ owner: expect.any(Number), agent: expect.any(Number), bot: 1, sync: 1 })
    expect(all.agents.map((agent) => agent.label).sort()).toEqual(["agent:claude", "agent:codex"])
    await expectCountsMatch({ projectId: moss.id })
    await expectCountsMatch({ actorKind: "agent" })
    await expectCountsMatch({ agent: "agent:codex" })
    await expectCountsMatch({ q: "the", lang: "en" })
    await expectCountsMatch({ q: CHANGED_HE, lang: "he", actorKind: "owner" })
  })

  it("counts Who without the agent filter, because a kind choice replaces it (R1)", async () => {
    await seed()
    const plain = await auditLog(t.ctx, owner, {})
    const withAgent = await auditLog(t.ctx, owner, { agent: "agent:codex" })
    expect(withAgent.counts?.actorKind).toEqual(plain.counts?.actorKind)
    expect(withAgent.counts?.actorKind.owner).toBeGreaterThan(0)
    // The agents facet ignores the agent alone.
    expect(withAgent.counts?.agents).toEqual(plain.counts?.agents)
    expect(withAgent.total).toBe(plain.counts?.agents.find((agent) => agent.label === "agent:codex")?.count)
  })

  it("lists a project's own rows and the rows of the items in it now", async () => {
    const { lantern, moss, trellis, hose } = await seed()
    const lanternRows = await pageAll({ projectId: lantern.id })
    expect(lanternRows.some((row) => row.entityType === "project" && row.entityId === lantern.id)).toBe(true)
    expect(
      lanternRows
        .filter((row) => row.entityId === trellis.id)
        .map((row) => row.action)
        .sort(),
    ).toEqual(["comment.create", "item.create", "item.update"])
    expect(
      lanternRows.some((row) => row.entityId === hose.id),
      "the hose moved out",
    ).toBe(false)
    const mossRows = await pageAll({ projectId: moss.id.toUpperCase() })
    expect(
      mossRows
        .filter((row) => row.entityId === hose.id)
        .map((row) => row.action)
        .sort(),
    ).toEqual(["item.create", "item.update", "thread.link"])
  })

  it("lists rows written for an id in capitals, as an address may name it, under the item and its project", async () => {
    const { lantern, trellis } = await seed()
    // PATCH /items/<ID IN CAPITALS> is a valid request; its audit row holds the item's own id, in lower case.
    await updateItem(t.ctx, owner, trellis.id.toUpperCase(), await version(trellis.id), { status: "done" })
    const [written] = await t.ctx.db.select({ entityId: audit.entityId }).from(audit).orderBy(desc(audit.id)).limit(1)
    expect(written?.entityId).toBe(trellis.id)
    // A row written before that kept the id as the request named it.
    await t.ctx.db.insert(audit).values({
      at: t.ctx.clock(),
      actorKind: "owner",
      actorLabel: "owner",
      action: "item.update",
      entityType: "item",
      entityId: trellis.id.toUpperCase(),
      source: "ui",
    })
    const done = (row: { action: string; entityId: string | null; after?: unknown }) =>
      row.action === "item.update" && row.entityId === trellis.id.toUpperCase()
    expect((await pageAll({ itemId: trellis.id })).some(done), "under the item").toBe(true)
    expect((await pageAll({ projectId: lantern.id })).some(done), "under its project").toBe(true)
    // The project's count holds it too.
    const counts = await expectCountsMatch({})
    const lanternCount = counts.projects.find((entry) => entry.projectId === lantern.id)?.count
    expect(lanternCount).toBe((await pageAll({ projectId: lantern.id })).length)
    expect(counts.projects.some((entry) => entry.projectId === lantern.id.toUpperCase())).toBe(false)
  })

  it("matches an entity id that is a UUID in any case, and any other entity id exactly", async () => {
    const { trellis } = await seed()
    await t.ctx.db.insert(audit).values({
      at: t.ctx.clock(),
      actorKind: "owner",
      actorLabel: "owner",
      action: "item.update",
      entityType: "item",
      entityId: trellis.id.toUpperCase(),
      source: "ui",
    })
    const lower = await pageAll({ entityType: "item", entityId: trellis.id })
    expect(lower.map((row) => row.action)).toEqual(["item.update", "comment.create", "item.update", "item.create"])
    expect(await pageAll({ entityType: "item", entityId: trellis.id.toUpperCase() })).toEqual(lower)
    const first = await auditLog(t.ctx, owner, { entityType: "item", entityId: trellis.id.toUpperCase() })
    expect(first.total).toBe(lower.length)
    // The settings row's id is not a UUID: it matches as written.
    expect((await pageAll({ entityType: "settings", entityId: "1" })).map((row) => row.action)).toEqual([
      "settings.update",
    ])
  })

  it("lists an item's rows, its comments and threads included", async () => {
    const { trellis, hose } = await seed()
    expect((await pageAll({ itemId: trellis.id })).map((row) => row.action)).toEqual([
      "comment.create",
      "item.update",
      "item.create",
    ])
    expect((await pageAll({ itemId: hose.id })).map((row) => row.action)).toContain("thread.link")
  })
})

describe("activity cursor", () => {
  const bare = (id: number) => Buffer.from(JSON.stringify([id])).toString("base64url")

  it("pages only the filters it came from; another filter starts again from the first page", async () => {
    await seed()
    const first = await auditLog(t.ctx, owner, { actorKind: "owner", limit: 2 })
    expect(first.nextCursor).toBeTruthy()
    const cursor = first.nextCursor ?? ""
    await expect(auditLog(t.ctx, owner, { actorKind: "owner", cursor, limit: 2 })).resolves.toMatchObject({
      data: expect.any(Array),
    })
    await expect(auditLog(t.ctx, owner, { actorKind: "agent", cursor, limit: 2 })).rejects.toMatchObject({
      code: "validation_failed",
    })
    await expect(auditLog(t.ctx, owner, { actorKind: "owner", q: "trellis", cursor })).rejects.toMatchObject({
      code: "validation_failed",
    })
    await expect(auditLog(t.ctx, owner, { cursor })).rejects.toMatchObject({ code: "validation_failed" })
  })

  it("writes the old cursor without filters, and keeps the entity filters paging with old and new cursors (R2)", async () => {
    const { trellis } = await seed()
    const plain = await auditLog(t.ctx, owner, { limit: 1 })
    const top = plain.data[0]?.id ?? 0
    expect(plain.nextCursor).toBe(bare(top))

    const expected = (await t.ctx.db.select().from(audit).where(eq(audit.entityId, trellis.id))).length
    expect((await pageAll({ entityType: "item", entityId: trellis.id })).length).toBe(expected)
    // A cursor from before the filters still pages them.
    const old = await auditLog(t.ctx, owner, {
      entityType: "item",
      entityId: trellis.id,
      cursor: bare(top + 1),
      limit: 50,
    })
    expect(old.data).toHaveLength(expected)
    // Not the new filters: it cannot say which list it came from.
    await expect(auditLog(t.ctx, owner, { actorKind: "owner", cursor: bare(top + 1) })).rejects.toMatchObject({
      code: "validation_failed",
    })
    // A new cursor names its entity filters too.
    const first = await auditLog(t.ctx, owner, { entityType: "item", entityId: trellis.id, limit: 1 })
    await expect(
      auditLog(t.ctx, owner, { entityType: "item", entityId: "another", cursor: first.nextCursor ?? "" }),
    ).rejects.toMatchObject({ code: "validation_failed" })
    await expect(auditLog(t.ctx, owner, { cursor: "not a cursor" })).rejects.toMatchObject({
      code: "validation_failed",
    })
  })
})

describe("activity search", () => {
  const actions = async (options: AuditLogOptions) => [...new Set((await pageAll(options)).map((row) => row.action))]

  it("matches the stored fields, case-insensitive, with wildcards taken literally", async () => {
    const { seeds } = await seed()
    expect((await pageAll({ q: "TRELLIS" })).map((row) => row.action)).toEqual(
      (await pageAll({ q: "trellis" })).map((row) => row.action),
    )
    expect(await pageAll({ q: "trellis" })).not.toHaveLength(0)
    const byCodex = await pageAll({ q: "codex" })
    expect(byCodex.length).toBeGreaterThan(0)
    expect(byCodex.every((row) => row.actorLabel === "agent:codex")).toBe(true)
    expect(await actions({ q: "item.upd" })).toEqual(["item.update"])
    const percent = await pageAll({ q: "%" })
    expect(percent.length).toBeGreaterThan(0)
    expect(percent.every((row) => row.entityId === seeds.id)).toBe(true)
    expect(await pageAll({ q: "_" })).toHaveLength(0)
  })

  it("matches the action labels of the request's language: English", async () => {
    await seed()
    expect((await actions({ q: "changed the", lang: "en" })).sort()).toEqual(["item.update", "project.update"])
    expect(await pageAll({ q: "changed the" }), "without a language, stored fields only").toHaveLength(0)
  })

  it("matches the action and entity labels of the request's language: Hebrew", async () => {
    await seed()
    expect((await actions({ q: CHANGED_HE, lang: "he" })).sort()).toEqual([
      "item.update",
      "project.update",
      "settings.update",
    ])
    const created = await pageAll({ q: he.audit.action.item_create, lang: "he" })
    const all = await auditLog(t.ctx, owner, {})
    expect(created.length).toBe(all.counts?.actions.find((entry) => entry.action === "item.create")?.count)
    expect(created.every((row) => row.action === "item.create")).toBe(true)
    expect(await pageAll({ q: CHANGED_HE, lang: "en" }), "Hebrew text, English labels").toHaveLength(0)
    const projectRows = await pageAll({ q: he.audit.entity.project, lang: "he" })
    expect(projectRows.length).toBeGreaterThan(0)
    expect(projectRows.every((row) => row.entityType === "project")).toBe(true)
    expect(projectRows.length).toBe((await pageAll({ entityType: "project" })).length)
  })
})

describe("rows only the owner may read", () => {
  const HIDDEN = /lantern-internal|424242|t-shed-hidden|Shed key/
  const ownerOnly = (rows: Awaited<ReturnType<typeof pageAll>>) =>
    rows.filter((row) => row.entityType === "settings" || row.entityType === "suppression")

  /** The garden, then private settings and a suppression created and removed. */
  async function seedOwnerOnly() {
    await seed()
    await updateSettings(t.ctx, owner, { privateDomains: ["lantern-internal.example"], telegramChatId: "424242" })
    const shed = await createItem(t.ctx, owner, { type: "task", title: "Shed key" })
    await linkThread(t.ctx, owner, shed.id, { threadId: "t-shed-hidden" })
    await deleteItem(t.ctx, owner, shed.id)
    const [suppression] = await listSuppressions(t.ctx, owner)
    if (!suppression) throw new Error("no suppression")
    await removeSuppression(t.ctx, owner, suppression.id)
  }

  it("show any other reader only the names of the fields that changed, on the first page and the next", async () => {
    await seedOwnerOnly()
    for (const reader of [codex, sync, bot, SYSTEM]) {
      const rows = ownerOnly(await pageAll({}, reader))
      expect(rows.map((row) => row.action)).toEqual([
        "suppression.delete",
        "suppression.create",
        "settings.update",
        "settings.update",
      ])
      for (const row of rows) {
        expect([row.action, row.before, row.after]).toEqual([row.action, null, null])
        expect(row.redactedFields?.length, row.action).toBeGreaterThan(0)
      }
      expect(JSON.stringify(rows), reader.actor.kind).not.toMatch(HIDDEN)
    }
    const [latest] = await pageAll({ action: "settings.update" }, codex)
    expect(latest?.redactedFields).toEqual(expect.arrayContaining(["privateDomains", "telegramChatId"]))
    expect(latest?.redactedFields).not.toContain("closedItemDays")
    const [created] = await pageAll({ action: "suppression.create" }, codex)
    expect(created?.redactedFields).toEqual(["createdAt", "externalId", "id", "kind", "label"])
  })

  it("stay redacted when an agent asks for the owner's changes", async () => {
    await seedOwnerOnly()
    const rows = ownerOnly(await pageAll({ actorKind: "owner" }, codex))
    expect(rows).toHaveLength(4)
    expect(rows.every((row) => row.before === null && row.after === null)).toBe(true)
  })

  it("stay whole for the owner", async () => {
    await seedOwnerOnly()
    const [latest] = await pageAll({ action: "settings.update" })
    expect(latest?.after).toMatchObject({ privateDomains: ["lantern-internal.example"], telegramChatId: "424242" })
    expect(latest).not.toHaveProperty("redactedFields")
    const [created] = await pageAll({ action: "suppression.create" })
    expect(created?.after).toMatchObject({ kind: "thread", externalId: "t-shed-hidden", label: "Shed key" })
  })

  it("count the same rows for the owner and any other reader", async () => {
    await seedOwnerOnly()
    expect(await expectCountsMatch({}, codex)).toEqual(await expectCountsMatch({}))
    expect(await expectCountsMatch({ entityType: "suppression" }, codex)).toEqual(
      await expectCountsMatch({ entityType: "suppression" }),
    )
  })

  it("match a suppression's hidden label in the owner's search only, and count what each search lists", async () => {
    await seedOwnerOnly()
    expect(await pageAll({ q: "shed key", entityType: "suppression" })).toHaveLength(2)
    expect(await pageAll({ q: "shed key", entityType: "suppression" }, codex)).toHaveLength(0)
    // The item's own rows still match its title for every reader.
    const forAgent = await pageAll({ q: "shed key" }, codex)
    expect(forAgent.length).toBeGreaterThan(0)
    expect(ownerOnly(forAgent)).toHaveLength(0)
    expect((await pageAll({ q: "shed key" })).length).toBe(forAgent.length + 2)
    await expectCountsMatch({ q: "shed key" }, codex)
    await expectCountsMatch({ q: "shed key" })
  })
})
