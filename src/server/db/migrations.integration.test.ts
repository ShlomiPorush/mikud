import { randomBytes } from "node:crypto"
import { fileURLToPath } from "node:url"
import { getTableName, is } from "drizzle-orm"
import { PgTable } from "drizzle-orm/pg-core"
import postgres from "postgres"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createDatabase, type Database, TRANSACTION_TIMEOUT_MS } from "./client.ts"
import * as schema from "./schema.ts"

// The migrations in drizzle/ against a real PostgreSQL. MIKUD_TEST_DATABASE_URL is a role that may create
// databases; this file makes its own and drops it at the end.
const adminUrl = process.env.MIKUD_TEST_DATABASE_URL
if (!adminUrl) throw new Error("MIKUD_TEST_DATABASE_URL is required (scripts/verify.sh sets it)")

const folder = fileURLToPath(new URL("../../../drizzle", import.meta.url))
const name = `mikud_migrations_${randomBytes(4).toString("hex")}`
const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
let database: Database
let sql: postgres.Sql

beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE "${name}"`)
  const url = new URL(adminUrl)
  url.pathname = `/${name}`
  database = createDatabase(url.toString())
  sql = postgres(url.toString(), { max: 1, onnotice: () => {} })
})

afterAll(async () => {
  await sql?.end()
  await database?.close()
  await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
  await admin.end()
})

/** Runs a statement that must fail with the given PostgreSQL error code. */
async function refused(code: string, run: () => Promise<unknown>) {
  await expect(run()).rejects.toMatchObject({ code })
}

describe("migrations", () => {
  it("apply to an empty database, and again with nothing to do", async () => {
    await database.migrate(folder)
    await database.migrate(folder)
    expect(await database.ping()).toBe(true)
  })

  it("bound every transaction of the app pool (the visit boundary relies on it)", async () => {
    const [row] = await database.db.execute<{ tx: string; idle: string }>(
      "select current_setting('transaction_timeout') as tx, current_setting('idle_in_transaction_session_timeout') as idle",
    )
    expect(row).toEqual({ tx: `${TRANSACTION_TIMEOUT_MS / 1000}s`, idle: "15s" })
  })

  it("create every table of the schema", async () => {
    const expected = Object.values(schema)
      .filter((value) => is(value, PgTable))
      .map((table) => getTableName(table as PgTable))
      .sort()
    const rows = await sql<{ table_name: string }[]>`
      select table_name from information_schema.tables where table_schema = 'public' order by table_name`
    expect(rows.map((r) => r.table_name)).toEqual(expected)
    expect(expected).toHaveLength(25)
  })

  it("enforce the unique keys the services rely on", async () => {
    const [project] =
      await sql`insert into projects (name, slug, t3_project_id) values ('Alpha', 'alpha', 't3-p1') returning id`
    await refused("23505", () => sql`insert into projects (name, slug, t3_project_id) values ('Beta', 'beta', 't3-p1')`)
    const [item] = await sql`
      insert into items (project_id, type, status, title, status_set_by, created_by)
      values (${project?.id}, 'task', 'todo', 'Write the plan', 'agent', 'agent') returning id, version`
    expect(item?.version).toBe(1)
    await sql`insert into item_threads (item_id, thread_id) values (${item?.id}, 'thread-1')`
    await refused("23505", () => sql`insert into item_threads (item_id, thread_id) values (${item?.id}, 'thread-1')`)
    await sql`insert into job_runs (job, local_date, state) values ('morning', '2026-11-01', 'sending')`
    await refused(
      "23505",
      () => sql`insert into job_runs (job, local_date, state) values ('morning', '2026-11-01', 'sent')`,
    )
    await sql`insert into telegram_updates (update_id, outcome) values (1001, 'item_created')`
    await refused("23505", () => sql`insert into telegram_updates (update_id, outcome) values (1001, 'ignored')`)
    await sql`insert into suppressions (kind, external_id) values ('thread', 'thread-9')`
    await refused("23505", () => sql`insert into suppressions (kind, external_id) values ('thread', 'thread-9')`)
    await sql`insert into suppressions (kind, external_id) values ('project', 'thread-9')`
    await sql`insert into goals (project_id, text) values (${project?.id}, 'First release')`
    await refused("23505", () => sql`insert into goals (project_id, text) values (${project?.id}, 'Second goal')`)
  })

  it("refuse codes and states the domain does not allow", async () => {
    const insertItem = (type: string, status: string, severity: string | null, closed: boolean) => sql`
      insert into items (type, status, title, severity, status_set_by, created_by, closed_at)
      values (${type}, ${status}, 'Example', ${severity}, 'owner', 'owner', ${closed ? new Date() : null})`
    await insertItem("idea", "future", null, false)
    await insertItem("security", "done", "critical", true)
    await refused("23514", () => insertItem("chore", "todo", null, false))
    await refused("23514", () => insertItem("task", "blocked", null, false))
    await refused("23514", () => insertItem("bug", "todo", "high", false))
    await refused("23514", () => insertItem("task", "done", null, false))
    await refused("23514", () => insertItem("task", "todo", null, true))
    await refused("23514", () => sql`insert into projects (name, slug, stage) values ('Gamma', 'gamma', 'launched')`)
    await refused("23514", () => sql`insert into settings (id) values (2)`)
    await sql`insert into settings default values`
  })

  it("keep items when their project is deleted, and drop a thread link with its item", async () => {
    const [project] = await sql`insert into projects (name, slug) values ('Delta', 'delta') returning id`
    const [item] = await sql`
      insert into items (project_id, type, status, title, status_set_by, created_by)
      values (${project?.id}, 'task', 'todo', 'Keep me', 'owner', 'owner') returning id`
    await refused("23001", () => sql`delete from projects where id = ${project?.id}`)
    await sql`insert into item_threads (item_id, thread_id) values (${item?.id}, 'thread-2')`
    await sql`delete from items where id = ${item?.id}`
    const links = await sql`select 1 from item_threads where thread_id = 'thread-2'`
    expect(links).toHaveLength(0)
  })

  it("keep notes when their project is deleted, and drop a note's versions with it", async () => {
    const [project] = await sql`insert into projects (name, slug) values ('Echo', 'echo') returning id`
    const [note] = await sql`
      insert into notes (project_id, title, created_by, updated_by)
      values (${project?.id}, 'Keep me', 'owner', 'owner') returning id`
    await sql`insert into note_versions (note_id, version, title, body, project_id, author_kind)
      values (${note?.id}, 1, 'Keep me', '', ${project?.id}, 'owner')`
    await refused("23001", () => sql`delete from projects where id = ${project?.id}`)
    await refused(
      "23505",
      () => sql`insert into note_versions (note_id, version, title, body, author_kind)
      values (${note?.id}, 1, 'Again', '', 'owner')`,
    )
    await refused("23514", () => sql`insert into notes (title, created_by, updated_by) values ('x', 'robot', 'owner')`)
    await sql`delete from notes where id = ${note?.id}`
    expect(await sql`select 1 from note_versions where note_id = ${note?.id}`).toHaveLength(0)
  })
})
