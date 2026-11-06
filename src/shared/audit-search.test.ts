import { describe, expect, it } from "vitest"
import { actionKey, auditCodesMatching } from "./audit-search.ts"
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from "./enums.ts"
import en from "./locales/en.json"
import he from "./locales/he.json"

const locales = { en, he }

/** "Changed": the first word of the Hebrew label of settings.update, which three more labels share. */
const CHANGED_HE = he.audit.action.settings_update.split(" ")[0] ?? ""

describe("the audit catalogue", () => {
  for (const [name, locale] of Object.entries(locales)) {
    it(`${name} labels every action and entity type, and nothing else`, () => {
      expect(Object.keys(locale.audit.action).sort()).toEqual(AUDIT_ACTIONS.map(actionKey).sort())
      expect(Object.keys(locale.audit.entity).sort()).toEqual([...AUDIT_ENTITY_TYPES].sort())
      for (const label of Object.values(locale.audit.action)) expect(label.trim()).toBeTruthy()
    })
  }

  it("maps every code to its own key, never one key to two codes", () => {
    const keys = AUDIT_ACTIONS.map(actionKey)
    expect(new Set(keys).size).toBe(keys.length)
    expect(actionKey("session.sign_in")).toBe("session_sign_in")
  })
})

describe("auditCodesMatching", () => {
  it("finds the actions whose English label holds the text, case-insensitive", () => {
    expect(auditCodesMatching("en", "Changed The").actions.sort()).toEqual(
      ["account.password_change", "item.update", "note.update", "project.update"].sort(),
    )
    expect(auditCodesMatching("en", "created the item")).toEqual({ actions: ["item.create"], entityTypes: [] })
    expect(auditCodesMatching("en", "agent key").entityTypes).toEqual(["api_key"])
  })

  it("finds the actions and entity types whose Hebrew label holds the text", () => {
    expect(auditCodesMatching("he", he.audit.action.item_create).actions).toEqual(["item.create"])
    expect(auditCodesMatching("he", CHANGED_HE).actions.sort()).toEqual(
      ["account.password_change", "item.update", "note.update", "project.update", "settings.update"].sort(),
    )
    expect(auditCodesMatching("he", he.audit.entity.project).entityTypes).toEqual(["project"])
  })

  it("matches only the request's language, and nothing for empty text", () => {
    expect(auditCodesMatching("en", CHANGED_HE)).toEqual({ actions: [], entityTypes: [] })
    expect(auditCodesMatching("he", "changed")).toEqual({ actions: [], entityTypes: [] })
    expect(auditCodesMatching("en", "   ")).toEqual({ actions: [], entityTypes: [] })
  })
})
