import { eq, sql } from "drizzle-orm"
import type { TelegramOutcome } from "../../shared/enums.ts"
import { UI_ROUTES, uiUrl } from "../../shared/routes.ts"
import { telegramUpdates } from "../db/schema.ts"
import { AppError } from "../errors.ts"
import { log } from "../log.ts"
import { getSettings } from "../services/admin.ts"
import { type By, type Ctx, inLinkTx, inTx } from "../services/context.ts"
import { captureItemTx } from "../services/items.ts"
import { moveCaptureToNoteTx } from "../services/notes.ts"
import { type BotApi, type InlineKeyboard, TelegramError, type TelegramUpdate } from "./api.ts"
import { fill, html, link, oneLine, type TelegramHtml } from "./html.ts"
import { telegramTexts } from "./texts.ts"

/** The bot's actor: it captures into the inbox and, on the owner's press, moves a capture into a note. */
export const BOT: By = { actor: { kind: "bot", label: "telegram" }, source: "telegram" }

/** What an update asks for. Pure: decided from the update and the owner's chat id only. */
export type UpdateKind =
  | { kind: "stranger" }
  | { kind: "not_text" }
  | { kind: "command" }
  | { kind: "capture"; text: string }
  /** The owner pressed "Make it a note" under a capture's reply; `captureId` is null for data the bot never wrote. */
  | { kind: "to_note"; callbackId: string; messageId: number; captureId: number | null }

/** The data of the button under a capture's reply: the capture's own update_id. */
export const NOTE_BUTTON = /^note:(\d{1,15})$/
export const noteButtonData = (captureUpdateId: number) => `note:${captureUpdateId}`

const COMMAND = /^\/[A-Za-z0-9_]+(@[A-Za-z0-9_]+)?(\s|$)/

export function classifyUpdate(update: TelegramUpdate, ownerChatId: string): UpdateKind {
  const press = update.callback_query
  if (press) {
    // Only the owner, pressing in the owner's chat; anyone else gets no answer, as with messages.
    if (String(press.from.id) !== ownerChatId || press.from.is_bot || String(press.message?.chat.id) !== ownerChatId)
      return { kind: "stranger" }
    const match = NOTE_BUTTON.exec(press.data ?? "")
    return {
      kind: "to_note",
      callbackId: press.id,
      messageId: press.message?.message_id ?? 0,
      captureId: match ? Number(match[1]) : null,
    }
  }
  const message = update.message
  // Other chats get no answer at all: the bot does not reveal that it serves anyone.
  if (!message || String(message.chat.id) !== ownerChatId || message.from?.is_bot) return { kind: "stranger" }
  if (typeof message.text !== "string" || !message.text.trim()) return { kind: "not_text" }
  // /start, /help and any other command answer with the help text; a command is never filed.
  if (COMMAND.test(message.text)) return { kind: "command" }
  return { kind: "capture", text: message.text }
}

/** What to tell Telegram about a press after the commit: the short answer, and whether the button goes. */
export type PressAnswer = { callbackId: string; messageId: number; text: string; removeButton: boolean }

export type UpdateResult =
  | { duplicate: true }
  | {
      duplicate: false
      outcome: TelegramOutcome
      itemId: string | null
      reply: TelegramHtml | null
      /** Buttons under the reply: "Make it a note" under a capture's. */
      replyMarkup?: InlineKeyboard
      press?: PressAnswer
    }

/** Plain text for a press's answer (Telegram shows it as is): the template with the title on one short line. */
function plain(template: string, values: Record<string, string> = {}): string {
  return template.replace(/\{(\w+)\}/g, (all, key: string) => values[key] ?? all)
}

/**
 * Records one update in one transaction: its `update_id` row and, for the owner's text, the inbox item with
 * its audit row. A repeated `update_id` does nothing. The reply is returned to be sent after the commit.
 */
export async function handleUpdate(
  ctx: Ctx,
  options: { chatId: string; publicUrl: URL },
  update: TelegramUpdate,
): Promise<UpdateResult> {
  const kind = classifyUpdate(update, options.chatId)
  // A press moves an item: its transaction takes the link structure lock first, as an item delete does, so the
  // two never wait on each other's rows (plan review P15).
  const run = kind.kind === "to_note" ? inLinkTx : inTx
  return run(ctx, async (tx): Promise<UpdateResult> => {
    const [claimed] = await tx
      .insert(telegramUpdates)
      .values({ updateId: update.update_id, outcome: "ignored", at: ctx.clock() })
      .onConflictDoNothing()
      .returning()
    if (!claimed) return { duplicate: true }
    if (kind.kind === "stranger") return { duplicate: false, outcome: "ignored", itemId: null, reply: null }

    const t = telegramTexts((await getSettings(tx)).language)
    if (kind.kind === "not_text") return { duplicate: false, outcome: "ignored", itemId: null, reply: fill(t.onlyText) }
    if (kind.kind === "command")
      return { duplicate: false, outcome: "ignored", itemId: null, reply: fill(t.help, { inbox: t.inbox }) }

    if (kind.kind === "to_note") {
      let outcome: TelegramOutcome = "refused"
      let text = t.noteUnknown
      let removeButton = false
      let reply: TelegramHtml | null = null
      if (kind.captureId !== null) {
        const captureId = kind.captureId
        try {
          // A savepoint: a refusal leaves the update row in place, as a capture's does.
          const moved = await tx.transaction((sp) => moveCaptureToNoteTx(ctx, sp, BOT, captureId, t.movedComment))
          if (moved.kind === "moved") {
            outcome = "note_created"
            text = plain(t.movedToNote, { title: oneLine(moved.note.title, 80) })
            removeButton = true
            const href = uiUrl(options.publicUrl, UI_ROUTES.note(moved.note.id))
            reply = html`${fill(t.movedToNote, { title: oneLine(moved.note.title, 80) })} ${link(href, t.open)}`
          } else if (moved.kind === "already") {
            outcome = "ignored"
            text = t.alreadyNote
            removeButton = true
          } else if (moved.kind === "changed") {
            text = t.itemChanged
            removeButton = true
          }
        } catch (error) {
          if (!(error instanceof AppError) || error.code !== "secret_suspected") throw error
          text = t.refusedSecretNote
        }
      }
      await tx.update(telegramUpdates).set({ outcome }).where(eq(telegramUpdates.updateId, update.update_id))
      return {
        duplicate: false,
        outcome,
        itemId: null,
        reply,
        press: { callbackId: kind.callbackId, messageId: kind.messageId, text, removeButton },
      }
    }

    let outcome: TelegramOutcome
    let reply: TelegramHtml
    let itemId: string | null = null
    try {
      // A savepoint: a refusal leaves the update row in place.
      const item = await tx.transaction((sp) => captureItemTx(ctx, sp, BOT, { text: kind.text }))
      outcome = "item_created"
      itemId = item.id
      const href = uiUrl(options.publicUrl, UI_ROUTES.item(item.id))
      reply = html`${fill(t.saved, { inbox: t.inbox, title: oneLine(item.title, 80) })} ${link(href, t.open)}`
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "secret_suspected") throw error
      // Never echo the text: it may hold the secret.
      outcome = "refused"
      reply = fill(t.refusedSecret)
    }
    // The capture keeps its item, so the button under the reply can only ever move this item.
    await tx.update(telegramUpdates).set({ outcome, itemId }).where(eq(telegramUpdates.updateId, update.update_id))
    const replyMarkup: InlineKeyboard | undefined = itemId
      ? { inline_keyboard: [[{ text: t.toNote, callback_data: noteButtonData(update.update_id) }]] }
      : undefined
    return { duplicate: false, outcome, itemId, reply, replyMarkup }
  })
}

/** When the bot last recorded an update, for the status route. */
export async function lastUpdateAt(ctx: Ctx): Promise<Date | null> {
  const [row] = await ctx.db.select({ at: sql<string | null>`max(${telegramUpdates.at})` }).from(telegramUpdates)
  const at = row?.at
  return at ? new Date(at) : null
}

export type BotOptions = {
  ctx: Ctx
  api: BotApi
  chatId: string
  publicUrl: URL
  /** Seconds a getUpdates call waits for an update (Telegram's long polling). */
  pollTimeoutSeconds?: number
  /** Pause after a failed poll or a failed update, before trying again. */
  retryDelayMs?: number
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    signal.addEventListener("abort", done, { once: true })
  })
}

const errorCode = (error: unknown) =>
  error instanceof TelegramError ? error.code : error instanceof Error ? error.name : "unknown"

/**
 * Long polling. The next `offset` is the highest committed `update_id` + 1, so Telegram forgets an update
 * only after its transaction committed. A failed update stops its batch; the next poll fetches it again.
 */
export class TelegramBot {
  private offset: number | undefined
  private loop: Promise<void> | undefined
  private readonly stopping = new AbortController()
  /** True while the latest getUpdates call succeeded. */
  polling = false

  constructor(private readonly options: BotOptions) {}

  start(): void {
    log.info("telegram bot polling")
    this.loop = this.run()
  }

  async stop(): Promise<void> {
    this.stopping.abort()
    await this.loop
    this.polling = false
  }

  private async run(): Promise<void> {
    const { api, ctx, chatId, publicUrl } = this.options
    const signal = this.stopping.signal
    const retryDelay = this.options.retryDelayMs ?? 5_000
    while (!signal.aborted) {
      let updates: TelegramUpdate[]
      try {
        updates = await api.getUpdates(this.offset, this.options.pollTimeoutSeconds ?? 50, signal)
        this.polling = true
      } catch (error) {
        if (signal.aborted) break
        this.polling = false
        log.warn("telegram polling failed", { code: errorCode(error) })
        const wait = error instanceof TelegramError && error.retryAfter ? error.retryAfter * 1000 : retryDelay
        await pause(wait, signal)
        continue
      }

      for (const update of [...updates].sort((a, b) => a.update_id - b.update_id)) {
        if (signal.aborted) break
        let result: UpdateResult
        try {
          result = await handleUpdate(ctx, { chatId, publicUrl }, update)
        } catch (error) {
          log.error("telegram update not recorded; it is fetched again", {
            updateId: update.update_id,
            error: errorCode(error),
          })
          await pause(retryDelay, signal)
          break
        }
        this.offset = Math.max(this.offset ?? 0, update.update_id + 1)
        if (result.duplicate) continue
        if (result.outcome !== "ignored" || result.reply)
          log.info("telegram update", { updateId: update.update_id, outcome: result.outcome })
        // After the commit, each on its own: a failure here is logged and never repeats the change (P6).
        if (result.press) {
          const press = result.press
          try {
            await api.answerCallbackQuery(press.callbackId, press.text, signal)
          } catch (error) {
            log.warn("telegram press answer failed", { updateId: update.update_id, code: errorCode(error) })
          }
          if (press.removeButton)
            try {
              await api.removeButtons(chatId, press.messageId, signal)
            } catch (error) {
              log.warn("telegram button removal failed", { updateId: update.update_id, code: errorCode(error) })
            }
        }
        if (result.reply) {
          try {
            await api.sendMessage(chatId, result.reply, signal, result.replyMarkup)
          } catch (error) {
            log.warn("telegram reply failed", { updateId: update.update_id, code: errorCode(error) })
          }
        }
      }
    }
  }
}
