import type { AddressInfo } from "node:net"
import { type ServerType, serve } from "@hono/node-server"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createApp } from "../app.ts"
import { RateLimiter } from "../http/auth.ts"
import { createProject } from "../services/projects.ts"
import { createAgentKey, ownerBrowser, type TestCore, testCore } from "../testing/app.ts"
import { createTestDatabase, owner, type TestDatabase } from "../testing/db.ts"

let t: TestDatabase
let core: TestCore
let app: ReturnType<typeof createApp>
/** An agent key of the owner, created before each test. */
let AGENT: string
let server: ServerType
let base: string

beforeAll(async () => {
  t = await createTestDatabase("mcp")
  core = testCore(t, {
    config: { publicUrl: new URL("http://127.0.0.1:8090"), version: "test" },
    limiter: new RateLimiter(),
  })
  app = createApp({ checkDatabase: async () => true, core })
  server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" })
  await new Promise<void>((resolve) => server.once("listening", () => resolve()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()))
  await t?.close()
})
beforeEach(async () => {
  await t.reset()
  await ownerBrowser(t, app)
  AGENT = await createAgentKey(core)
})

async function connect(token: string) {
  const client = new Client({ name: "mikud-test", version: "1.0.0" })
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  })
  await client.connect(transport)
  return client
}

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] }

async function callTool(client: Client, name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: args })) as ToolResult
  const text = result.content[0]?.text ?? "null"
  // biome-ignore lint/suspicious/noExplicitAny: tool answers are JSON whose shape each test asserts
  type Json = any
  return { isError: Boolean(result.isError), body: JSON.parse(text) as { data?: Json; error?: Json }, text }
}

describe("MCP over Streamable HTTP", () => {
  it("lists the agent tools, none of which deletes anything", async () => {
    const client = await connect(AGENT)
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "mikud_capture",
      "mikud_comment",
      "mikud_create_item",
      "mikud_create_note",
      "mikud_find_items",
      "mikud_find_notes",
      "mikud_get_item",
      "mikud_get_note",
      "mikud_link_thread",
      "mikud_list_projects",
      "mikud_propose_stage",
      "mikud_start_thread",
      "mikud_update_item",
      "mikud_update_note",
      "mikud_update_project",
    ])
    expect(tools.some((tool) => /delete|remove/i.test(tool.name))).toBe(false)
    // Only the proposal tool takes a stage.
    const withStage = tools.filter((tool) => Object.keys(tool.inputSchema.properties ?? {}).includes("stage"))
    expect(withStage.map((tool) => tool.name)).toEqual(["mikud_propose_stage"])
    expect(client.getInstructions()).toContain("waiting_on_you")
    expect(client.getInstructions()).toContain("mikud_find_notes")
    // No tool restores a version of a note either: that is the owner's.
    expect(tools.some((tool) => /restore/i.test(tool.name))).toBe(false)
    await client.close()
  })

  it("starts a thread once: the second call returns the same item", async () => {
    const client = await connect(AGENT)
    const args = { threadId: "thread-mcp", parentThreadId: null, title: "Wire the importer" }
    const first = await callTool(client, "mikud_start_thread", args)
    const second = await callTool(client, "mikud_start_thread", args)
    expect(first.isError).toBe(false)
    expect(first.body.data).toMatchObject({ created: true, item: { status: "in_progress" } })
    expect(second.body.data).toMatchObject({ created: false, item: { id: first.body.data.item.id } })
    const found = await callTool(client, "mikud_find_items", { threadId: "thread-mcp" })
    expect(found.body.data).toHaveLength(1)
    const child = await callTool(client, "mikud_start_thread", {
      ...args,
      threadId: "child",
      parentThreadId: "thread-mcp",
    })
    expect(child).toMatchObject({ isError: true, body: { error: { code: "not_top_level" } } })
    await client.close()
  })

  it("does not let an agent change a stage: it proposes one", async () => {
    const project = await createProject(t.ctx, owner, { name: "Compass" })
    const client = await connect(AGENT)
    const updated = await callTool(client, "mikud_update_project", {
      projectId: project.id,
      whereWeAre: "Parser done",
      goal: "First import",
      stage: "production",
    })
    expect(updated.isError).toBe(false)
    expect(updated.body.data).toMatchObject({ whereWeAre: "Parser done", stage: null })
    const proposal = await callTool(client, "mikud_propose_stage", {
      projectId: project.id,
      stage: "poc",
      reason: "The importer runs end to end",
    })
    expect(proposal.body.data).toMatchObject({ proposedStage: "poc", state: "open", authorKind: "agent" })
    const listed = await callTool(client, "mikud_list_projects", {})
    expect(listed.body.data[0]).toMatchObject({ stage: null, openProposals: 1, goal: { text: "First import" } })
    await client.close()
  })

  it("refuses text that looks like a secret, naming the rule only", async () => {
    const client = await connect(AGENT)
    const { body } = await callTool(client, "mikud_start_thread", {
      threadId: "thread-secret",
      parentThreadId: null,
      title: "Rotate keys",
    })
    const token = `${"gh"}p_${"Zz9Yy8Xx7W".repeat(4)}`
    const refused = await callTool(client, "mikud_comment", {
      itemId: body.data.item.id,
      text: `Rotated, the new one is ${token}`,
    })
    expect(refused).toMatchObject({
      isError: true,
      body: { error: { code: "secret_suspected", rule: "github_token", field: "comment" } },
    })
    expect(refused.text).not.toContain(token)
    const item = await callTool(client, "mikud_get_item", { itemId: body.data.item.id })
    expect(item.body.data.comments).toHaveLength(0)
    await client.close()
  })

  it("updates with a version and answers version_conflict on a stale one", async () => {
    const client = await connect(AGENT)
    const created = await callTool(client, "mikud_create_item", { type: "task", title: "Versioned" })
    const id = created.body.data.id
    const ok = await callTool(client, "mikud_update_item", { itemId: id, version: 1, status: "waiting_on_you" })
    expect(ok.body.data).toMatchObject({ status: "waiting_on_you", version: 2 })
    const stale = await callTool(client, "mikud_update_item", { itemId: id, version: 1, status: "done" })
    expect(stale).toMatchObject({ isError: true, body: { error: { code: "version_conflict", currentVersion: 2 } } })
    await client.close()
  })

  it("requires a bearer token and does not accept a browser cookie", async () => {
    const init = {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }
    expect((await fetch(`${base}/mcp`, init)).status).toBe(401)
    const withCookie = await fetch(`${base}/mcp`, { ...init, headers: { ...init.headers, cookie: "mikud_device=x" } })
    expect(withCookie.status).toBe(401)
    await expect(connect("not-the-token")).rejects.toThrow()
  })

  it("creates, finds, reads and updates a note, and refuses a stale version and a secret", async () => {
    const client = await connect(AGENT)
    const created = await callTool(client, "mikud_create_note", {
      title: "How backups run",
      body: "Nightly, by the owner's tools.",
    })
    expect(created.isError).toBe(false)
    expect(created.body.data).toMatchObject({
      title: "How backups run",
      version: 1,
      createdBy: "agent",
      projectId: null,
    })
    const noteId = created.body.data.id
    const found = await callTool(client, "mikud_find_notes", { query: "backups" })
    expect(found.body.data.data.map((n: { id: string }) => n.id)).toEqual([noteId])
    expect(found.body.data.data[0]).not.toHaveProperty("body")
    const read = await callTool(client, "mikud_get_note", { noteId })
    expect(read.body.data).toMatchObject({
      note: { id: noteId, body: "Nightly, by the owner's tools." },
      project: null,
    })
    const updated = await callTool(client, "mikud_update_note", { noteId, version: 1, body: "Nightly." })
    expect(updated.body.data).toMatchObject({ version: 2, body: "Nightly." })
    const stale = await callTool(client, "mikud_update_note", { noteId, version: 1, body: "Late" })
    expect(stale).toMatchObject({ isError: true, body: { error: { code: "version_conflict", currentVersion: 2 } } })
    const secret = await callTool(client, "mikud_update_note", {
      noteId,
      version: 2,
      body: `${"gh"}p_${"A1b2C3d4E5".repeat(4)}`,
    })
    expect(secret).toMatchObject({ isError: true, body: { error: { code: "secret_suspected" } } })
    expect(secret.text).not.toContain("A1b2C3d4E5")
    await client.close()
  })

  it("files a note in a project and lists only that project's notes", async () => {
    const project = await createProject(t.ctx, owner, { name: "Lighthouse" })
    const client = await connect(AGENT)
    await callTool(client, "mikud_create_note", { title: "In the project", projectId: project.id })
    await callTool(client, "mikud_create_note", { title: "General" })
    const inProject = await callTool(client, "mikud_find_notes", { projectId: project.id })
    expect(inProject.body.data.data.map((n: { title: string }) => n.title)).toEqual(["In the project"])
    const general = await callTool(client, "mikud_find_notes", { general: true })
    expect(general.body.data.data.map((n: { title: string }) => n.title)).toEqual(["General"])
    await client.close()
  })
})
