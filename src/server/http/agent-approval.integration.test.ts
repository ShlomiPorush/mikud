import { eq, sql } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { CONNECT_CLIENT_ID } from "../../shared/auth.ts"
import { disconnectEvery } from "../../web/pages/settings/disconnectAll.ts"
import { createApp } from "../app.ts"
import { audit, authApiKey, authDeviceCode, authSession } from "../db/schema.ts"
import { createAgentKey, type TestCore, testCore } from "../testing/app.ts"
import { TEST_ORIGIN, TestBrowser } from "../testing/browser.ts"
import { createTestDatabase, type TestDatabase } from "../testing/db.ts"
import { totp } from "../testing/totp.ts"

// Agent approval in the browser, as Adiutor configures Better Auth (src/server/auth/auth.ts): the core
// deviceAuthorization plugin, bearer() and the api-key plugin, over HTTP through the app. `adiutor connect` asks for a
// code, the owner's signed-in browser approves it, the CLI receives a session token, creates one key with it and ends
// that session. Owner gaps G-A, G-B and G10 are in docs/project-foundation.md, "Security design".

const DAY = 86_400_000

let t: TestDatabase
let core: TestCore
let app: ReturnType<typeof createApp>
let lastIp = 0

/** A documentation address of its own for each client: Better Auth keys its rate limits on X-Forwarded-For. */
const nextIp = () => `192.0.2.${(lastIp++ % 250) + 1}`

beforeAll(async () => {
  vi.spyOn(console, "error").mockImplementation(() => {})
  t = await createTestDatabase("approval")
})
afterAll(async () => {
  await t?.close()
  vi.restoreAllMocks()
})
beforeEach(async () => {
  await t.reset()
  core = testCore(t, { config: { publicUrl: new URL(TEST_ORIGIN), version: "test" } })
  app = createApp({ checkDatabase: async () => true, core })
})
afterEach(async () => {
  vi.useRealTimers()
  await core.telegramService.stop()
})

const browser = () => new TestBrowser((request) => app.fetch(request), TEST_ORIGIN, { "x-forwarded-for": nextIp() })

/** The owner's signed-in browser (two-factor on). */
async function owner(): Promise<TestBrowser> {
  const b = browser()
  await b.owner()
  return b
}

type Reply = { status: number; json: Record<string, unknown> & { [key: string]: unknown } }

/** The CLI: no cookie, no Origin, its own User-Agent and address. */
function cli(ip = nextIp()) {
  const send = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await app.fetch(
      new Request(`${TEST_ORIGIN}${path}`, {
        method,
        headers: {
          "user-agent": CONNECT_CLIENT_ID,
          "x-forwarded-for": ip,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    )
    const text = await response.text()
    let json: unknown = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = text
    }
    return { status: response.status, json } as Reply
  }
  return {
    send,
    code: (clientId = CONNECT_CLIENT_ID) => send("POST", "/api/auth/device/code", { client_id: clientId }),
    poll: (deviceCode: string) =>
      send("POST", "/api/auth/device/token", {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: CONNECT_CLIENT_ID,
      }),
    createKey: (token: string, body: Record<string, unknown>) =>
      send("POST", "/api/auth/api-key/create", body, { authorization: `Bearer ${token}` }),
    revoke: (token: string, revoked = token) =>
      send("POST", "/api/auth/revoke-session", { token: revoked }, { authorization: `Bearer ${token}` }),
  }
}

/** Fakes Date only (timers and the database keep running), so the plugin's clocks move. */
function moveDate(by: number) {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(Date.now() + by)
}

/** Refuses one audit action at the database, so the hook that writes it fails (a broken audit store). */
async function refuseAudit(action: string) {
  await t.ctx.db.execute(
    sql.raw(`alter table audit add constraint test_refuse check (action <> '${action}') not valid`),
  )
}
async function acceptAudit() {
  await t.ctx.db.execute(sql.raw("alter table audit drop constraint if exists test_refuse"))
}

const auditRows = async () =>
  (await t.ctx.db.select().from(audit).orderBy(audit.id)).map((a) => ({ action: a.action, source: a.source }))
const sessions = async () => t.ctx.db.select().from(authSession)

/** A full approval up to the CLI's session token. */
async function approvedToken(b: TestBrowser, c = cli()): Promise<string> {
  const code = await c.code()
  const userCode = code.json.user_code as string
  expect((await b.call("GET", `/api/auth/device?user_code=${userCode}`)).status).toBe(200)
  expect((await b.call("POST", "/api/auth/device/approve", { body: { userCode } })).status).toBe(200)
  const answer = await c.poll(code.json.device_code as string)
  expect(answer.status).toBe(200)
  return answer.json.access_token as string
}

describe("agent approval: the device flow", () => {
  it("approves in the browser; the CLI gets a session once, creates its named key with an end, and ends the session", async () => {
    const b = await owner()
    const c = cli()
    const code = await c.code()
    expect(code.status).toBe(200)
    const userCode = code.json.user_code as string
    expect(code.json).toMatchObject({
      verification_uri: `${TEST_ORIGIN}/connect/device`,
      verification_uri_complete: `${TEST_ORIGIN}/connect/device?user_code=${userCode}`,
      expires_in: 600,
      interval: 5,
    })
    const deviceCode = code.json.device_code as string
    expect((await c.poll(deviceCode)).json.error).toBe("authorization_pending")
    // Faster than every 5 seconds.
    expect((await c.poll(deviceCode)).json.error).toBe("slow_down")

    const seen = await b.call("GET", `/api/auth/device?user_code=${userCode}`)
    expect(seen.json).toMatchObject({ status: "pending", client_id: CONNECT_CLIENT_ID })
    expect((await b.call("POST", "/api/auth/device/approve", { body: { userCode } })).json).toEqual({ success: true })
    // The same code cannot be answered twice.
    const again = await b.call("POST", "/api/auth/device/approve", { body: { userCode } })
    expect([again.status, again.json.error]).toEqual([400, "invalid_request"])

    moveDate(6_000)
    const answer = await c.poll(deviceCode)
    expect(answer.status).toBe(200)
    expect(answer.json.token_type).toBe("Bearer")
    const token = answer.json.access_token as string
    // G-B: a full session, named by the CLI's User-Agent, lasting what every session lasts (30 idle days here).
    const [device] = (await sessions()).filter((s) => s.token === token)
    expect(device?.userAgent).toBe(CONNECT_CLIENT_ID)
    expect(Math.abs((device?.expiresAt.getTime() ?? 0) - (Date.now() + 30 * DAY))).toBeLessThan(60_000)

    const created = await c.createKey(token, { name: "claude-laptop", expiresIn: 7 * 86_400 })
    expect(created.status).toBe(200)
    expect(created.json.name).toBe("claude-laptop")
    expect(created.json.key).toMatch(/^adt_/)
    expect(Math.abs(new Date(created.json.expiresAt as string).getTime() - (Date.now() + 7 * DAY))).toBeLessThan(60_000)

    expect((await c.revoke(token)).json).toEqual({ status: true })
    expect((await sessions()).some((s) => s.token === token)).toBe(false)
    const key = created.json.key as string
    expect((await core.auth.current.api.verifyApiKey({ body: { key } })).valid).toBe(true)
    expect((await app.request("/api/v1/projects", { headers: { authorization: `Bearer ${key}` } })).status).toBe(200)

    const rows = await auditRows()
    expect(rows.filter((r) => r.action !== "session.sign_in" && !r.action.startsWith("account."))).toEqual([
      { action: "device.approve", source: "ui" },
      { action: "device.approve", source: "ui" },
      { action: "session.connect", source: "api" },
      { action: "api_key.create", source: "api" },
      { action: "session.revoke", source: "api" },
    ])
  })

  it("redeems an approved code once, also when two polls race", async () => {
    const b = await owner()
    const c = cli()
    const code = await c.code()
    const userCode = code.json.user_code as string
    await b.call("GET", `/api/auth/device?user_code=${userCode}`)
    await b.call("POST", "/api/auth/device/approve", { body: { userCode } })
    const deviceCode = code.json.device_code as string
    const answers = await Promise.all([c.poll(deviceCode), c.poll(deviceCode), c.poll(deviceCode)])
    expect(answers.filter((a) => a.status === 200)).toHaveLength(1)
    expect((await sessions()).filter((s) => s.userAgent === CONNECT_CLIENT_ID)).toHaveLength(1)
    moveDate(6_000)
    const later = await c.poll(deviceCode)
    expect([later.status, later.json.error]).toEqual([400, "invalid_grant"])
  })

  it("deny: the CLI hears access_denied and nothing is created", async () => {
    const b = await owner()
    const c = cli()
    const code = await c.code()
    const userCode = code.json.user_code as string
    await b.call("GET", `/api/auth/device?user_code=${userCode}`)
    expect((await b.call("POST", "/api/auth/device/deny", { body: { userCode } })).status).toBe(200)
    const answer = await c.poll(code.json.device_code as string)
    expect([answer.status, answer.json.error]).toEqual([400, "access_denied"])
    expect((await sessions()).filter((s) => s.userAgent === CONNECT_CLIENT_ID)).toHaveLength(0)
    expect(await t.ctx.db.select().from(authApiKey)).toHaveLength(0)
    expect((await auditRows()).map((r) => r.action)).toContain("device.deny")
  })

  it("an expired code can be neither approved nor collected", async () => {
    const b = await owner()
    const c = cli()
    const code = await c.code()
    const userCode = code.json.user_code as string
    moveDate(11 * 60_000)
    const late = await b.call("GET", `/api/auth/device?user_code=${userCode}`)
    expect([late.status, late.json.error]).toEqual([400, "expired_token"])
    const approve = await b.call("POST", "/api/auth/device/approve", { body: { userCode } })
    expect([approve.status, approve.json.error]).toEqual([400, "expired_token"])
    const answer = await c.poll(code.json.device_code as string)
    expect([answer.status, answer.json.error]).toEqual([400, "expired_token"])
  })

  it("lets one CLI poll for the whole code lifetime without being rate limited", async () => {
    // A code lives 10 minutes and the CLI polls every 5 seconds: 120 polls. Better Auth counts a route's requests
    // until it is quiet for a whole window, so the global 100 a minute would refuse the 101st.
    await owner()
    const c = cli()
    const code = await c.code()
    const deviceCode = code.json.device_code as string
    for (let i = 0; i < 130; i++) {
      const answer = await c.poll(deviceCode)
      expect(answer.status, `poll ${i + 1}`).not.toBe(429)
    }
  })

  it("refuses an unknown client id", async () => {
    const answer = await cli().code("another-client")
    expect([answer.status, answer.json.error]).toEqual([400, "invalid_client"])
  })

  it("a signed-out browser sees only the status, claims nothing and cannot approve; so does a password-only sign-in", async () => {
    await owner()
    const c = cli()
    const code = await c.code()
    const userCode = code.json.user_code as string
    const anon = browser()
    const seen = await anon.call("GET", `/api/auth/device?user_code=${userCode}`)
    expect(seen.json).toEqual({ user_code: userCode, status: "pending" })
    expect((await anon.call("POST", "/api/auth/device/approve", { body: { userCode } })).status).toBe(401)
    const half = browser()
    expect((await half.passwordSignIn()).json.twoFactorRedirect).toBe(true)
    expect((await half.call("POST", "/api/auth/device/approve", { body: { userCode } })).status).toBe(401)
    const [row] = await t.ctx.db.select().from(authDeviceCode).where(eq(authDeviceCode.userCode, userCode))
    expect([row?.status, row?.userId]).toEqual(["pending", null])
  })

  it("keeps GET /device, approve and deny closed until the account has two-factor; the CLI's routes need no session", async () => {
    const b = browser()
    await b.setup()
    const c = cli()
    const code = await c.code()
    expect(code.status).toBe(200)
    const userCode = code.json.user_code as string
    for (const [method, path, body] of [
      ["GET", `/api/auth/device?user_code=${userCode}`, undefined],
      ["POST", "/api/auth/device/approve", { userCode }],
      ["POST", "/api/auth/device/deny", { userCode }],
    ] as const) {
      const answer = await b.call(method, path, body === undefined ? {} : { body })
      expect([path, answer.status, answer.json.code]).toEqual([path, 403, "TOTP_REQUIRED"])
    }
    expect((await c.poll(code.json.device_code as string)).json.error).toBe("authorization_pending")
  })
})

describe("agent approval: bearer() and the agent keys stay apart", () => {
  it("a session token sent as a bearer is refused by /api/v1, /mcp and the sync routes", async () => {
    const b = await owner()
    const token = await approvedToken(b)
    const bearer = { authorization: `Bearer ${token}` }
    expect((await app.request("/api/v1/session", { headers: bearer })).status).toBe(401)
    expect((await app.request("/api/v1/projects", { headers: bearer })).status).toBe(401)
    const snapshot = { collectedAt: new Date().toISOString(), projects: [], threads: [] }
    const sync = await app.request("/api/v1/sync/t3", {
      method: "POST",
      headers: { ...bearer, "content-type": "application/json" },
      body: JSON.stringify(snapshot),
    })
    expect(sync.status).toBe(401)
    const mcp = await app.request("/mcp", {
      method: "POST",
      headers: { ...bearer, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    })
    expect(mcp.status).toBe(401)
    // The setup status reads the cookie only.
    const status = await app.request("/api/setup/status", { headers: bearer })
    expect(((await status.json()) as { data: { session: string } }).data.session).toBe("none")
  })

  it("a cookie together with a wrong bearer never falls back to the owner", async () => {
    const b = await owner()
    const token = await approvedToken(b)
    for (const wrong of ["adt_not-a-key", token]) {
      const answer = await b.call("GET", "/api/v1/session", { headers: { authorization: `Bearer ${wrong}` } })
      expect([wrong.slice(0, 4), answer.status]).toEqual([wrong.slice(0, 4), 401])
    }
    expect((await b.call("GET", "/api/v1/session")).status).toBe(200)
  })

  it("an agent key is no session on Better Auth's routes", async () => {
    await owner()
    const key = await createAgentKey(core)
    const c = cli()
    const created = await c.createKey(key, { name: "from-a-key", expiresIn: 86_400 })
    expect(created.status).toBe(401)
    for (const path of ["/api/auth/get-session", "/api/auth/list-sessions", "/api/auth/api-key/list"]) {
      const answer = await c.send("GET", path, undefined, { authorization: `Bearer ${key}` })
      expect([path, answer.status, answer.json?.code]).toEqual([path, 403, "AUTHORIZATION_NOT_ALLOWED"])
    }
    expect((await c.send("GET", "/api/auth/get-session", undefined, { "x-api-key": key })).json).toBeNull()
    expect(await t.ctx.db.select().from(authApiKey)).toHaveLength(1)
  })

  it("the device session cannot create a key without an end in days", async () => {
    const b = await owner()
    const token = await approvedToken(b)
    const c = cli()
    for (const body of [{ name: "none" }, { name: "null", expiresIn: null }]) {
      const refused = await c.createKey(token, body)
      expect([body.name, refused.status, refused.json.code]).toEqual([body.name, 400, "EXPIRES_IN_REQUIRED"])
    }
    expect(await t.ctx.db.select().from(authApiKey)).toHaveLength(0)
    expect((await c.revoke(token)).json).toEqual({ status: true })
  })

  it("the device session reaches only /api-key/create and the end of itself, with or without a cookie", async () => {
    const b = await owner()
    const token = await approvedToken(b)
    const c = cli()
    for (const [method, path, body] of [
      ["GET", "/api/auth/get-session", undefined],
      ["GET", "/api/auth/list-sessions", undefined],
      ["GET", "/api/auth/api-key/list", undefined],
      ["POST", "/api/auth/api-key/delete", { keyId: "x" }],
      ["POST", "/api/auth/revoke-sessions", {}],
      ["POST", "/api/auth/revoke-other-sessions", {}],
      ["POST", "/api/auth/change-password", { currentPassword: "x", newPassword: "y" }],
      ["POST", "/api/auth/two-factor/disable", { password: "x" }],
      ["POST", "/api/auth/device/approve", { userCode: "x" }],
      ["POST", "/api/auth/sign-out", {}],
    ] as const) {
      const alone = await c.send(method, path, body, { authorization: `Bearer ${token}` })
      expect([path, alone.status, alone.json?.code]).toEqual([path, 403, "AUTHORIZATION_NOT_ALLOWED"])
      const withCookie = await b.call(method, path, {
        ...(body === undefined ? {} : { body }),
        headers: { authorization: `Bearer ${token}` },
      })
      expect([path, withCookie.status]).toEqual([path, 403])
    }
    // Another session's token: refused, and the browser stays signed in.
    const listed = await b.call("GET", "/api/auth/list-sessions")
    const browserToken = (listed.json as { token: string; userAgent: string | null }[]).find(
      (s) => s.userAgent !== CONNECT_CLIENT_ID,
    )?.token as string
    const other = await c.revoke(token, browserToken)
    expect([other.status, other.json.code]).toEqual([403, "OWN_SESSION_ONLY"])
    expect((await b.call("GET", "/api/v1/session")).status).toBe(200)
    expect((await c.revoke(token)).json).toEqual({ status: true })
  })

  it("G10 with bearer(): a raw token from the browsers list acts as a bearer, only where the CLI's would", async () => {
    const b = await owner()
    const listed = await b.call("GET", "/api/auth/list-sessions")
    const raw = (listed.json as { token: string }[])[0]?.token as string
    const c = cli()
    expect((await c.send("GET", "/api/auth/list-sessions", undefined, { authorization: `Bearer ${raw}` })).status).toBe(
      403,
    )
    const created = await c.createKey(raw, { name: "from-a-raw-token", expiresIn: 86_400 })
    expect(created.status).toBe(200)
  })
})

describe("agent approval: Settings and the audit", () => {
  it("disconnect acts at once, and disconnect all deletes every listed key", async () => {
    const b = await owner()
    const keys: string[] = []
    for (const name of ["sync", "claude", "codex"]) {
      const token = await approvedToken(b)
      const c = cli()
      keys.push((await c.createKey(token, { name, expiresIn: 30 * 86_400 })).json.key as string)
      await c.revoke(token)
    }
    const asAgent = async (key: string) =>
      (await app.request("/api/v1/projects", { headers: { authorization: `Bearer ${key}` } })).status
    const listed = (await b.call("GET", "/api/auth/api-key/list")).json as {
      apiKeys: { id: string; name: string; expiresAt: string | null; createdAt: string; lastRequest: string | null }[]
    }
    expect(listed.apiKeys.map((k) => k.name).sort()).toEqual(["claude", "codex", "sync"])
    expect(listed.apiKeys.every((k) => k.expiresAt && k.createdAt)).toBe(true)
    const first = listed.apiKeys.find((k) => k.name === "sync")
    expect((await b.call("POST", "/api/auth/api-key/delete", { body: { keyId: first?.id } })).status).toBe(200)
    expect(await asAgent(keys[0] as string)).toBe(401)
    expect(await asAgent(keys[1] as string)).toBe(200)

    const rest = ((await b.call("GET", "/api/auth/api-key/list")).json as { apiKeys: { id: string }[] }).apiKeys
    for (const k of rest) await b.call("POST", "/api/auth/api-key/delete", { body: { keyId: k.id } })
    expect(((await b.call("GET", "/api/auth/api-key/list")).json as { total: number }).total).toBe(0)
    for (const key of keys) expect(await asAgent(key)).toBe(401)
    expect((await auditRows()).filter((r) => r.action === "api_key.delete")).toHaveLength(3)
  })

  it("refuses an approval, and the session it would give, when its audit row cannot be written", async () => {
    const b = await owner()
    const c = cli()
    const code = await c.code()
    const userCode = code.json.user_code as string
    await b.call("GET", `/api/auth/device?user_code=${userCode}`)
    await refuseAudit("device.approve")
    expect((await b.call("POST", "/api/auth/device/approve", { body: { userCode } })).status).toBe(500)
    await acceptAudit()
    const [row] = await t.ctx.db.select().from(authDeviceCode).where(eq(authDeviceCode.userCode, userCode))
    expect(row?.status).toBe("pending")

    await b.call("POST", "/api/auth/device/approve", { body: { userCode } })
    await refuseAudit("session.connect")
    expect((await c.poll(code.json.device_code as string)).status).toBe(500)
    await acceptAudit()
    expect((await sessions()).filter((s) => s.userAgent === CONNECT_CLIENT_ID)).toHaveLength(0)
  })

  it("ends the device session even when its audit row cannot be written (the row is written after the fact)", async () => {
    const b = await owner()
    const token = await approvedToken(b)
    await refuseAudit("session.revoke")
    expect((await cli().revoke(token)).json).toEqual({ status: true })
    await acceptAudit()
    expect((await sessions()).some((s) => s.token === token)).toBe(false)
  })

  it("the owner ends a leftover device session from the Account page (Better Auth's revokeSession)", async () => {
    const b = await owner()
    const token = await approvedToken(b)
    const listed = (await b.call("GET", "/api/auth/list-sessions")).json as { token: string; userAgent: string }[]
    const device = listed.find((s) => s.userAgent === CONNECT_CLIENT_ID)
    expect(device?.token).toBe(token)
    expect((await b.call("POST", "/api/auth/revoke-session", { body: { token: device?.token } })).json).toEqual({
      status: true,
    })
    expect((await sessions()).some((s) => s.token === token)).toBe(false)
    expect((await auditRows()).at(-1)).toEqual({ action: "session.revoke", source: "ui" })
    expect((await b.call("GET", "/api/v1/session")).status).toBe(200)
  })
})

describe("Disconnect all with more keys than one list holds", () => {
  it("one list answers at most 100 of 101 keys; listing again after each round deletes every key", async () => {
    const b = await owner()
    const [user] = await t.ctx.db.select({ id: authSession.userId }).from(authSession).limit(1)
    for (let i = 0; i < 101; i++)
      await core.auth.current.api.createApiKey({
        body: { userId: user?.id as string, name: `agent-${i}`, expiresIn: 86_400 },
      })
    // The library's limit, shown to the owner as it is: the database adapter's default of 100 rows.
    const first = (await b.call("GET", "/api/auth/api-key/list")).json as { apiKeys: { id: string }[]; total: number }
    expect([first.apiKeys.length, first.total]).toEqual([100, 100])

    // Each request from its own address: Better Auth allows 100 a minute per address and route.
    const result = await disconnectEvery(
      async () =>
        (
          (await b.call("GET", "/api/auth/api-key/list", { headers: { "x-forwarded-for": nextIp() } })).json as {
            apiKeys: { id: string }[]
          }
        ).apiKeys,
      async (keyId) => {
        const answer = await b.call("POST", "/api/auth/api-key/delete", {
          body: { keyId },
          headers: { "x-forwarded-for": nextIp() },
        })
        if (answer.status !== 200) throw new Error(`delete answered ${answer.status}`)
      },
    )
    expect(result).toEqual({ removed: 101, remaining: 0, atLeast: false })
    expect(await t.ctx.db.select().from(authApiKey)).toHaveLength(0)
  })
})

describe("G10, accepted by the owner (2026-11-02): bearer() hands sign-in's cookie to page script", () => {
  it("the set-auth-token header of a sign-in is the signed session cookie; replayed as the cookie, without Authorization, it has the owner's rights", async () => {
    const secret = await browser().owner()
    const page = browser()
    expect((await page.passwordSignIn()).json.twoFactorRedirect).toBe(true)
    const signedIn = await page.verify(totp(secret))
    expect(signedIn.status).toBe(200)
    const exposed = signedIn.headers.get("set-auth-token")
    expect(exposed).toBeTruthy()
    // bearer() lists it as readable by page script.
    expect(signedIn.headers.get("access-control-expose-headers")).toContain("set-auth-token")
    // It is the value of the session cookie the same answer sets (HttpOnly there, readable here), decoded.
    const cookie = signedIn.setCookies.find((c) => c.startsWith("better-auth.session_token="))
    expect(decodeURIComponent(cookie?.split(";")[0]?.slice("better-auth.session_token=".length) ?? "")).toBe(exposed)

    // A fresh client with that value as its cookie, no Authorization: an owner-only route answers.
    const replay = await app.fetch(
      new Request(`${TEST_ORIGIN}/api/v1/settings`, {
        headers: {
          cookie: `better-auth.session_token=${encodeURIComponent(exposed ?? "")}`,
          "x-forwarded-for": nextIp(),
        },
      }),
    )
    expect(replay.status).toBe(200)
    const listed = await app.fetch(
      new Request(`${TEST_ORIGIN}/api/auth/list-sessions`, {
        headers: {
          cookie: `better-auth.session_token=${encodeURIComponent(exposed ?? "")}`,
          "x-forwarded-for": nextIp(),
        },
      }),
    )
    expect(listed.status).toBe(200)
  })
})
