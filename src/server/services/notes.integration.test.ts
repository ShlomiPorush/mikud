import { eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { LIMITS } from "../../shared/api.ts"
import { audit, notes, noteVersions, projects } from "../db/schema.ts"
import { agent, bot, createTestDatabase, owner, type TestDatabase } from "../testing/db.ts"
import type { Ctx } from "./context.ts"
import {
  createNote,
  createNoteTx,
  deleteNote,
  findNotes,
  getNoteRow,
  getNoteVersion,
  listNoteVersions,
  restoreNote,
  updateNote,
} from "./notes.ts"
import { createProject, deleteProject } from "./projects.ts"

let t: TestDatabase

beforeAll(async () => {
  t = await createTestDatabase("notes")
})
afterAll(async () => {
  await t?.close()
})
beforeEach(async () => {
  await t.reset()
})

async function refused(code: string, run: () => Promise<unknown>) {
  await expect(run()).rejects.toMatchObject({ code })
}

const auditRows = (entityId: string) => t.ctx.db.select().from(audit).where(eq(audit.entityId, entityId))
const versionsOf = (noteId: string) =>
  t.ctx.db.select().from(noteVersions).where(eq(noteVersions.noteId, noteId)).orderBy(noteVersions.version)
// Assembled at run time: the guards and push protection scan literal text.
const fakeToken = () => `${"gh"}p_${"A1b2C3d4E5".repeat(4)}`

describe("writing notes", () => {
  it("creates a note with its first version and an audit row without the body", async () => {
    const note = await createNote(t.ctx, agent, { title: "  How the  sync works ", body: "It runs **daily**." })
    expect(note).toMatchObject({ title: "How the sync works", version: 1, createdBy: "agent", updatedBy: "agent" })
    const versions = await versionsOf(note.id)
    expect(versions).toHaveLength(1)
    expect(versions[0]).toMatchObject({
      version: 1,
      body: "It runs **daily**.",
      authorKind: "agent",
      restoredFrom: null,
    })
    const rows = await auditRows(note.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ action: "note.create", entityType: "note", actorKind: "agent" })
    expect(rows[0]?.after).toMatchObject({ title: "How the sync works", version: 1, bodyLength: 18 })
    expect(JSON.stringify(rows[0]?.after)).not.toContain("daily")
  })

  it("lets an agent edit the owner's note, and keeps every version", async () => {
    const note = await createNote(t.ctx, owner, { title: "Decisions", body: "One" })
    const edited = await updateNote(t.ctx, agent, note.id, 1, { body: "One\nTwo" })
    expect(edited).toMatchObject({ version: 2, createdBy: "owner", updatedBy: "agent", body: "One\nTwo" })
    expect((await versionsOf(note.id)).map((v) => [v.version, v.authorKind, v.body])).toEqual([
      [1, "owner", "One"],
      [2, "agent", "One\nTwo"],
    ])
    const rows = await auditRows(note.id)
    expect(rows.map((r) => r.action)).toEqual(["note.create", "note.update"])
    expect(rows[1]?.before).toMatchObject({ version: 1, bodyLength: 3 })
  })

  it("writes nothing for a patch that changes nothing", async () => {
    const note = await createNote(t.ctx, owner, { title: "Same", body: "Body" })
    const same = await updateNote(t.ctx, agent, note.id, 1, { title: " Same ", body: "Body", projectId: null })
    expect(same.version).toBe(1)
    expect(await versionsOf(note.id)).toHaveLength(1)
    expect(await auditRows(note.id)).toHaveLength(1)
  })

  it("refuses a stale version, and one of two parallel edits of the same version", async () => {
    const note = await createNote(t.ctx, owner, { title: "Race" })
    const results = await Promise.allSettled([
      updateNote(t.ctx, owner, note.id, 1, { body: "Owner" }),
      updateNote(t.ctx, agent, note.id, 1, { body: "Agent" }),
    ])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    const lost = results.find((r) => r.status === "rejected")
    expect(lost?.status === "rejected" && lost.reason).toMatchObject({
      code: "version_conflict",
      details: { currentVersion: 2 },
    })
    expect(await versionsOf(note.id)).toHaveLength(2)
  })

  it("refuses a secret in an agent's or the bot's text, and keeps the owner's text as written", async () => {
    await refused("secret_suspected", () => createNote(t.ctx, agent, { title: "Keys", body: fakeToken() }))
    await refused("secret_suspected", () => createNote(t.ctx, bot, { title: fakeToken() }))
    const note = await createNote(t.ctx, owner, { title: "Mine" })
    await refused("secret_suspected", () => updateNote(t.ctx, agent, note.id, 1, { body: fakeToken() }))
    expect(await t.ctx.db.select().from(notes)).toHaveLength(1)
  })

  it("refuses a body over the limit and an empty title", async () => {
    await refused("validation_failed", () =>
      createNote(t.ctx, owner, { title: "Long", body: "x".repeat(LIMITS.noteBody + 1) }),
    )
    await refused("validation_failed", () => createNote(t.ctx, owner, { title: "   " }))
    const note = await createNote(t.ctx, owner, { title: "Fits", body: "x".repeat(LIMITS.noteBody) })
    await refused("validation_failed", () =>
      updateNote(t.ctx, owner, note.id, 1, { body: "x".repeat(LIMITS.noteBody + 1) }),
    )
  })

  it("moves a note between projects and refuses a project that does not exist", async () => {
    const project = await createProject(t.ctx, owner, { name: "Lighthouse" })
    const note = await createNote(t.ctx, agent, { title: "General" })
    const moved = await updateNote(t.ctx, agent, note.id, 1, { projectId: project.id })
    expect(moved.projectId).toBe(project.id)
    await refused("not_found", () =>
      updateNote(t.ctx, agent, note.id, 2, { projectId: "00000000-0000-4000-8000-000000000000" }),
    )
  })

  it("rolls the note and its version back when the audit row cannot be written", async () => {
    const broken = { actor: { kind: "agent", label: "agent" }, source: "nowhere" } as never
    await expect(createNote(t.ctx, broken, { title: "Never stored" })).rejects.toThrow()
    expect(await t.ctx.db.select().from(notes)).toHaveLength(0)
    expect(await t.ctx.db.select().from(noteVersions)).toHaveLength(0)
  })
})

describe("restoring and deleting", () => {
  it("restores an old version as a new one, owner only", async () => {
    const note = await createNote(t.ctx, owner, { title: "Plan", body: "First" })
    await updateNote(t.ctx, agent, note.id, 1, { title: "Plan B", body: "Second" })
    await refused("forbidden", () => restoreNote(t.ctx, agent, note.id, { expectedVersion: 2, fromVersion: 1 }))
    const restored = await restoreNote(t.ctx, owner, note.id, { expectedVersion: 2, fromVersion: 1 })
    expect(restored).toMatchObject({ version: 3, title: "Plan", body: "First", updatedBy: "owner" })
    const versions = await versionsOf(note.id)
    expect(versions[2]).toMatchObject({ version: 3, restoredFrom: 1, authorKind: "owner" })
    const rows = await auditRows(note.id)
    expect(rows.at(-1)).toMatchObject({ action: "note.restore" })
    expect(rows.at(-1)?.after).toMatchObject({ restoredFrom: 1, version: 3 })
    await refused("not_found", () => restoreNote(t.ctx, owner, note.id, { expectedVersion: 3, fromVersion: 9 }))
  })

  it("refuses a restore after an edit the owner did not see, and an edit after a restore", async () => {
    const note = await createNote(t.ctx, owner, { title: "Plan", body: "First" })
    await updateNote(t.ctx, owner, note.id, 1, { body: "Second" })
    // The owner opened version 1 while the note was at version 2; an agent then saved version 3.
    await updateNote(t.ctx, agent, note.id, 2, { body: "Third, by an agent" })
    await refused("version_conflict", () => restoreNote(t.ctx, owner, note.id, { expectedVersion: 2, fromVersion: 1 }))
    expect((await getNoteRow(t.ctx.db, note.id)).body).toBe("Third, by an agent")
    // The other order: the restore lands first and the agent's edit of the older version is refused.
    await restoreNote(t.ctx, owner, note.id, { expectedVersion: 3, fromVersion: 1 })
    await refused("version_conflict", () => updateNote(t.ctx, agent, note.id, 3, { body: "Late" }))
    expect((await getNoteRow(t.ctx.db, note.id)).body).toBe("First")
  })

  it("records a restore even when the text is already the same (R2)", async () => {
    const note = await createNote(t.ctx, owner, { title: "Plan", body: "A" })
    await updateNote(t.ctx, owner, note.id, 1, { body: "B" })
    await updateNote(t.ctx, agent, note.id, 2, { body: "A" })
    const restored = await restoreNote(t.ctx, owner, note.id, { expectedVersion: 3, fromVersion: 1 })
    expect(restored).toMatchObject({ version: 4, body: "A", updatedBy: "owner" })
    expect((await versionsOf(note.id)).at(-1)).toMatchObject({ version: 4, restoredFrom: 1, authorKind: "owner" })
    expect((await auditRows(note.id)).at(-1)).toMatchObject({ action: "note.restore", actorKind: "owner" })
  })

  it("lets one of a parallel restore and edit win", async () => {
    const note = await createNote(t.ctx, owner, { title: "Plan", body: "First" })
    await updateNote(t.ctx, owner, note.id, 1, { body: "Second" })
    const results = await Promise.allSettled([
      restoreNote(t.ctx, owner, note.id, { expectedVersion: 2, fromVersion: 1 }),
      updateNote(t.ctx, agent, note.id, 2, { body: "Agent" }),
    ])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    expect(await versionsOf(note.id)).toHaveLength(3)
  })

  it("deletes a note with its versions only for the owner and only at the version he saw", async () => {
    const note = await createNote(t.ctx, owner, { title: "Old" })
    await updateNote(t.ctx, agent, note.id, 1, { body: "Agent added this" })
    await refused("forbidden", () => deleteNote(t.ctx, agent, note.id, 2))
    await refused("forbidden", () => deleteNote(t.ctx, bot, note.id, 2))
    await refused("version_conflict", () => deleteNote(t.ctx, owner, note.id, 1))
    await deleteNote(t.ctx, owner, note.id, 2)
    expect(await t.ctx.db.select().from(notes)).toHaveLength(0)
    expect(await t.ctx.db.select().from(noteVersions)).toHaveLength(0)
    const rows = await auditRows(note.id)
    expect(rows.at(-1)).toMatchObject({ action: "note.delete", actorKind: "owner" })
    expect(rows.at(-1)?.before).toMatchObject({ title: "Old", version: 2 })
  })
})

describe("notes and project deletes", () => {
  it("refuses to delete a project that has notes, and allows it once they moved", async () => {
    const project = await createProject(t.ctx, owner, { name: "Harbor" })
    const note = await createNote(t.ctx, owner, { title: "Harbor notes", projectId: project.id })
    await expect(deleteProject(t.ctx, owner, project.id)).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining("notes"),
    })
    await updateNote(t.ctx, owner, note.id, 1, { projectId: null })
    await deleteProject(t.ctx, owner, project.id)
    // History keeps the deleted project's id; restoring that version is refused.
    expect((await versionsOf(note.id))[0]?.projectId).toBe(project.id)
    await expect(restoreNote(t.ctx, owner, note.id, { expectedVersion: 2, fromVersion: 1 })).rejects.toMatchObject({
      code: "conflict",
      details: { fromVersion: 1 },
    })
  })

  it("makes a project delete that races a note create see the note", async () => {
    const project = await createProject(t.ctx, owner, { name: "Race" })
    let created!: () => void
    const noteWritten = new Promise<void>((resolve) => {
      created = resolve
    })
    let release!: () => void
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const writing = t.ctx.db.transaction(async (tx) => {
      await createNoteTx(t.ctx, tx, owner, { title: "Racing", projectId: project.id })
      created()
      await hold
    })
    await noteWritten
    const deleting = deleteProject(t.ctx, owner, project.id)
    await new Promise((resolve) => setTimeout(resolve, 200))
    release()
    await writing
    await expect(deleting).rejects.toMatchObject({ code: "conflict" })
    expect(await t.ctx.db.select().from(projects)).toHaveLength(1)
  })

  it("makes a note create that races a project delete fail with not_found", async () => {
    const project = await createProject(t.ctx, owner, { name: "Gone" })
    let locked!: () => void
    const projectLocked = new Promise<void>((resolve) => {
      locked = resolve
    })
    let release!: () => void
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const deleting = t.ctx.db.transaction(async (tx) => {
      await tx.select().from(projects).where(eq(projects.id, project.id)).for("update")
      locked()
      await hold
      await tx.delete(projects).where(eq(projects.id, project.id))
    })
    await projectLocked
    const creating = createNote(t.ctx, agent, { title: "Too late", projectId: project.id })
    await new Promise((resolve) => setTimeout(resolve, 200))
    release()
    await deleting
    await expect(creating).rejects.toMatchObject({ code: "not_found" })
    expect(await t.ctx.db.select().from(notes)).toHaveLength(0)
  })
})

describe("finding notes", () => {
  it("searches title and body, escaping LIKE characters", async () => {
    await createNote(t.ctx, owner, { title: "Rates", body: "Up 50% this week" })
    await createNote(t.ctx, owner, { title: "Fifty", body: "Up 50 times" })
    await createNote(t.ctx, owner, { title: "snake_case names" })
    await createNote(t.ctx, owner, { title: "snakeXcase" })
    expect((await findNotes(t.ctx, { q: "50%" })).data.map((n) => n.title)).toEqual(["Rates"])
    expect((await findNotes(t.ctx, { q: "e_c" })).data.map((n) => n.title)).toEqual(["snake_case names"])
    expect((await findNotes(t.ctx, { q: "RATES" })).data.map((n) => n.title)).toEqual(["Rates"])
  })

  it("filters by project, general notes and creator, and lists summaries without bodies", async () => {
    const project = await createProject(t.ctx, owner, { name: "Lighthouse" })
    await createNote(t.ctx, owner, { title: "In project", projectId: project.id, body: "x".repeat(1000) })
    await createNote(t.ctx, agent, { title: "General by agent" })
    const inProject = await findNotes(t.ctx, { projectId: project.id })
    expect(inProject.data.map((n) => n.title)).toEqual(["In project"])
    expect(inProject.data[0]).not.toHaveProperty("body")
    expect(inProject.data[0]?.excerpt.length).toBeLessThanOrEqual(240)
    expect((await findNotes(t.ctx, { general: true })).data.map((n) => n.title)).toEqual(["General by agent"])
    expect((await findNotes(t.ctx, { createdBy: "agent" })).data.map((n) => n.title)).toEqual(["General by agent"])
  })

  it("pages notes that share a time without skipping or repeating, in both sorts", async () => {
    const fixed = new Date("2026-11-06T10:00:00.000Z")
    const frozen: Ctx = { ...t.ctx, clock: () => fixed }
    for (const title of ["e", "a", "d", "b", "c"]) await createNote(frozen, owner, { title })
    for (const sort of ["updated", "title"] as const) {
      const seen: string[] = []
      let cursor: string | undefined
      do {
        const page = await findNotes(t.ctx, { sort, limit: 2, cursor })
        seen.push(...page.data.map((n) => n.title))
        cursor = page.nextCursor ?? undefined
      } while (cursor)
      expect([...seen].sort()).toEqual(["a", "b", "c", "d", "e"])
      if (sort === "title") expect(seen).toEqual(["a", "b", "c", "d", "e"])
    }
  })

  it("refuses a cursor from other filters or a broken one", async () => {
    for (const title of ["a", "b", "c"]) await createNote(t.ctx, owner, { title })
    const first = await findNotes(t.ctx, { limit: 1 })
    const cursor = first.nextCursor ?? ""
    expect(cursor).not.toBe("")
    await refused("validation_failed", () => findNotes(t.ctx, { limit: 1, cursor, q: "a" }))
    await refused("validation_failed", () => findNotes(t.ctx, { limit: 1, cursor, sort: "title" }))
    await refused("validation_failed", () => findNotes(t.ctx, { cursor: "not-a-cursor" }))
    await refused("validation_failed", () =>
      findNotes(t.ctx, {
        cursor: Buffer.from(JSON.stringify(["x", "'; drop table notes; --", "h"])).toString("base64url"),
      }),
    )
  })
})

describe("versions", () => {
  it("lists versions newest first without bodies, paged, and reads one with its body", async () => {
    const note = await createNote(t.ctx, owner, { title: "History", body: "v1" })
    for (let v = 1; v < 5; v++) await updateNote(t.ctx, agent, note.id, v, { body: `v${v + 1}` })
    const first = await listNoteVersions(t.ctx, note.id, { limit: 3 })
    expect(first.data.map((v) => v.version)).toEqual([5, 4, 3])
    expect(first.data[0]).not.toHaveProperty("body")
    expect(first.data[0]).toMatchObject({ authorKind: "agent", bodyLength: 2 })
    const second = await listNoteVersions(t.ctx, note.id, { limit: 3, cursor: first.nextCursor ?? undefined })
    expect(second.data.map((v) => v.version)).toEqual([2, 1])
    expect(second.nextCursor).toBeNull()
    expect((await getNoteVersion(t.ctx, note.id, 2)).body).toBe("v2")
    await refused("not_found", () => getNoteVersion(t.ctx, note.id, 6))
    await refused("not_found", () => listNoteVersions(t.ctx, "00000000-0000-4000-8000-000000000000"))
  })
})
