// What a reader other than the owner sees of an audit row (docs/api.md, AuditEntry): rows of settings and suppressions,
// which only the owner may read through their own routes, keep their place in the log but show only the names of the
// fields that changed. The data is invented.

import { describe, expect, it } from "vitest"
import type { ActorKind } from "../../shared/enums.ts"
import type { By } from "./context.ts"
import { auditEntryFor } from "./reads.ts"

const by = (kind: ActorKind): By => ({ actor: { kind, label: kind === "agent" ? "agent:codex" : kind }, source: "api" })
const owner = by("owner")
const agent = by("agent")

const base = {
  id: 7,
  at: new Date("2026-11-01T08:00:00Z"),
  actorKind: "owner" as const,
  actorLabel: "owner",
  source: "ui" as const,
}

const settingsBefore = {
  id: 1,
  closedItemDays: 30,
  privateDomains: ["lantern.example"],
  telegramChatId: null,
  otpViaTelegram: false,
  telegramBotToken: "set",
  updatedAt: "2026-10-01T08:00:00.000Z",
}
const settingsRow = {
  ...base,
  action: "settings.update",
  entityType: "settings",
  entityId: "1",
  before: settingsBefore,
  after: {
    ...settingsBefore,
    privateDomains: ["lantern.example", "moss.example"],
    telegramChatId: "424242",
    telegramBotToken: "set",
    telegramBotTokenChange: "replaced",
    updatedAt: "2026-11-01T08:00:00.000Z",
  },
}
const suppression = {
  id: "4b0e",
  kind: "thread",
  externalId: "t-hose",
  label: "Coil the hose",
  createdAt: "2026-11-01",
}

describe("an audit row for a reader other than the owner", () => {
  it("shows a settings change only as the names of the fields that changed", () => {
    expect(auditEntryFor(agent, settingsRow)).toEqual({
      ...settingsRow,
      before: null,
      after: null,
      redactedFields: ["privateDomains", "telegramBotTokenChange", "telegramChatId", "updatedAt"],
    })
  })

  it("names a token replaced while it stays set, and leaves out a time that did not change", () => {
    const after = { ...settingsBefore, telegramBotTokenChange: "replaced" }
    expect(auditEntryFor(agent, { ...settingsRow, after }).redactedFields).toEqual(["telegramBotTokenChange"])
  })

  it("names every field of a suppression created or removed, and none of its values", () => {
    const created = { ...base, action: "suppression.create", entityType: "suppression", entityId: "4b0e", before: null }
    const removed = { ...created, action: "suppression.delete", before: suppression, after: null }
    const fields = ["createdAt", "externalId", "id", "kind", "label"]
    expect(auditEntryFor(agent, { ...created, after: suppression })).toEqual({
      ...created,
      after: null,
      redactedFields: fields,
    })
    expect(auditEntryFor(agent, removed)).toEqual({ ...removed, before: null, redactedFields: fields })
  })

  it("redacts for every kind of reader but the owner", () => {
    for (const kind of ["agent", "sync", "bot", "system"] as const) {
      const entry = auditEntryFor(by(kind), settingsRow)
      expect([kind, entry.before, entry.after]).toEqual([kind, null, null])
      expect(JSON.stringify(entry)).not.toContain("moss.example")
    }
  })

  it("names the fields of an older row whose shape differs, and of a row without values", () => {
    const older = {
      ...settingsRow,
      before: { closedItemDays: 30, removedSetting: true },
      after: { closedItemDays: 30 },
    }
    expect(auditEntryFor(agent, older).redactedFields).toEqual(["removedSetting"])
    expect(auditEntryFor(agent, { ...settingsRow, before: null, after: null }).redactedFields).toEqual([])
    expect(auditEntryFor(agent, { ...settingsRow, before: ["x"], after: "y" }).redactedFields).toEqual([])
  })

  it("leaves the stored row as it was", () => {
    const row = structuredClone(settingsRow)
    auditEntryFor(agent, row)
    expect(row).toEqual(settingsRow)
  })
})

describe("an audit row the reader may see whole", () => {
  it("is the owner's, whatever the entity", () => {
    expect(auditEntryFor(owner, settingsRow)).toBe(settingsRow)
  })

  it("is any reader's for an entity agents may read", () => {
    const item = {
      ...base,
      action: "item.update",
      entityType: "item",
      entityId: "a1",
      before: { t: 1 },
      after: { t: 2 },
    }
    expect(auditEntryFor(agent, item)).toBe(item)
  })
})
