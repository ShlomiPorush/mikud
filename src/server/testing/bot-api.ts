import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo, Socket } from "node:net"
import type { TelegramUpdate } from "../telegram/api.ts"

export type SentMessage = {
  chatId: string
  text: string
  parseMode: string | undefined
  linkPreview: unknown
  /** The buttons under the message, as sent. */
  replyMarkup?: { inline_keyboard: { text: string; callback_data: string }[][] }
}

/** How the stand-in answers the next sendMessage: an error status, or a dropped connection (no answer). */
export type SendFailure = number | "drop"

/**
 * A stand-in for the Telegram Bot API on 127.0.0.1, for tests. It serves `getUpdates` (long polling, with
 * Telegram's offset semantics: an offset confirms every update below it), and records `sendMessage`,
 * `answerCallbackQuery` and `editMessageReplyMarkup`; each of the three can be made to fail.
 * Requests with another token answer 401 like Telegram.
 */
export class StandInBotApi {
  /** Messages the bot sent, in order. */
  readonly sent: SentMessage[] = []
  /** The `offset` of every getUpdates call, in order (undefined when none was sent). */
  readonly offsets: (number | undefined)[] = []
  /** Answers for the next sendMessage calls, used up in order. */
  readonly sendFailures: SendFailure[] = []
  /** Error statuses for the next getUpdates calls, used up in order. */
  readonly pollFailures: number[] = []
  /** Answers to button presses, in order. */
  readonly pressAnswers: { callbackQueryId: string; text: string }[] = []
  /** Messages whose buttons were taken off, in order. */
  readonly buttonsRemoved: { chatId: string; messageId: number }[] = []
  /** Answers for the next answerCallbackQuery and editMessageReplyMarkup calls, used up in order. */
  readonly pressFailures: SendFailure[] = []
  readonly removeFailures: SendFailure[] = []
  private pending: TelegramUpdate[] = []
  private waiters = new Set<() => void>()
  private readonly sockets = new Set<Socket>()

  private constructor(
    private readonly server: Server,
    readonly token: string,
    readonly url: string,
  ) {
    server.on("connection", (socket) => {
      this.sockets.add(socket)
      socket.on("close", () => this.sockets.delete(socket))
    })
  }

  static async start(token: string): Promise<StandInBotApi> {
    let api: StandInBotApi | undefined
    const server = createServer((req, res) => void api?.handle(req, res))
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const { port } = server.address() as AddressInfo
    api = new StandInBotApi(server, token, `http://127.0.0.1:${port}`)
    return api
  }

  /** Queues an update, as if someone wrote to the bot. A repeated update_id is delivered again. */
  push(...updates: TelegramUpdate[]): void {
    this.pending.push(...updates)
    for (const wake of this.waiters) wake()
  }

  /** Updates not yet confirmed by an offset. */
  unconfirmed(): number[] {
    return this.pending.map((u) => u.update_id)
  }

  reset(): void {
    this.sent.length = 0
    this.offsets.length = 0
    this.sendFailures.length = 0
    this.pollFailures.length = 0
    this.pressAnswers.length = 0
    this.buttonsRemoved.length = 0
    this.pressFailures.length = 0
    this.removeFailures.length = 0
    this.pending = []
  }

  async close(): Promise<void> {
    for (const wake of this.waiters) wake()
    for (const socket of this.sockets) socket.destroy()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}
    const match = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? "")
    const answer = (status: number, payload: unknown) => {
      if (res.destroyed) return
      res.writeHead(status, { "content-type": "application/json" })
      res.end(JSON.stringify(payload))
    }
    if (!match || match[1] !== this.token)
      return answer(401, { ok: false, error_code: 401, description: "Unauthorized" })

    if (match[2] === "sendMessage") {
      const failure = this.sendFailures.shift()
      if (failure === "drop") return req.socket.destroy()
      if (failure !== undefined)
        return answer(failure, { ok: false, error_code: failure, description: "stand-in failure" })
      this.sent.push({
        chatId: String(body.chat_id),
        text: String(body.text),
        parseMode: body.parse_mode,
        linkPreview: body.link_preview_options,
        ...(body.reply_markup ? { replyMarkup: body.reply_markup } : {}),
      })
      return answer(200, { ok: true, result: { message_id: this.sent.length } })
    }

    if (match[2] === "answerCallbackQuery" || match[2] === "editMessageReplyMarkup") {
      const press = match[2] === "answerCallbackQuery"
      const failure = (press ? this.pressFailures : this.removeFailures).shift()
      if (failure === "drop") return req.socket.destroy()
      if (failure !== undefined)
        return answer(failure, { ok: false, error_code: failure, description: "stand-in failure" })
      if (press) this.pressAnswers.push({ callbackQueryId: String(body.callback_query_id), text: String(body.text) })
      else this.buttonsRemoved.push({ chatId: String(body.chat_id), messageId: Number(body.message_id) })
      return answer(200, { ok: true, result: true })
    }

    if (match[2] === "getUpdates") {
      const offset = typeof body.offset === "number" ? body.offset : undefined
      this.offsets.push(offset)
      const failure = this.pollFailures.shift()
      if (failure !== undefined)
        return answer(failure, { ok: false, error_code: failure, description: "stand-in failure" })
      if (offset !== undefined) this.pending = this.pending.filter((u) => u.update_id >= offset)
      if (this.pending.length === 0) await this.waitForUpdate(Number(body.timeout ?? 0) * 1000, res)
      return answer(200, { ok: true, result: this.pending.slice(0, 100) })
    }

    return answer(404, { ok: false, error_code: 404, description: "Not Found" })
  }

  /** Long polling: returns when an update arrives, the timeout passes or the client goes away. */
  private waitForUpdate(timeoutMs: number, res: ServerResponse): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this.waiters.delete(done)
        res.off("close", done)
        resolve()
      }
      const timer = setTimeout(done, timeoutMs)
      this.waiters.add(done)
      res.on("close", done)
    })
  }
}

/** Waits until `check` returns true, polling every 20 ms; fails after `timeoutMs`. */
export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > until) throw new Error("waitFor timed out")
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
