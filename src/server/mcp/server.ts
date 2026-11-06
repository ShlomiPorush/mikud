import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { Hono } from "hono"
import { z } from "zod"
import { LIMITS } from "../../shared/api.ts"
import {
  actorKindSchema,
  ITEM_STATUSES,
  itemStatusSchema,
  itemTypeSchema,
  STAGES,
  severitySchema,
  stageSchema,
} from "../../shared/enums.ts"
import { AppError, errorBody } from "../errors.ts"
import { type AuthDeps, authenticate, type Env } from "../http/auth.ts"
import type { By, Ctx } from "../services/context.ts"
import { addComment, captureItem, createItem, linkThread, updateItem } from "../services/items.ts"
import { createNote, findNotes, NOTE_SORTS, noteDetail, updateNote } from "../services/notes.ts"
import { proposeStage, updateProject } from "../services/projects.ts"
import { findItems, itemDetail, listProjects } from "../services/reads.ts"
import { startThread } from "../services/threads.ts"

/** Read by MCP clients once; the tool descriptions carry the details. */
const INSTRUCTIONS = `Mikud is the owner's project-focus board. Keep the item of your T3 thread current.
At thread start call mikud_start_thread once. At the end leave one short summary with mikud_comment and set the status with mikud_update_item.
Statuses: ${ITEM_STATUSES.join(", ")}. Use waiting_on_you only when the owner must act (a decision, a manual test, a merge approval).
Never write secrets or server details: no tokens, passwords, keys, host names or IP addresses. Such text is refused with secret_suspected.
You cannot delete items or projects, and you cannot change a stage: propose one with mikud_propose_stage.
Notes keep knowledge worth finding again (decisions, explanations, findings, how things work): find one with mikud_find_notes before you write, and update it rather than writing a second one. Work to do is an item, not a note. You cannot delete notes.
Subagent and review threads (those with a parent thread) must not call Mikud.`

const id = z.uuid()
const threadId = z.string().trim().min(1).max(200)

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] }
}

/** One stateless MCP server per request, acting as `by`. */
export function buildMcpServer(ctx: Ctx, by: By, version: string): McpServer {
  const server = new McpServer({ name: "mikud", version }, { instructions: INSTRUCTIONS })
  // Arguments are validated by the SDK against inputSchema before run() is called.
  // biome-ignore lint/suspicious/noExplicitAny: tool arguments are typed by each tool's zod schema
  type Args = Record<string, any>
  const tool = (
    name: string,
    description: string,
    inputSchema: z.ZodRawShape,
    readOnly: boolean,
    run: (args: Args) => Promise<unknown>,
  ) =>
    server.registerTool(
      name,
      {
        description,
        inputSchema,
        annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false },
      },
      (async (args: Args) => {
        try {
          return json({ data: await run(args) })
        } catch (error) {
          if (error instanceof AppError) return { ...json(errorBody(error)), isError: true }
          throw error
        }
      }) as never,
    )

  tool(
    "mikud_start_thread",
    "Call once at the start of a top-level T3 thread. Finds the item linked to threadId, or links itemId, or creates a task item, and sets it in_progress. Calling it again returns the same item. parentThreadId: your thread's parent from T3 (null for a top-level thread); when set, the call is refused with not_top_level and you must not call Mikud again. projectId (Mikud) or t3ProjectId picks the project; with neither, the item goes to the inbox. Refused with suppressed when the owner deleted this thread's item.",
    {
      threadId,
      parentThreadId: threadId.nullable(),
      title: z.string().max(LIMITS.title).describe("Short title of the work, from the thread"),
      projectId: id.optional(),
      t3ProjectId: threadId.optional(),
      itemId: id.optional().describe("An existing item to link instead of creating one"),
    },
    false,
    (a) => startThread(ctx, by, a as never),
  )
  tool(
    "mikud_find_items",
    "Search items by text in title and body, project, status, type or linked T3 thread. Open items only unless includeClosed or status is given. Returns summaries with id and version.",
    {
      query: z.string().max(200).optional(),
      projectId: id.optional(),
      inbox: z.boolean().optional().describe("Only items without a project"),
      status: z.array(itemStatusSchema).optional(),
      type: itemTypeSchema.optional(),
      threadId: threadId.optional(),
      includeClosed: z.boolean().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    true,
    (a) => findItems(ctx, { ...a, q: a.query }),
  )
  tool(
    "mikud_get_item",
    "One item with its project, goal, linked threads, comments and change history. Read it before mikud_update_item: the update needs its current version.",
    { itemId: id },
    true,
    (a) => itemDetail(ctx, a.itemId),
  )
  tool(
    "mikud_create_item",
    `Create an item. type: bug, decision, security, task or idea. status defaults to todo. severity (critical, high, medium, low) only for type security. Without projectId the item goes to the inbox. goalId must be a goal of the same project.`,
    {
      type: itemTypeSchema,
      title: z.string().max(LIMITS.title),
      body: z.string().max(LIMITS.body).optional(),
      status: itemStatusSchema.optional(),
      severity: severitySchema.optional(),
      projectId: id.optional(),
      goalId: id.optional(),
    },
    false,
    (a) => createItem(ctx, by, a as never),
  )
  tool(
    "mikud_update_item",
    `Change an item. version is the version you read (mikud_get_item or mikud_find_items); a stale one is refused with version_conflict: read again and retry. status: ${ITEM_STATUSES.join(", ")}. Set waiting_on_you only when the owner must act; done or not_relevant closes the item. You cannot delete items.`,
    {
      itemId: id,
      version: z.number().int().min(1),
      title: z.string().max(LIMITS.title).optional(),
      body: z.string().max(LIMITS.body).optional(),
      status: itemStatusSchema.optional(),
      type: itemTypeSchema.optional(),
      severity: severitySchema.nullable().optional(),
      projectId: id.nullable().optional(),
      goalId: id.nullable().optional(),
    },
    false,
    ({ itemId, version, ...patch }) => updateItem(ctx, by, itemId, version, patch),
  )
  tool(
    "mikud_comment",
    "Add a comment to an item. At the end of a thread leave one short summary: what was done, what is left, what the owner must do. threadId: your T3 thread.",
    { itemId: id, text: z.string().max(LIMITS.comment), threadId: threadId.optional() },
    false,
    (a) => addComment(ctx, by, a.itemId, { text: a.text, threadId: a.threadId }),
  )
  tool(
    "mikud_capture",
    'Quick capture of an idea for later ("note an idea for project X"): an idea item with status future, in the project or else in the inbox. The first line becomes the title. Knowledge to keep goes in a note (mikud_create_note), not here.',
    { text: z.string().max(LIMITS.body), projectId: id.optional() },
    false,
    (a) => captureItem(ctx, by, a as never),
  )
  tool(
    "mikud_find_notes",
    "Search notes by text in title and body, by project (projectId), only notes without a project (general), or by who created them (createdBy: owner, agent, bot). sort: updated (newest change first, the default) or title. Returns summaries with id, version and the start of the body, and nextCursor for the next page (pass it back with the same filters).",
    {
      query: z.string().max(200).optional(),
      projectId: id.optional(),
      general: z.boolean().optional(),
      createdBy: actorKindSchema.optional(),
      sort: z.enum(NOTE_SORTS).optional(),
      cursor: z.string().max(LIMITS.noteCursor).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    true,
    (a) => findNotes(ctx, { ...a, q: a.query }),
  )
  tool(
    "mikud_get_note",
    "One note with its whole Markdown body, its version and its project. Read it before mikud_update_note: the update needs its current version.",
    { noteId: id },
    true,
    (a) => noteDetail(ctx, a.noteId),
  )
  tool(
    "mikud_create_note",
    `Create a note: knowledge worth finding again. body is Markdown (up to ${LIMITS.noteBody} characters). Without projectId it is a general note. Look for an existing note with mikud_find_notes first.`,
    {
      title: z.string().max(LIMITS.noteTitle),
      body: z.string().max(LIMITS.noteBody).optional(),
      projectId: id.optional(),
    },
    false,
    (a) => createNote(ctx, by, a as never),
  )
  tool(
    "mikud_update_note",
    "Change a note, the owner's included: send the whole new title or body, not a diff. version is the version you read (mikud_get_note); a stale one is refused with version_conflict: read again, merge, retry. Every change is kept as a version the owner can restore. projectId moves the note (null: a general note). You cannot delete notes.",
    {
      noteId: id,
      version: z.number().int().min(1),
      title: z.string().max(LIMITS.noteTitle).optional(),
      body: z.string().max(LIMITS.noteBody).optional(),
      projectId: id.nullable().optional(),
    },
    false,
    ({ noteId, version, ...patch }) => updateNote(ctx, by, noteId, version, patch),
  )
  tool(
    "mikud_link_thread",
    "Link another top-level T3 thread to an item (an item may have several threads). parentThreadId as in mikud_start_thread: a child thread is refused with not_top_level. A thread linked to another item is refused with conflict.",
    {
      itemId: id,
      threadId,
      parentThreadId: threadId.nullable(),
      t3ProjectId: threadId.optional(),
      title: z.string().max(LIMITS.title).optional(),
    },
    false,
    ({ itemId, ...link }) => linkThread(ctx, by, itemId, link as never),
  )
  tool(
    "mikud_list_projects",
    `Every project with id, name, t3ProjectId, githubRepo, stage (${STAGES.join(", ")} or null when unset), current goal with progress (done/total), whereWeAre and open item count.`,
    {},
    true,
    () => listProjects(ctx),
  )
  tool(
    "mikud_update_project",
    "Set a project's whereWeAre (one line: where the work stands) and/or its current goal (the near goal; a new text closes the previous goal, null closes it). Nothing else of a project can be changed by agents; for a stage use mikud_propose_stage.",
    {
      projectId: id,
      whereWeAre: z.string().max(LIMITS.whereWeAre).nullable().optional(),
      goal: z.string().max(LIMITS.goal).nullable().optional(),
    },
    false,
    (a) => updateProject(ctx, by, a.projectId, { whereWeAre: a.whereWeAre, goal: a.goal }),
  )
  tool(
    "mikud_propose_stage",
    `Propose a stage for a project (${STAGES.join(", ")}) with a short reason. Only the owner changes a stage; the proposal waits for the owner in the morning view.`,
    { projectId: id, stage: stageSchema, reason: z.string().max(LIMITS.reason) },
    false,
    (a) => proposeStage(ctx, by, a.projectId, { stage: a.stage, reason: a.reason }),
  )
  return server
}

/** MCP over Streamable HTTP at /mcp, stateless, with the owner or agent token as a bearer token. */
export function mcpRoutes(deps: AuthDeps & { version: string }) {
  const app = new Hono<Env>()
  app.use("*", authenticate(deps, { allowSession: false }))
  app.all("/", async (c) => {
    const by: By = { actor: c.get("auth").actor, source: "mcp" }
    const server = buildMcpServer(deps.ctx, by, deps.version)
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    await server.connect(transport)
    return transport.handleRequest(c.req.raw)
  })
  return app
}
