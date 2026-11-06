import { describe, expect, it } from "vitest"
import { testBotToken } from "../testing/secrets.ts"
import { BotApi, type FetchLike, TelegramError } from "./api.ts"
import { classifyUpdate } from "./bot.ts"
import { fill, html, oneLine } from "./html.ts"

// New on every run (src/server/testing/secrets.ts).
const TOKEN = testBotToken()
const OWNER_CHAT = "4242"

describe("Telegram HTML", () => {
  it("escapes values and locale text, and keeps its own markup", () => {
    expect(String(html`<b>${"<i>&</i>"}</b>`)).toBe("<b>&lt;i&gt;&amp;&lt;/i&gt;</b>")
    expect(String(fill("A < {name} & {missing}", { name: html`<b>${"x"}</b>` }))).toBe(
      "A &lt; <b>x</b> &amp; {missing}",
    )
  })

  it("keeps one line of plain text without control or bidirectional characters", () => {
    expect(oneLine("a\u202Eb\u2066c\u200Fd\u061Ce\n\tf")).toBe("a b c d e f")
    expect(oneLine("abcdef", 4)).toBe("abc…")
  })
})

const message = (chatId: number | string, extra: Record<string, unknown> = {}) => ({
  update_id: 1,
  message: { message_id: 1, date: 0, chat: { id: Number(chatId), type: "private" }, ...extra },
})

describe("classifyUpdate", () => {
  it("captures the owner's plain text", () => {
    expect(classifyUpdate(message(OWNER_CHAT, { text: "Try a dark theme" }), OWNER_CHAT)).toEqual({
      kind: "capture",
      text: "Try a dark theme",
    })
  })

  it("answers commands with help and never files them", () => {
    for (const text of ["/start", "/help", "/help@mikud_bot", "/settings now"])
      expect(classifyUpdate(message(OWNER_CHAT, { text }), OWNER_CHAT)).toEqual({ kind: "command" })
    expect(classifyUpdate(message(OWNER_CHAT, { text: "/ not a command" }), OWNER_CHAT).kind).toBe("capture")
  })

  it("treats other chats, bots and updates without a message as strangers", () => {
    expect(classifyUpdate(message(999, { text: "hello" }), OWNER_CHAT)).toEqual({ kind: "stranger" })
    expect(classifyUpdate(message(-4242, { text: "hello" }), OWNER_CHAT)).toEqual({ kind: "stranger" })
    expect(classifyUpdate(message(OWNER_CHAT, { text: "hi", from: { id: 1, is_bot: true } }), OWNER_CHAT)).toEqual({
      kind: "stranger",
    })
    expect(classifyUpdate({ update_id: 2 }, OWNER_CHAT)).toEqual({ kind: "stranger" })
  })

  it("does not file the owner's photos or empty text", () => {
    expect(classifyUpdate(message(OWNER_CHAT, { photo: [] }), OWNER_CHAT)).toEqual({ kind: "not_text" })
    expect(classifyUpdate(message(OWNER_CHAT, { text: "   " }), OWNER_CHAT)).toEqual({ kind: "not_text" })
  })
})

function fakeFetch(answer: (url: string, init: RequestInit) => Promise<Response>) {
  const calls: { url: string; body: unknown }[] = []
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, body: JSON.parse(String(init.body)) })
    return answer(url, init)
  }
  return { impl, calls }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

async function failure(promise: Promise<unknown>): Promise<TelegramError> {
  const error = (await promise.then(
    () => new Error("the call succeeded"),
    (e: unknown) => e,
  )) as TelegramError
  expect(error).toBeInstanceOf(TelegramError)
  expect(String(error.message)).not.toContain(TOKEN)
  expect(JSON.stringify(error)).not.toContain(TOKEN)
  return error
}

describe("BotApi", () => {
  it("sends HTML without a link preview and long-polls only messages", async () => {
    const fetch = fakeFetch(async (url) =>
      json({ ok: true, result: url.endsWith("/getUpdates") ? [] : { message_id: 7 } }),
    )
    const api = new BotApi(TOKEN, "https://api.example.org/", fetch.impl)
    expect(await api.sendMessage(OWNER_CHAT, html`<b>${"hi"}</b>`)).toBe(7)
    expect(await api.getUpdates(12, 50)).toEqual([])
    expect(fetch.calls).toEqual([
      {
        url: `https://api.example.org/bot${TOKEN}/sendMessage`,
        body: {
          chat_id: OWNER_CHAT,
          text: "<b>hi</b>",
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        },
      },
      {
        url: `https://api.example.org/bot${TOKEN}/getUpdates`,
        body: { offset: 12, timeout: 50, allowed_updates: ["message", "callback_query"] },
      },
    ])
  })

  it("classifies failures without the token in any message", async () => {
    const answer = (body: unknown, status: number) =>
      new BotApi(TOKEN, "https://x.example", async () => json(body, status))
    const refused = await failure(
      answer({ ok: false, error_code: 400, description: "Bad Request" }, 400).sendMessage("1", html`x`),
    )
    expect(refused).toMatchObject({ failure: "answer", code: "telegram_400" })
    const limited = await failure(
      answer({ ok: false, error_code: 429, parameters: { retry_after: 3 } }, 429).sendMessage("1", html`x`),
    )
    expect(limited).toMatchObject({ failure: "answer", code: "telegram_429", retryAfter: 3 })
    // A gateway's page or Telegram's own 5xx may hide a message that went out: never definite.
    const gateway = new BotApi(TOKEN, "https://x.example", async () => new Response("<html>", { status: 502 }))
    expect(await failure(gateway.sendMessage("1", html`x`))).toMatchObject({
      failure: "uncertain",
      code: "telegram_502",
    })
    const serverError = await failure(
      answer({ ok: false, error_code: 500, description: "Internal" }, 500).sendMessage("1", html`x`),
    )
    expect(serverError).toMatchObject({ failure: "uncertain", code: "telegram_500" })
    const foreignJson = await failure(answer({ message: "Bad request" }, 400).sendMessage("1", html`x`))
    expect(foreignJson).toMatchObject({ failure: "uncertain", code: "telegram_400" })
    const garbled = new BotApi(TOKEN, "https://x.example", async () => new Response("not json", { status: 200 }))
    expect(await failure(garbled.sendMessage("1", html`x`))).toMatchObject({ failure: "uncertain" })

    const refusedConnection = new BotApi(TOKEN, "https://x.example", async () => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error(`connect ${TOKEN}`), { code: "ECONNREFUSED" }),
      })
    })
    expect(await failure(refusedConnection.sendMessage("1", html`x`))).toMatchObject({
      failure: "not_sent",
      code: "network",
    })
    const reset = new BotApi(TOKEN, "https://x.example", async () => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
      })
    })
    expect(await failure(reset.sendMessage("1", html`x`))).toMatchObject({ failure: "uncertain", code: "network" })

    const stop = new AbortController()
    const hanging = new BotApi(TOKEN, "https://x.example", (_url, init) => {
      return new Promise((_resolve, reject) =>
        init.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      )
    })
    const pending = hanging.getUpdates(undefined, 50, stop.signal)
    stop.abort()
    expect(await failure(pending)).toMatchObject({ failure: "aborted" })
  })
})
