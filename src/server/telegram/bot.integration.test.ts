import { eq } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import en from "../../shared/locales/en.json"
import he from "../../shared/locales/he.json"
import { createApp } from "../app.ts"
import { audit, comments, items, jobRuns, notes, telegramUpdates } from "../db/schema.ts"
import { updateSettings } from "../services/admin.ts"
import type { Ctx } from "../services/context.ts"
import { deleteItem, updateItem } from "../services/items.ts"
import type { ReloadableSecretScanner } from "../services/secrets.ts"
import { createAgentKey, ownerBrowser, testCore } from "../testing/app.ts"
import { StandInBotApi, waitFor } from "../testing/bot-api.ts"
import { createTestDatabase, owner, type TestDatabase } from "../testing/db.ts"
import { testBotToken } from "../testing/secrets.ts"
import { BotApi, type TelegramUpdate } from "./api.ts"
import { handleUpdate, TelegramBot } from "./bot.ts"

// New on every run (src/server/testing/secrets.ts).
const TOKEN = testBotToken()
const OWNER_CHAT = "4242"
const PUBLIC_URL = new URL("http://127.0.0.1:8090")

let t: TestDatabase
let standIn: StandInBotApi
let bot: TelegramBot | undefined
const logged: string[] = []

const text = (updateId: number, body: string, chatId = OWNER_CHAT): TelegramUpdate => ({
  update_id: updateId,
  message: {
    message_id: updateId,
    date: 0,
    chat: { id: Number(chatId), type: "private" },
    from: { id: Number(chatId), is_bot: false },
    text: body,
  },
})

function startBot(ctx: Ctx = t.ctx, apiUrl = standIn.url) {
  bot = new TelegramBot({
    ctx,
    api: new BotApi(TOKEN, apiUrl),
    chatId: OWNER_CHAT,
    publicUrl: PUBLIC_URL,
    pollTimeoutSeconds: 1,
    retryDelayMs: 50,
  })
  bot.start()
  return bot
}

const allItems = () => t.ctx.db.select().from(items)
const outcome = async (updateId: number) =>
  (await t.ctx.db.select().from(telegramUpdates).where(eq(telegramUpdates.updateId, updateId)))[0]?.outcome
/** True once the bot has asked for updates after `updateId`: everything up to it was handled. */
const confirmed = (updateId: number) => () => standIn.offsets.some((o) => o !== undefined && o > updateId)

beforeAll(async () => {
  for (const method of ["log", "error"] as const)
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "))
    })
  t = await createTestDatabase("telegram")
  standIn = await StandInBotApi.start(TOKEN)
})
afterAll(async () => {
  await standIn?.close()
  await t?.close()
  vi.restoreAllMocks()
})
beforeEach(async () => {
  await t.reset()
  standIn.reset()
  await updateSettings(t.ctx, owner, { language: "en" })
})
afterEach(async () => {
  await bot?.stop()
  bot = undefined
})

describe("Telegram bot", () => {
  it("files the owner's text in the inbox with an audit row and answers with a link to it", async () => {
    startBot()
    standIn.push(text(100, "Try a darker theme\nwith more contrast"))
    await waitFor(() => standIn.sent.length === 1)

    const [item] = await allItems()
    expect(item).toMatchObject({
      projectId: null,
      type: "idea",
      status: "future",
      title: "Try a darker theme",
      body: "Try a darker theme\nwith more contrast",
      createdBy: "bot",
    })
    const [entry] = await t.ctx.db
      .select()
      .from(audit)
      .where(eq(audit.entityId, item?.id ?? ""))
    expect(entry).toMatchObject({ action: "item.create", actorKind: "bot", actorLabel: "telegram", source: "telegram" })
    expect(await outcome(100)).toBe("item_created")
    expect(standIn.sent[0]).toEqual({
      chatId: OWNER_CHAT,
      text: `Saved under Inbox: Try a darker theme <a href="http://127.0.0.1:8090/items/${item?.id}">Open</a>`,
      parseMode: "HTML",
      linkPreview: { is_disabled: true },
      replyMarkup: { inline_keyboard: [[{ text: en.telegram.toNote, callback_data: "note:100" }]] },
    })
    await waitFor(confirmed(100))
    expect(bot?.polling).toBe(true)
  })

  it("does nothing for a repeated update_id", async () => {
    startBot()
    standIn.push(text(200, "Only once"), text(200, "Only once"))
    await waitFor(confirmed(200))
    standIn.push(text(200, "Only once"))
    standIn.push(text(201, "Marker"))
    await waitFor(confirmed(201))
    expect((await allItems()).map((i) => i.title).sort()).toEqual(["Marker", "Only once"])
    expect(standIn.sent).toHaveLength(2)
  })

  it("files nothing twice when the server stopped after the commit and before the offset moved on", async () => {
    // The first process committed update 300 and stopped before its next poll, so Telegram still holds it.
    standIn.push(text(300, "Written before the crash"))
    const first = await handleUpdate(t.ctx, { chatId: OWNER_CHAT, publicUrl: PUBLIC_URL }, text(300, "x"))
    expect(first).toMatchObject({ duplicate: false, outcome: "item_created" })

    startBot()
    await waitFor(confirmed(300))
    expect(await allItems()).toHaveLength(1)
    expect(standIn.sent).toHaveLength(0)
    expect(standIn.unconfirmed()).toEqual([])
  })

  it("acknowledges an update only after its transaction committed", async () => {
    // The secret check fails unexpectedly once: the transaction rolls back and the update is fetched again.
    let failures = 1
    const flaky: Ctx = {
      ...t.ctx,
      secrets: {
        redact: (value: string) => t.ctx.secrets.redact(value),
        find: (value: string) => {
          if (failures-- > 0) throw new Error("database went away")
          return t.ctx.secrets.find(value)
        },
      },
    }
    startBot(flaky)
    standIn.push(text(400, "Survives a failed attempt"))
    await waitFor(() => standIn.sent.length === 1)
    expect(await allItems()).toHaveLength(1)
    expect(await outcome(400)).toBe("item_created")
    // Polls before the success still asked from the start: the failed update was not acknowledged.
    const beforeSuccess = standIn.offsets.slice(0, standIn.offsets.indexOf(401))
    expect(beforeSuccess.every((o) => o === undefined || o <= 400)).toBe(true)
  })

  it("ignores other chats without answering", async () => {
    startBot()
    standIn.push(text(500, "Let me in", "999"))
    await waitFor(confirmed(500))
    expect(await allItems()).toHaveLength(0)
    expect(await outcome(500)).toBe("ignored")
    expect(standIn.sent).toHaveLength(0)
  })

  it("refuses text that looks like a secret, says why in Hebrew, and never echoes it", async () => {
    await updateSettings(t.ctx, owner, { language: "he" })
    startBot()
    const secret = `${"gh"}p_${"A1b2C3d4E5".repeat(4)}`
    standIn.push(text(600, `deploy key ${secret}`))
    await waitFor(() => standIn.sent.length === 1)
    expect(await allItems()).toHaveLength(0)
    expect(await outcome(600)).toBe("refused")
    expect(standIn.sent[0]?.text).toBe(he.telegram.refusedSecret)
    expect(JSON.stringify(standIn.sent)).not.toContain(secret)
  })

  it("answers /start and /help with the help text and photos with a short note", async () => {
    startBot()
    standIn.push(text(700, "/start"), text(701, "/help"), {
      update_id: 702,
      message: { message_id: 702, date: 0, chat: { id: Number(OWNER_CHAT), type: "private" } },
    })
    await waitFor(() => standIn.sent.length === 3)
    expect(standIn.sent.map((m) => m.text)).toEqual([
      "Send me any text and I will save it in Mikud, under Inbox. Every morning, Sunday to Friday at 08:00, I send you what is waiting on you.",
      "Send me any text and I will save it in Mikud, under Inbox. Every morning, Sunday to Friday at 08:00, I send you what is waiting on you.",
      "I save text messages only. Nothing was saved.",
    ])
    expect(await allItems()).toHaveLength(0)
  })

  it("keeps polling after Bot API errors and an unreachable server", async () => {
    standIn.pollFailures.push(500, 502)
    standIn.sendFailures.push(400)
    startBot()
    standIn.push(text(800, "After the errors"))
    await waitFor(() => standIn.offsets.length >= 3)
    await waitFor(confirmed(800))
    expect(await allItems()).toHaveLength(1)
    expect(standIn.sent).toHaveLength(0) // the one reply was refused with 400 and is not retried
    await bot?.stop()

    // Nothing listens on the stand-in's port once it is closed: use a port that refuses connections.
    const closed = await StandInBotApi.start(TOKEN)
    const deadUrl = closed.url
    await closed.close()
    const lost = startBot(t.ctx, deadUrl)
    await waitFor(() => logged.some((line) => line.includes("telegram polling failed") && line.includes("network")))
    expect(lost.polling).toBe(false)
  })

  it("reports its status to the owner only", async () => {
    startBot()
    standIn.push(text(900, "Status check"))
    await waitFor(() => standIn.sent.length === 1)
    await t.ctx.db.insert(jobRuns).values({ job: "morning", localDate: "2026-11-01", state: "sent" })
    const running = bot
    const app = (telegram?: { configured: boolean; polling: () => boolean }) => {
      const core = testCore(t, { config: { publicUrl: PUBLIC_URL, version: "test" }, telegram })
      return { core, app: createApp({ checkDatabase: async () => true, core }) }
    }
    const asOwner = async (a: ReturnType<typeof app>) =>
      (await ownerBrowser(t, a.app)).call("GET", "/api/v1/telegram/status")

    const on = app({ configured: true, polling: () => running?.polling ?? false })
    const res = await asOwner(on)
    expect(res.status).toBe(200)
    const data = res.json.data as Record<string, unknown>
    expect(data).toMatchObject({
      configured: true,
      polling: true,
      lastMorning: { localDate: "2026-11-01", state: "sent" },
    })
    expect(typeof data.lastUpdateAt).toBe("string")
    const key = await createAgentKey(on.core)
    const agent = await on.app.request("/api/v1/telegram/status", { headers: { authorization: `Bearer ${key}` } })
    expect(agent.status).toBe(403)

    const off = await asOwner(app(undefined))
    expect(off.json.data).toMatchObject({ configured: false, polling: false })
  })

  it("never logs the bot token or message text", () => {
    expect(logged.length).toBeGreaterThan(0)
    const all = logged.join("\n")
    expect(all).not.toContain(TOKEN)
    expect(all).not.toContain(TOKEN.split(":")[1])
    for (const words of ["darker theme", "Let me in", "deploy key", "After the errors", "Survives"])
      expect(all).not.toContain(words)
  })
})

describe("Make it a note", () => {
  const CHAT = { id: Number(OWNER_CHAT), type: "private" }
  /** A press on the button under the bot's reply to a capture. */
  const press = (updateId: number, data: string, from = OWNER_CHAT, messageId = 1): TelegramUpdate => ({
    update_id: updateId,
    callback_query: {
      id: `press-${updateId}`,
      from: { id: Number(from), is_bot: false },
      message: { message_id: messageId, date: 0, chat: { ...CHAT, id: Number(from) } },
      data,
    },
  })
  const options = { chatId: OWNER_CHAT, publicUrl: PUBLIC_URL }
  const capture = (updateId: number, body: string) => handleUpdate(t.ctx, options, text(updateId, body))
  const allNotes = () => t.ctx.db.select().from(notes)
  const captureRow = async (updateId: number) =>
    (await t.ctx.db.select().from(telegramUpdates).where(eq(telegramUpdates.updateId, updateId)))[0]

  it("puts the button under a capture's reply, naming that capture", async () => {
    startBot()
    standIn.push(text(1000, "Ask the vendor about the warranty"))
    await waitFor(() => standIn.sent.length === 1)
    expect(standIn.sent[0]?.replyMarkup).toEqual({
      inline_keyboard: [[{ text: "Make it a note", callback_data: "note:1000" }]],
    })
    const [item] = await allItems()
    expect(await captureRow(1000)).toMatchObject({ outcome: "item_created", itemId: item?.id, noteId: null })
  })

  it("moves the capture into a general note, closes the item with a comment that links it, all at once", async () => {
    await capture(1100, "Warranty\nThe vendor covers two years.")
    startBot()
    standIn.push(press(1101, "note:1100", OWNER_CHAT, 7))
    await waitFor(() => standIn.sent.length === 1 && standIn.buttonsRemoved.length === 1)

    const [note] = await allNotes()
    expect(note).toMatchObject({
      projectId: null,
      title: "Warranty",
      body: "The vendor covers two years.",
      createdBy: "bot",
      version: 1,
    })
    const [item] = await allItems()
    expect(item).toMatchObject({ status: "not_relevant", version: 2, statusSetBy: "bot" })
    const [comment] = await t.ctx.db.select().from(comments)
    expect(comment).toMatchObject({
      itemId: item?.id,
      noteId: note?.id,
      authorKind: "bot",
      text: en.telegram.movedComment,
    })
    expect(await captureRow(1100)).toMatchObject({ noteId: note?.id })
    expect(await outcome(1101)).toBe("note_created")
    const actions = (await t.ctx.db.select().from(audit)).map((row) => row.action)
    expect(actions).toEqual(expect.arrayContaining(["note.create", "item.update", "comment.create"]))
    expect(standIn.pressAnswers).toEqual([{ callbackQueryId: "press-1101", text: "Saved as a general note: Warranty" }])
    expect(standIn.buttonsRemoved).toEqual([{ chatId: OWNER_CHAT, messageId: 7 }])
    expect(standIn.sent[0]?.text).toBe(
      `Saved as a general note: Warranty <a href="http://127.0.0.1:8090/notes/${note?.id}">Open</a>`,
    )
  })

  it("moves once: a second press, two presses at once, and a redelivered press make one note", async () => {
    await capture(1200, "One note only")
    const results = await Promise.all([
      handleUpdate(t.ctx, options, press(1201, "note:1200")),
      handleUpdate(t.ctx, options, press(1202, "note:1200")),
    ])
    expect(results.map((r) => !r.duplicate && r.outcome).sort()).toEqual(["ignored", "note_created"])
    const again = await handleUpdate(t.ctx, options, press(1203, "note:1200"))
    expect(again).toMatchObject({ outcome: "ignored", press: { text: en.telegram.alreadyNote, removeButton: true } })
    expect(await handleUpdate(t.ctx, options, press(1203, "note:1200"))).toEqual({ duplicate: true })
    expect(await allNotes()).toHaveLength(1)
    expect(await t.ctx.db.select().from(comments)).toHaveLength(1)
  })

  it("leaves an item the owner changed since the capture, and answers why", async () => {
    await capture(1300, "Paint the fence")
    const [item] = await allItems()
    await updateItem(t.ctx, owner, item?.id ?? "", 1, { projectId: null, title: "Paint the fence white" })
    const result = await handleUpdate(t.ctx, options, press(1301, "note:1300"))
    expect(result).toMatchObject({ outcome: "refused", press: { text: en.telegram.itemChanged, removeButton: true } })
    expect(await allNotes()).toHaveLength(0)
    expect((await allItems())[0]).toMatchObject({ status: "future", version: 2 })
  })

  it("moves nothing for a forged or malformed button, or one that names no capture", async () => {
    await capture(1400, "A real capture")
    for (const [id, data] of [
      [1401, "note:999999"],
      [1402, "note:1400; drop table notes"],
      [1403, "item:1400"],
      [1404, ""],
    ] as const) {
      const result = await handleUpdate(t.ctx, options, press(id, data))
      expect(result).toMatchObject({
        outcome: "refused",
        press: { text: en.telegram.noteUnknown, removeButton: false },
      })
    }
    // A press on a message that was no capture (the bot's answer to a command) names no capture either.
    await handleUpdate(t.ctx, options, text(1405, "/help"))
    expect(await handleUpdate(t.ctx, options, press(1406, "note:1405"))).toMatchObject({ outcome: "refused" })
    expect(await allNotes()).toHaveLength(0)
    expect((await allItems())[0]).toMatchObject({ status: "future", version: 1 })
  })

  it("ignores a press from another chat or a bot without answering", async () => {
    await capture(1500, "Mine")
    const stranger = await handleUpdate(t.ctx, options, press(1501, "note:1500", "9999"))
    expect(stranger).toMatchObject({ outcome: "ignored", reply: null })
    expect(stranger).not.toHaveProperty("press")
    const fromBot = press(1502, "note:1500")
    if (fromBot.callback_query) fromBot.callback_query.from.is_bot = true
    expect(await handleUpdate(t.ctx, options, fromBot)).not.toHaveProperty("press")
    expect(await allNotes()).toHaveLength(0)
  })

  it("keeps the move when Telegram fails to take the answer or the button off", async () => {
    await capture(1600, "Answer may fail")
    standIn.pressFailures.push(400)
    standIn.removeFailures.push("drop")
    startBot()
    standIn.push(press(1601, "note:1600"))
    await waitFor(confirmed(1601))
    await waitFor(() => standIn.sent.length === 1)
    expect(await allNotes()).toHaveLength(1)
    expect(await outcome(1601)).toBe("note_created")
    expect(standIn.unconfirmed()).toEqual([])
  })

  it("refuses to move text that now looks like a secret, and changes nothing", async () => {
    // The private domains changed after the capture: the move checks the text again.
    await capture(1700, "Ask ops at build.corp.example")
    ;(t.ctx.secrets as ReloadableSecretScanner).setPrivateDomains(["corp.example"])
    const result = await handleUpdate(t.ctx, options, press(1701, "note:1700"))
    expect(result).toMatchObject({ outcome: "refused", press: { text: en.telegram.refusedSecretNote } })
    expect(await allNotes()).toHaveLength(0)
    expect((await allItems())[0]).toMatchObject({ status: "future", version: 1 })
    expect(await t.ctx.db.select().from(comments)).toHaveLength(0)
    ;(t.ctx.secrets as ReloadableSecretScanner).setPrivateDomains([])
  })

  it("never deadlocks with an item delete of the same item, in either order (P15)", async () => {
    for (const [captureId, first] of [
      [1800, "press"],
      [1810, "delete"],
    ] as const) {
      await capture(captureId, `Race ${captureId}`)
      const item = (await allItems()).find((row) => row.title === `Race ${captureId}`)
      const pressing = () => handleUpdate(t.ctx, options, press(captureId + 1, `note:${captureId}`))
      const deleting = () => deleteItem(t.ctx, owner, item?.id ?? "")
      const results = await Promise.allSettled(first === "press" ? [pressing(), deleting()] : [deleting(), pressing()])
      for (const result of results) expect(result.status).toBe("fulfilled")
      expect((await allItems()).find((row) => row.id === item?.id)).toBeUndefined()
      const moved = await captureRow(captureId)
      const noteCount = (await allNotes()).filter((note) => note.title === `Race ${captureId}`).length
      // Either the press came first (a note, its item deleted after) or the delete did (no note).
      expect(noteCount).toBe(moved?.noteId ? 1 : 0)
    }
  })
})
