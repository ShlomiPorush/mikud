import { z } from "zod"

// Codes stored in the database and sent over the API. They are English and never shown as-is:
// user-visible labels for the labelled groups come from src/shared/locales/*.json.

// --- Labelled codes (every code has a label in each locale file) ---

export const STAGES = ["idea", "poc", "development", "production", "redesign", "frozen"] as const
export const ITEM_STATUSES = ["future", "todo", "in_progress", "waiting_on_you", "done", "not_relevant"] as const
export const ITEM_TYPES = ["bug", "decision", "security", "task", "idea"] as const
export const SEVERITIES = ["critical", "high", "medium", "low"] as const

/** Statuses that close an item. A closed item has closed_at set and is archived by query. */
export const CLOSED_STATUSES = ["done", "not_relevant"] as const satisfies readonly ItemStatus[]

// --- Internal codes ---

/** Who made a change. Services enforce the rights of each. */
export const ACTOR_KINDS = ["owner", "agent", "bot", "sync", "system"] as const
/** Where a change came in. `cli` is the recovery command run on the server (dist/server/cli.js). */
export const AUDIT_SOURCES = ["ui", "api", "mcp", "telegram", "sync", "cli"] as const
export const PROPOSAL_STATES = ["open", "accepted", "rejected"] as const
export const SECURITY_FAMILIES = ["dependabot", "code_scanning", "secret_scanning", "overview"] as const
export const SECURITY_COVERAGES = ["enabled", "not_enabled", "no_access", "error", "unknown"] as const
/** What a suppression keeps the sync from recreating. */
export const SUPPRESSION_KINDS = ["thread", "project"] as const
export const SYNC_OUTCOMES = ["succeeded", "partial", "failed"] as const
/**
 * A morning run: `sending` before the send, then `sent`; `failed` (Telegram refused it; retried until the
 * cutoff), `unknown` (it may have gone out; never resent) or `skipped` (the cutoff passed without a send).
 */
export const JOB_STATES = ["sending", "sent", "failed", "unknown", "skipped"] as const
export const TELEGRAM_OUTCOMES = ["item_created", "note_created", "ignored", "refused"] as const
export const LANGUAGES = ["he", "en"] as const

/**
 * Every audit action written today, then the ones only older rows hold. Each has a label in `audit.action` of
 * each locale file, keyed with its dots as underscores (locales.test.ts). No database check uses the list: an
 * unknown code in an old row is still read, shown by its code and filtered by it. Add a new action here.
 */
export const AUDIT_ACTIONS = [
  "item.create",
  "item.update",
  "item.delete",
  "comment.create",
  "note.create",
  "note.update",
  "note.restore",
  "note.delete",
  "thread.link",
  "thread.update",
  "thread.move",
  "thread.unlink",
  "project.create",
  "project.update",
  "project.delete",
  "goal.create",
  "goal.close",
  "proposal.create",
  "proposal.update",
  "proposal.accept",
  "proposal.reject",
  "security.update",
  "suppression.create",
  "suppression.delete",
  "settings.update",
  "telegram.test_message",
  "account.setup",
  "account.totp_enable",
  "account.totp_disable",
  "account.password_change",
  "account.password_reset",
  "account.backup_codes_new",
  "session.sign_in",
  "session.sign_out",
  "session.end",
  "session.connect",
  "session.revoke",
  "api_key.create",
  "api_key.delete",
  "device.approve",
  "device.deny",
  // Older rows only.
  "device.pair",
  "device.revoke",
  "device.revoke_all",
  "session.end_others",
  "session.end_all",
  "session.sweep",
  "auth.repair",
] as const
/** What an audit row is about; each has a label in `audit.entity` of each locale file. */
export const AUDIT_ENTITY_TYPES = [
  "item",
  "note",
  "project",
  "settings",
  "device",
  "suppression",
  "goal",
  "proposal",
  "comment",
  "thread",
  "session",
  "account",
  "api_key",
  "device_code",
] as const

export type Stage = (typeof STAGES)[number]
export type ItemStatus = (typeof ITEM_STATUSES)[number]
export type ItemType = (typeof ITEM_TYPES)[number]
export type Severity = (typeof SEVERITIES)[number]
export type ActorKind = (typeof ACTOR_KINDS)[number]
export type AuditSource = (typeof AUDIT_SOURCES)[number]
export type ProposalState = (typeof PROPOSAL_STATES)[number]
export type SecurityFamily = (typeof SECURITY_FAMILIES)[number]
export type SecurityCoverage = (typeof SECURITY_COVERAGES)[number]
export type SuppressionKind = (typeof SUPPRESSION_KINDS)[number]
export type SyncOutcome = (typeof SYNC_OUTCOMES)[number]
export type JobState = (typeof JOB_STATES)[number]
export type TelegramOutcome = (typeof TELEGRAM_OUTCOMES)[number]
export type Language = (typeof LANGUAGES)[number]
export type AuditAction = (typeof AUDIT_ACTIONS)[number]
export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number]

export const stageSchema = z.enum(STAGES)
export const itemStatusSchema = z.enum(ITEM_STATUSES)
export const itemTypeSchema = z.enum(ITEM_TYPES)
export const severitySchema = z.enum(SEVERITIES)
export const actorKindSchema = z.enum(ACTOR_KINDS)
export const auditSourceSchema = z.enum(AUDIT_SOURCES)
export const proposalStateSchema = z.enum(PROPOSAL_STATES)
export const securityFamilySchema = z.enum(SECURITY_FAMILIES)
export const securityCoverageSchema = z.enum(SECURITY_COVERAGES)
export const suppressionKindSchema = z.enum(SUPPRESSION_KINDS)
export const syncOutcomeSchema = z.enum(SYNC_OUTCOMES)
export const jobStateSchema = z.enum(JOB_STATES)
export const telegramOutcomeSchema = z.enum(TELEGRAM_OUTCOMES)
export const languageSchema = z.enum(LANGUAGES)

/** The labelled groups, keyed by their section name in the locale files. */
export const LABELLED_CODES = {
  stage: STAGES,
  itemStatus: ITEM_STATUSES,
  itemType: ITEM_TYPES,
  severity: SEVERITIES,
} as const
