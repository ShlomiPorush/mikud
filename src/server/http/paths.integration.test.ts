import { randomBytes } from "node:crypto"
import { request as httpRequest } from "node:http"
import { type AddressInfo, connect } from "node:net"
import { type ServerType, serve } from "@hono/node-server"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createApp, socketAddress } from "../app.ts"
import { createAgentKey, ownerBrowser, type TestCore, testCore } from "../testing/app.ts"
import { TEST_ORIGIN, TestBrowser } from "../testing/browser.ts"
import { createTestDatabase, type TestDatabase } from "../testing/db.ts"
import { clientAddress, RateLimiter } from "./auth.ts"

// Requests that routers, adapters and middleware have handled differently from the application: every one must still
// meet the authentication of /api/v1 and /mcp, or be refused before the app sees it, at a bounded cost.

let t: TestDatabase
let core: TestCore
let app: ReturnType<typeof createApp>
let server: ServerType
let port: number
/** Requests the listener handed to the app. */
let reached = 0

/** The app behind a real @hono/node-server listener on 127.0.0.1, as production runs it. */
async function listen(fetch: (request: Request, env: unknown) => Response | Promise<Response>): Promise<ServerType> {
  const listener = serve({ fetch, port: 0, hostname: "127.0.0.1" })
  await new Promise<void>((resolve) => listener.once("listening", () => resolve()))
  return listener
}

function close(listener: ServerType | undefined): Promise<void> {
  return new Promise<void>((resolve) => (listener ? listener.close(() => resolve()) : resolve()))
}

beforeAll(async () => {
  t = await createTestDatabase("paths")
  core = testCore(t, {
    config: { publicUrl: new URL(TEST_ORIGIN), version: "test" },
    // Many wrong keys in a row: the failed-key limit is not what these tests check.
    limiter: new RateLimiter(1000, 60_000),
  })
  app = createApp({ checkDatabase: async () => true, core })
  server = await listen((request) => {
    reached++
    return app.fetch(request)
  })
  port = (server.address() as AddressInfo).port
})
afterAll(async () => {
  await close(server)
  await t?.close()
})
beforeEach(() => {
  reached = 0
})

/** Hono's RegExpRouter matched no wildcard middleware for these (GHSA-h7mg-cq63-vhpq). */
const LINE_TERMINATORS = ["%0A", "%0D", "%E2%80%A8", "%E2%80%A9"]
const terminatorPaths = LINE_TERMINATORS.flatMap((code) => [
  `/api/v1/items${code}`,
  `/api/v1/${code}/session`,
  `/api/v1/projects/a${code}b`,
  `/mcp/${code}`,
  `/mcp/a${code}b`,
])

describe("a path with an encoded line terminator", () => {
  it.each(terminatorPaths)("%s is refused by the authentication, not answered past it", async (path) => {
    const wrongKey = randomBytes(24).toString("base64url")
    for (const headers of [{}, { authorization: `Bearer ${wrongKey}` }]) {
      for (const method of ["GET", "POST"]) {
        const res = await app.request(path, { method, headers })
        expect([method, headers, res.status]).toEqual([method, headers, 401])
        expect(await res.json()).toEqual({ error: { code: "unauthorized", message: expect.any(String) } })
      }
    }
  })
})

/** The raw request line, as a client sends it: fetch and app.request would normalise the URL first. */
function rawGet(
  path: string,
  headers: Record<string, string> = {},
  target = port,
  localAddress?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port: target, path, method: "GET", headers, localAddress }, (res) => {
      let body = ""
      res.setEncoding("utf8")
      res.on("data", (chunk: string) => {
        body += chunk
      })
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on("error", reject)
    req.end()
  })
}

describe("a raw backslash in the request path (GHSA-jpvv-r467-5p4w)", () => {
  it.each(["/api\\v1/session", "/api/v1\\..\\..\\api/v1/session", "/mcp\\..\\api/v1/session"])(
    "%s is answered 400 by the adapter and never reaches the app",
    async (path) => {
      const res = await rawGet(path)
      expect(res.status).toBe(400)
      expect(reached).toBe(0)
    },
  )

  it("lets an encoded backslash in the path and a backslash in the query reach the app", async () => {
    for (const path of ["/api/v1/session%5C", "/api/v1/session?q=a\\b"]) {
      const res = await rawGet(path)
      expect([path, res.status]).toEqual([path, 401])
      expect(JSON.parse(res.body).error.code).toBe("unauthorized")
    }
    expect(reached).toBe(2)
  })
})

/** The answer to a request whose body was still open, and whether the client could still send when it came. */
type OpenAnswer = { status: number; json: unknown; stillSending: boolean }

/**
 * A POST on a raw socket that never ends its request: the head, then either `Content-Length: contentLength` and no
 * body, or `Transfer-Encoding: chunked` and the given chunks without the terminating chunk. Resolves with the answer
 * as soon as it is complete, or null when none came within `waitMs`: the app was still waiting for the body.
 */
function openPost(
  path: string,
  options: { headers?: Record<string, string>; contentLength?: number; chunks?: Buffer[]; target?: number },
  waitMs = 3000,
): Promise<OpenAnswer | null> {
  return new Promise((resolve, reject) => {
    const socket = connect(options.target ?? port, "127.0.0.1")
    let received = Buffer.alloc(0)
    let done = false
    const finish = (answer: OpenAnswer | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      socket.destroy()
      resolve(answer)
    }
    const timer = setTimeout(() => finish(null), waitMs)
    socket.on("data", (data: Buffer) => {
      received = Buffer.concat([received, data])
      const answer = completeAnswer(received)
      if (answer) finish({ ...answer, stillSending: socket.writable })
    })
    socket.on("close", () => finish(null))
    socket.on("error", (error) => {
      if (!done) reject(error)
    })
    const head = Object.entries({ "content-type": "application/json", ...options.headers }).map(
      ([name, value]) => `${name}: ${value}\r\n`,
    )
    const framing =
      options.contentLength === undefined
        ? "Transfer-Encoding: chunked\r\n"
        : `Content-Length: ${options.contentLength}\r\n`
    socket.write(`POST ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\n${head.join("")}${framing}\r\n`)
    for (const chunk of options.chunks ?? []) {
      socket.write(Buffer.concat([Buffer.from(`${chunk.length.toString(16)}\r\n`), chunk, Buffer.from("\r\n")]))
    }
    // No terminating chunk and no end(): the request stays open.
  })
}

/** The status and JSON body of a complete HTTP/1.1 answer in `raw`, or null while it is still arriving. */
function completeAnswer(raw: Buffer): { status: number; json: unknown } | null {
  const end = raw.indexOf("\r\n\r\n")
  if (end < 0) return null
  const head = raw.subarray(0, end).toString("latin1")
  const status = Number(head.split(" ")[1])
  const rest = raw.subarray(end + 4)
  const length = /\r\ncontent-length:\s*(\d+)/i.exec(head)
  let body: string
  if (length) {
    if (rest.length < Number(length[1])) return null
    body = rest.subarray(0, Number(length[1])).toString("utf8")
  } else if (/\r\ntransfer-encoding:\s*chunked/i.test(head)) {
    if (!rest.includes("0\r\n\r\n")) return null
    body = ""
    let at = 0
    for (;;) {
      const line = rest.indexOf("\r\n", at)
      const size = Number.parseInt(rest.subarray(at, line).toString("latin1"), 16)
      if (!size) break
      body += rest.subarray(line + 2, line + 2 + size).toString("utf8")
      at = line + 2 + size + 2
    }
  } else return null
  return { status, json: body ? JSON.parse(body) : null }
}

/** A few KiB of a body that never ends: the answer must not wait for the rest. */
const someChunks = () => [randomBytes(1024), randomBytes(1024), randomBytes(1024)]

describe("credentials are checked before the body is read", () => {
  // The /api/v1 body limits run after the authentication: a request without valid credentials is refused before the
  // app reads or buffers its body. (The adapter may still drain an unread body after the answer, bounded in time and
  // size, to clean up the connection; that is not the app reading it.)
  const routes = ["/api/v1/sync/t3", "/api/v1/items"]

  it.each(routes)("%s answers an unfinished chunked body without credentials with 401 at once", async (path) => {
    const res = await openPost(path, { chunks: someChunks() })
    expect(res).toMatchObject({ status: 401, json: { error: { code: "unauthorized" } }, stillSending: true })
  })

  it.each(routes)("%s answers an unfinished chunked body with a wrong key with 401 at once", async (path) => {
    const wrongKey = randomBytes(24).toString("base64url")
    const res = await openPost(path, { headers: { authorization: `Bearer ${wrongKey}` }, chunks: someChunks() })
    expect(res).toMatchObject({ status: 401, json: { error: { code: "unauthorized" } }, stillSending: true })
  })

  it.each([
    ["/api/v1/sync/t3", 16 * 1024 * 1024 + 1],
    ["/api/v1/items", 512 * 1024 + 1],
  ])("%s answers a Content-Length over its limit without credentials with 401, not 413", async (path, size) => {
    const res = await openPost(path, { contentLength: size })
    expect(res).toMatchObject({ status: 401, json: { error: { code: "unauthorized" } }, stillSending: true })
  })

  it("answers a key 429 at once after the failed-key limit, before reading the body", async () => {
    // A separate app with the real limit of 10 failed keys a minute per address, keyed as production keys it: the
    // socket's address, or X-Forwarded-For when that peer is a trusted proxy (here a second loopback address).
    const proxy = [127, 0, 0, 2].join(".")
    const limited = createApp({
      checkDatabase: async () => true,
      core: { ...core, limiter: new RateLimiter(10, 60_000), clientIp: clientAddress([proxy], socketAddress) },
    })
    const listener = await listen(limited.fetch)
    const wrongKey = () => ({ authorization: `Bearer ${randomBytes(24).toString("base64url")}` })
    try {
      const target = (listener.address() as AddressInfo).port
      // From 127.0.0.1, not a trusted proxy: its X-Forwarded-For is ignored, so every one counts for 127.0.0.1.
      for (let i = 0; i < 10; i++) {
        const wrong = await rawGet(
          "/api/v1/session",
          { ...wrongKey(), "x-forwarded-for": `203.0.113.${i + 1}` },
          target,
        )
        expect(wrong.status).toBe(401)
      }
      for (const path of routes) {
        const res = await openPost(path, { headers: wrongKey(), chunks: someChunks(), target })
        expect([path, res]).toMatchObject([
          path,
          { status: 429, json: { error: { code: "rate_limited" } }, stillSending: true },
        ])
        // Without credentials the limit does not apply: 401, still before the body is read.
        const anonymous = await openPost(path, { chunks: someChunks(), target })
        expect([path, anonymous]).toMatchObject([
          path,
          { status: 401, json: { error: { code: "unauthorized" } }, stillSending: true },
        ])
      }
      // Through the trusted proxy, each client in X-Forwarded-For has its own bucket.
      const proxied = async (client: string) =>
        (await rawGet("/api/v1/session", { ...wrongKey(), "x-forwarded-for": client }, target, proxy)).status
      for (let i = 0; i < 10; i++) expect(await proxied("203.0.113.1")).toBe(401)
      expect(await proxied("203.0.113.1")).toBe(429)
      expect(await proxied("203.0.113.2")).toBe(401)
    } finally {
      await close(listener)
    }
  })

  describe("as the owner", () => {
    let owner: TestBrowser
    let key: string
    beforeAll(async () => {
      await t.reset()
      owner = await ownerBrowser(t, app)
      key = await createAgentKey(core)
    })

    it.each(routes)("%s refuses a session without the page's headers with 403 at once", async (path) => {
      const res = await openPost(path, { headers: { cookie: owner.cookieHeader }, chunks: someChunks() })
      expect(res).toMatchObject({ status: 403, json: { error: { code: "forbidden" } }, stillSending: true })
    })

    // Behaviour kept: an authenticated request over the limit still gets 413 validation_failed. The owner's session
    // that passes the CSRF check now reaches the limit after the authentication.
    it.each([
      ["/api/v1/sync/t3", 16 * 1024 * 1024 + 1],
      ["/api/v1/items", 512 * 1024 + 1],
    ])("%s answers an agent key's Content-Length over its limit with 413", async (path, size) => {
      const res = await openPost(path, { headers: { authorization: `Bearer ${key}` }, contentLength: size })
      expect(res).toMatchObject({ status: 413, json: { error: { code: "validation_failed" } } })
    })

    it("answers an agent key's chunked body over the default limit with 413 once the limit is passed", async () => {
      const chunks = Array.from({ length: 9 }, () => randomBytes(64 * 1024))
      const res = await openPost("/api/v1/items", { headers: { authorization: `Bearer ${key}` }, chunks })
      expect(res).toMatchObject({ status: 413, json: { error: { code: "validation_failed" } } })
    })

    it("reads a body sent in many tiny transfer chunks at a bounded memory cost (GHSA-39q9-qp46-w8xg)", async () => {
      // bodyLimit() reads an agent's body after the authentication. Before the hono fix it kept one object per
      // transfer chunk: 500,000 one-byte chunks grew the heap by about 140 MB (hono 4.13.17); since the fix about
      // 25 MB, the short-lived garbage of reading it, whatever the number of chunks.
      const before = process.memoryUsage().heapUsed
      let peak = before
      const sample = setInterval(() => {
        peak = Math.max(peak, process.memoryUsage().heapUsed)
      }, 2)
      let res: { status: number; body: string }
      try {
        res = await tinyChunkPost("/api/v1/sync/t3", 500_000, { authorization: `Bearer ${key}` })
      } finally {
        clearInterval(sample)
      }
      peak = Math.max(peak, process.memoryUsage().heapUsed)
      // Read whole, then refused as a snapshot: the junk is not JSON.
      expect(res.status).toBe(400)
      expect(JSON.parse(res.body).error.code).toBe("validation_failed")
      expect(peak - before).toBeLessThan(64 * 1024 * 1024)
      // The listener still serves.
      expect((await rawGet("/healthz")).status).toBe(200)
    })
  })

  describe("as an owner without two-factor", () => {
    let passwordOnly: string
    beforeAll(async () => {
      await t.reset()
      const b = new TestBrowser((request) => app.fetch(request), TEST_ORIGIN, { "x-forwarded-for": "198.51.100.77" })
      const created = await b.setup()
      if (created.status !== 200) throw new Error(`setup answered ${created.status}`)
      passwordOnly = b.cookieHeader
    })
    // Leave no half-set-up owner behind for ownerBrowser().
    afterAll(async () => {
      await t.reset()
    })

    it.each(routes)("%s refuses a password-only session with 403 totp_required at once", async (path) => {
      const headers = { cookie: passwordOnly, "x-adiutor-request": "1", origin: TEST_ORIGIN }
      const res = await openPost(path, { headers, chunks: someChunks() })
      expect(res).toMatchObject({ status: 403, json: { error: { code: "totp_required" } }, stillSending: true })
    })
  })
})

/** A chunked POST whose body is `chunks` transfer chunks of one byte each, written at once on a raw socket. */
function tinyChunkPost(
  path: string,
  chunks: number,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1")
    let raw = ""
    socket.setEncoding("utf8")
    socket.on("data", (data: string) => {
      raw += data
    })
    socket.on("end", () => {
      const [head = "", body = ""] = raw.split("\r\n\r\n")
      resolve({ status: Number(head.split(" ")[1]), body })
    })
    socket.on("error", reject)
    const extra = Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`)
    socket.write(
      `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nContent-Type: application/json\r\n` +
        `${extra.join("")}Transfer-Encoding: chunked\r\n\r\n`,
    )
    socket.write(Buffer.from(`${"1\r\nx\r\n".repeat(chunks)}0\r\n\r\n`))
  })
}
