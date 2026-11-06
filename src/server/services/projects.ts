import { and, eq, isNull, like, or } from "drizzle-orm"
import type { Stage } from "../../shared/enums.ts"
import { goals, items, notes, projects, stageProposals, suppressions } from "../db/schema.ts"
import { AppError, forbidden, invalid, notFound } from "../errors.ts"
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

export type ProjectRow = typeof projects.$inferSelect
export type GoalRow = typeof goals.$inferSelect
export type ProposalRow = typeof stageProposals.$inferSelect

export const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

export async function getProjectRow(tx: DbOrTx, id: string): Promise<ProjectRow> {
  const [row] = await tx.select().from(projects).where(eq(projects.id, id))
  if (!row) throw notFound("The project")
  return row
}

/** A URL-safe slug from the name; names without Latin letters get "project". */
export function slugify(name: string): string {
  const base = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
  return base || "project"
}

async function uniqueSlug(tx: DbOrTx, wanted: string, exceptId?: string): Promise<string> {
  const rows = await tx
    .select({ id: projects.id, slug: projects.slug })
    .from(projects)
    .where(or(eq(projects.slug, wanted), like(projects.slug, `${wanted}-%`)))
  const taken = new Set(rows.filter((r) => r.id !== exceptId).map((r) => r.slug))
  if (!taken.has(wanted)) return wanted
  for (let n = 2; ; n++) if (!taken.has(`${wanted}-${n}`)) return `${wanted}-${n}`
}

export async function currentGoal(tx: DbOrTx, projectId: string): Promise<GoalRow | null> {
  const [row] = await tx
    .select()
    .from(goals)
    .where(and(eq(goals.projectId, projectId), isNull(goals.closedAt)))
  return row ?? null
}

function requireProjectCreator(by: By) {
  if (by.actor.kind !== "owner" && by.actor.kind !== "sync" && by.actor.kind !== "system")
    throw forbidden("Projects come from T3 or from the owner; agents cannot create them.")
}

export type CreateProjectInput = {
  name: string
  slug?: string
  t3ProjectId?: string | null
  githubRepo?: string | null
  stage?: Stage | null
}

/** The owner and the sync create projects. A new project's stage stays unset unless the owner gives one. */
export async function createProjectTx(ctx: Ctx, tx: Tx, by: By, input: CreateProjectInput): Promise<ProjectRow> {
  requireProjectCreator(by)
  if (input.stage && by.actor.kind !== "owner") throw forbidden("Only the owner sets a stage.")
  const name = input.name.replace(/\s+/g, " ").trim()
  if (!name) throw invalid("The name is empty.")
  if (input.githubRepo && !REPO_PATTERN.test(input.githubRepo)) throw invalid("The repository must be owner/name.")
  const slug = await uniqueSlug(tx, input.slug ? slugify(input.slug) : slugify(name))
  const now = ctx.clock()
  const [row] = await tx
    .insert(projects)
    .values({
      name,
      slug,
      t3ProjectId: input.t3ProjectId ?? null,
      githubRepo: input.githubRepo ?? null,
      stage: input.stage ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
  if (!row) throw new Error("insert returned no row")
  await writeAudit(ctx, tx, by, { action: "project.create", entityType: "project", entityId: row.id, after: row })
  return row
}

export async function createProject(ctx: Ctx, by: By, input: CreateProjectInput): Promise<ProjectRow> {
  requireProjectCreator(by)
  if (input.t3ProjectId) {
    const [taken] = await ctx.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.t3ProjectId, input.t3ProjectId))
    if (taken) throw new AppError("conflict", "A project with this T3 project id exists.", { projectId: taken.id })
  }
  return inTx(ctx, (tx) => createProjectTx(ctx, tx, by, input))
}

export type ProjectPatch = {
  name?: string
  slug?: string
  githubRepo?: string | null
  stage?: Stage | null
  whereWeAre?: string | null
  /** A new current goal (closes the previous one), or null to close it without a new one. */
  goal?: string | null
}

const OWNER_ONLY_FIELDS = ["name", "slug", "githubRepo", "stage"] as const

/**
 * The owner changes anything. Agents (and the bot and sync) change only the where-we-are line and the
 * current goal; a stage change is refused (they propose one with proposeStage).
 */
export async function updateProject(ctx: Ctx, by: By, id: string, patch: ProjectPatch): Promise<ProjectRow> {
  if (by.actor.kind !== "owner") {
    if (patch.stage !== undefined)
      throw forbidden("Only the owner changes a stage. Propose one with a stage proposal instead.")
    const field = OWNER_ONLY_FIELDS.find((f) => patch[f] !== undefined)
    if (field) throw forbidden(`Only the owner changes the project's ${field}.`)
  }
  checkAgentText(ctx, by, { whereWeAre: patch.whereWeAre, goal: patch.goal })
  return inTx(ctx, async (tx) => {
    const [before] = await tx.select().from(projects).where(eq(projects.id, id)).for("update")
    if (!before) throw notFound("The project")
    const next: Partial<ProjectRow> = {}
    if (patch.name !== undefined) {
      const name = patch.name.replace(/\s+/g, " ").trim()
      if (!name) throw invalid("The name is empty.")
      next.name = name
    }
    if (patch.slug !== undefined) next.slug = await uniqueSlug(tx, slugify(patch.slug), id)
    if (patch.githubRepo !== undefined) {
      if (patch.githubRepo && !REPO_PATTERN.test(patch.githubRepo)) throw invalid("The repository must be owner/name.")
      next.githubRepo = patch.githubRepo
    }
    if (patch.stage !== undefined) next.stage = patch.stage
    if (patch.whereWeAre !== undefined) next.whereWeAre = patch.whereWeAre?.replace(/\s+/g, " ").trim() || null

    const now = ctx.clock()
    let after = before
    const changed = Object.entries(next).filter(([k, v]) => before[k as keyof ProjectRow] !== v)
    if (changed.length > 0) {
      const [row] = await tx
        .update(projects)
        .set({ ...Object.fromEntries(changed), updatedAt: now })
        .where(eq(projects.id, id))
        .returning()
      if (!row) throw notFound("The project")
      after = row
      await writeAudit(ctx, tx, by, { action: "project.update", entityType: "project", entityId: id, before, after })
    }
    if (patch.goal !== undefined) await setGoalTx(ctx, tx, by, id, patch.goal)
    return after
  })
}

/** Closes the current goal and opens the new one (or none). The same text again changes nothing. */
async function setGoalTx(ctx: Ctx, tx: Tx, by: By, projectId: string, text: string | null) {
  const wanted = text?.replace(/\s+/g, " ").trim() || null
  const current = await currentGoal(tx, projectId)
  if ((current?.text ?? null) === wanted) return
  const now = ctx.clock()
  if (current) {
    const [closedGoal] = await tx.update(goals).set({ closedAt: now }).where(eq(goals.id, current.id)).returning()
    await writeAudit(ctx, tx, by, {
      action: "goal.close",
      entityType: "project",
      entityId: projectId,
      before: current,
      after: closedGoal,
    })
  }
  if (wanted) {
    const [goal] = await tx.insert(goals).values({ projectId, text: wanted, createdAt: now }).returning()
    await writeAudit(ctx, tx, by, { action: "goal.create", entityType: "project", entityId: projectId, after: goal })
  }
}

/**
 * Anyone may propose a stage; the proposal waits for the owner. An open proposal of the same stage is
 * updated instead of repeated.
 */
export async function proposeStage(
  ctx: Ctx,
  by: By,
  projectId: string,
  input: { stage: Stage; reason?: string },
): Promise<ProposalRow> {
  const reason = (input.reason ?? "").trim()
  checkAgentText(ctx, by, { reason })
  return inTx(ctx, async (tx) => {
    await getProjectRow(tx, projectId)
    const [open] = await tx
      .select()
      .from(stageProposals)
      .where(
        and(
          eq(stageProposals.projectId, projectId),
          eq(stageProposals.state, "open"),
          eq(stageProposals.proposedStage, input.stage),
        ),
      )
      .for("update")
    if (open) {
      if (open.reason === reason) return open
      const [row] = await tx
        .update(stageProposals)
        .set({ reason, authorKind: by.actor.kind, authorLabel: by.actor.label })
        .where(eq(stageProposals.id, open.id))
        .returning()
      if (!row) throw notFound("The proposal")
      await writeAudit(ctx, tx, by, {
        action: "proposal.update",
        entityType: "project",
        entityId: projectId,
        before: open,
        after: row,
      })
      return row
    }
    const [row] = await tx
      .insert(stageProposals)
      .values({
        projectId,
        proposedStage: input.stage,
        reason,
        authorKind: by.actor.kind,
        authorLabel: by.actor.label,
        createdAt: ctx.clock(),
      })
      .returning()
    if (!row) throw new Error("insert returned no row")
    await writeAudit(ctx, tx, by, { action: "proposal.create", entityType: "project", entityId: projectId, after: row })
    return row
  })
}

/** Owner only. Accepting sets the project's stage. */
export async function decideProposal(
  ctx: Ctx,
  by: By,
  proposalId: string,
  decision: "accept" | "reject",
): Promise<{ proposal: ProposalRow; project: ProjectRow }> {
  requireOwner(by, "decide stage proposals")
  return inTx(ctx, async (tx) => {
    const [proposal] = await tx.select().from(stageProposals).where(eq(stageProposals.id, proposalId)).for("update")
    if (!proposal) throw notFound("The proposal")
    if (proposal.state !== "open") throw new AppError("conflict", "This proposal was decided already.")
    const now = ctx.clock()
    const [decided] = await tx
      .update(stageProposals)
      .set({ state: decision === "accept" ? "accepted" : "rejected", decidedAt: now })
      .where(eq(stageProposals.id, proposalId))
      .returning()
    if (!decided) throw notFound("The proposal")
    await writeAudit(ctx, tx, by, {
      action: `proposal.${decision}`,
      entityType: "project",
      entityId: proposal.projectId,
      before: proposal,
      after: decided,
    })
    let project = await getProjectRow(tx, proposal.projectId)
    if (decision === "accept" && project.stage !== proposal.proposedStage) {
      const [row] = await tx
        .update(projects)
        .set({ stage: proposal.proposedStage, updatedAt: now })
        .where(eq(projects.id, project.id))
        .returning()
      if (!row) throw notFound("The project")
      await writeAudit(ctx, tx, by, {
        action: "project.update",
        entityType: "project",
        entityId: project.id,
        before: project,
        after: row,
      })
      project = row
    }
    return { proposal: decided, project }
  })
}

/**
 * Owner only. A project with items or notes is refused with `conflict` (delete or move them first). Its T3
 * project id is suppressed so the sync never recreates it.
 */
export async function deleteProject(ctx: Ctx, by: By, id: string): Promise<void> {
  requireOwner(by, "delete projects")
  return inLinkTx(ctx, async (tx) => {
    const [before] = await tx.select().from(projects).where(eq(projects.id, id)).for("update")
    if (!before) throw notFound("The project")
    const [item] = await tx.select({ id: items.id }).from(items).where(eq(items.projectId, id)).limit(1)
    if (item) throw new AppError("conflict", "The project still has items. Delete or move them first.")
    const [note] = await tx.select({ id: notes.id }).from(notes).where(eq(notes.projectId, id)).limit(1)
    if (note) throw new AppError("conflict", "The project still has notes. Delete or move them first.")
    if (before.t3ProjectId) {
      const [s] = await tx
        .insert(suppressions)
        .values({ kind: "project", externalId: before.t3ProjectId, label: before.name, createdAt: ctx.clock() })
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
    await tx.delete(projects).where(eq(projects.id, id))
    await writeAudit(ctx, tx, by, { action: "project.delete", entityType: "project", entityId: id, before })
  })
}
