import type { AddressInfo } from "node:net"
import { inspect } from "node:util"
import { type ServerType, serve } from "@hono/node-server"
import { count, sql } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { authenticatorUri, ownerEmail } from "../../shared/auth.ts"
import { createApp } from "../app.ts"
import { TWO_FACTOR_CHALLENGE_S } from "../auth/auth.ts"
import { resetOwnerPassword } from "../auth/recovery.ts"
import { audit, authApiKey, authSession, authTwoFactor, authUser } from "../db/schema.ts"
import { getSettings } from "../services/admin.ts"
import { TEST_AUTH_SECRET, type TestCore, type TestCoreOptions, testAuthBase, testCore } from "../testing/app.ts"
import { StandInBotApi, waitFor } from "../testing/bot-api.ts"
import { TEST_ORIGIN, TEST_PASSWORD, TEST_USERNAME, TestBrowser } from "../testing/browser.ts"
import { createTestDatabase, type TestDatabase } from "../testing/db.ts"
import { testBotToken, testPassword, testSecret } from "../testing/secrets.ts"
import { totp, wrongTotp } from "../testing/totp.ts"

// Better Auth as Adiutor configures it (src/server/auth/auth.ts), over HTTP through the app: its own routes, the
// documented hooks, and the gaps the owner accepted (G1 to G18 in docs/project-foundation.md, "Security design").

const DAY = 86_400_000
/** The password a change sets, shared by the change and the sign-in after it. */
const NEW_PASSWORD = testPassword()
const HOUR = 3_600_000

let t: TestDatabase
let core: TestCore
let app: ReturnType<typeof createApp>
let lastIp = 0

/** A documentation address of its own for each browser: Better Auth keys its rate limits on X-Forwarded-For. */
const nextIp = () => `198.51.100.${(lastIp++ % 250) + 1}`

function build(options: Partial<TestCoreOptions> = {}) {
  core = testCore(t, { config: { publicUrl: new URL(TEST_ORIGIN), version: "test" }, ...options })
  app = createApp({ checkDatabase: async () => true, core })
  return app
}

const browser = (ip = nextIp(), on = () => app) =>
  new TestBrowser((request) => on().fetch(request), TEST_ORIGIN, { "x-forwarded-for": ip })

beforeAll(async () => {
  vi.spyOn(console, "error").mockImplementation(() => {})
  t = await createTestDatabase("auth")
})
afterAll(async () => {
  await t?.close()
  vi.restoreAllMocks()
})
beforeEach(async () => {
  await t.reset()
  build()
})
afterEach(async () => {
  vi.useRealTimers()
  await core.telegramService.stop()
})

const sessions = async () => t.ctx.db.select().from(authSession)
const actions = async () =>
  (await t.ctx.db.select({ action: audit.action }).from(audit).orderBy(audit.id)).map((a) => a.action)
const auditRows = async () => t.ctx.db.select().from(audit).orderBy(audit.id)
const v1 = (b: TestBrowser, path = "/session") => b.call("GET", `/api/v1${path}`)
const owner = async () => (await t.ctx.db.select().from(authUser))[0]
const trustCookie = (setCookies: string[]) => setCookies.some((c) => /trust_device/.test(c.split("=")[0] ?? ""))

/** Refuses one audit action at the database, so the hook that writes it fails (a broken audit store). */
async function refuseAudit(action: string) {
  await t.ctx.db.execute(
    sql.raw(`alter table audit add constraint test_refuse check (action <> '${action}') not valid`),
  )
}
async function acceptAudit() {
  await t.ctx.db.execute(sql.raw("alter table audit drop constraint if exists test_refuse"))
}

/** Fakes Date only (timers and the database keep running), so Better Auth's clocks move. */
function moveDate(by: number) {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(Date.now() + by)
}

describe("first run: Better Auth's sign-up", () => {
  it("creates the owner once, keeps the spelling, and refuses a second sign-up before hashing", async () => {
    const b = browser()
    expect((await b.call("GET", "/api/setup/status")).json.data).toEqual({ hasUser: false, session: "none" })
    const created = await b.setup("Owner.Name")
    expect(created.status).toBe(200)
    const user = await owner()
    expect(user).toMatchObject({
      username: "owner.name",
      displayUsername: "Owner.Name",
      email: ownerEmail("owner.name"),
      twoFactorEnabled: false,
    })
    expect((await b.call("GET", "/api/setup/status")).json.data).toEqual({ hasUser: true, session: "enrol" })
    // Signed in by password only: Adiutor's API refuses it until two-factor is on.
    const refused = await v1(b)
    expect([refused.status, refused.json.error.code]).toEqual([403, "totp_required"])

    const context = await core.auth.current.$context
    const hash = vi.spyOn(context.password, "hash")
    const again = await browser().setup("someone")
    expect([again.status, again.json.code]).toEqual([403, "ALREADY_SET_UP"])
    expect(hash).not.toHaveBeenCalled()
    hash.mockRestore()
    expect(await actions()).toEqual(["account.setup", "session.sign_in"])
    expect((await auditRows())[1]?.after).toEqual({ stage: "password" })
  })

  it.each(["A_b.C", "owner.name"])(
    "makes a readable synthetic e-mail for %s: sign-up, the authenticator label, sign-in and the CLI reset work",
    async (name) => {
      const b = browser()
      expect((await b.setup(name)).status).toBe(200)
      const email = `${name.toLowerCase()}@adiutor.local`
      expect((await owner())?.email).toBe(email)
      // Better Auth names the authenticator entry after the e-mail: the username, not hex.
      const enabled = await b.call("POST", "/api/auth/two-factor/enable", { body: { password: TEST_PASSWORD } })
      expect(enabled.status).toBe(200)
      const uri: string = enabled.json.totpURI
      const label = decodeURIComponent(uri.slice("otpauth://totp/".length, uri.indexOf("?")))
      expect(label).toContain(email)
      expect(label).not.toMatch(/u-[0-9a-f]+@/)
      // The setup page draws it with the username as the account name and Better Auth's query as it is.
      expect(authenticatorUri(uri)).toBe(`otpauth://totp/Adiutor:${name.toLowerCase()}${uri.slice(uri.indexOf("?"))}`)
      const secret = new URL(uri).searchParams.get("secret") ?? ""
      expect((await b.verify(totp(secret))).status).toBe(200)
      const again = browser()
      await again.signIn(secret, name)
      expect((await v1(again)).status).toBe(200)
      const reset = await resetOwnerPassword({ ...testAuthBase(t, new URL(TEST_ORIGIN)), sessionIdleDays: 30 })
      expect(reset?.username).toBe(name.toLowerCase())
      const fresh = browser()
      await fresh.signIn(secret, name, reset?.password)
      expect((await v1(fresh)).status).toBe(200)
    },
  )

  it.each([".alice", "alice.", "a..b"])(
    "refuses %s at sign-up through the username plugin's validator",
    async (name) => {
      const refused = await browser().setup(name)
      expect([refused.status, refused.json.code]).toEqual([400, "INVALID_USERNAME"])
      expect(await t.ctx.db.select().from(authUser)).toHaveLength(0)
    },
  )

  it("creates one owner when sign-ups race", async () => {
    const answers = await Promise.all(["one", "two", "three", "four", "five"].map((n) => browser().setup(`owner_${n}`)))
    expect(answers.filter((a) => a.status === 200)).toHaveLength(1)
    const [row] = await t.ctx.db.select({ n: count() }).from(authUser)
    expect(row?.n).toBe(1)
  })

  it("refuses a sign-up whose e-mail is not the one derived from the username, a bad name or a short password", async () => {
    const wrongEmail = await browser().call("POST", "/api/auth/sign-up/email", {
      body: { name: "owner", email: "owner@example.com", username: "owner", password: TEST_PASSWORD },
    })
    expect([wrongEmail.status, wrongEmail.json.code]).toEqual([400, "INVALID_EMAIL"])
    for (const [username, password] of [
      ["ab", TEST_PASSWORD],
      ["owner-name", TEST_PASSWORD],
      ["owner", "short"],
      ["owner", "p".repeat(129)],
    ] as const)
      expect(
        (
          await browser().call("POST", "/api/auth/sign-up/email", {
            body: { name: username, email: ownerEmail(username), username, password },
          })
        ).status,
      ).toBe(400)
    expect(await t.ctx.db.select().from(authUser)).toHaveLength(0)
  })

  it("rolls the user back when the sign-up fails after writing it (Drizzle with transaction: true)", async () => {
    await t.ctx.db.execute(
      sql.raw("alter table auth_session add constraint test_no_session check (created_at < '2000-01-01') not valid"),
    )
    try {
      const failed = await browser().setup()
      expect(failed.status).toBe(500)
    } finally {
      await t.ctx.db.execute(sql.raw("alter table auth_session drop constraint test_no_session"))
    }
    expect(await t.ctx.db.select().from(authUser)).toHaveLength(0)
    expect((await browser().setup()).status).toBe(200)
  })
})

describe("two-factor, required by Adiutor through the account flag", () => {
  it("enrols with a code: ten backup codes, the flag on, the API open, the audit row", async () => {
    const b = browser()
    await b.setup()
    const enabled = await b.call("POST", "/api/auth/two-factor/enable", { body: { password: TEST_PASSWORD } })
    expect(enabled.status).toBe(200)
    expect(enabled.json.totpURI).toMatch(/^otpauth:\/\/totp\/Adiutor:/)
    expect(enabled.json.backupCodes).toHaveLength(10)
    const secret = new URL(enabled.json.totpURI).searchParams.get("secret") ?? ""
    expect((await b.verify(totp(secret))).status).toBe(200)
    expect((await owner())?.twoFactorEnabled).toBe(true)
    expect((await v1(b)).json.data).toMatchObject({ actor: { kind: "owner", label: "owner.name" }, via: "session" })
    expect((await b.call("GET", "/api/setup/status")).json.data).toEqual({ hasUser: true, session: "active" })
    expect(await actions()).toEqual(["account.setup", "session.sign_in", "account.totp_enable"])
  })

  it("keeps a wrong enrolment code out (V1): 401, the flag stays off, the API answers totp_required", async () => {
    const b = browser()
    await b.setup()
    const { secret } = await b.enable()
    const wrong = await b.verify(wrongTotp(secret))
    expect(wrong.status).toBe(401)
    expect((await owner())?.twoFactorEnabled).toBe(false)
    expect((await v1(b)).json.error.code).toBe("totp_required")
  })

  it("ends a second browser's password-only session when the setup page signs out the others", async () => {
    const setupTab = browser()
    await setupTab.setup()
    const early = browser()
    expect((await early.passwordSignIn()).status).toBe(200)
    expect((await v1(early)).json.error.code).toBe("totp_required")
    const { secret } = await setupTab.enable()
    expect((await setupTab.verify(totp(secret))).status).toBe(200)
    // Better Auth keeps the other session; with two-factor on it would now pass the account check.
    expect((await v1(early)).status).toBe(200)
    // The setup page then calls Better Auth's documented revokeOtherSessions.
    expect((await setupTab.call("POST", "/api/auth/revoke-other-sessions", { body: {} })).status).toBe(200)
    expect((await v1(early)).status).toBe(401)
    expect((await v1(setupTab)).status).toBe(200)
    expect(await actions()).toContain("session.end")
  })

  it("G6, accepted: a password sign-in that read the account before enrolment can keep a session after it", async () => {
    // A second server process on the same database, whose session creation waits at a gate: the password was
    // checked while two-factor was off, and the session row is written after enrolment and its sign-out of others.
    const coreB = testCore(t, { config: { publicUrl: new URL(TEST_ORIGIN), version: "test" } })
    const appB = createApp({ checkDatabase: async () => true, core: coreB })
    const context = await coreB.auth.current.$context
    const original = context.internalAdapter.createSession.bind(context.internalAdapter)
    let open = () => {}
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    let reached = () => {}
    const atGate = new Promise<void>((resolve) => {
      reached = resolve
    })
    const spy = vi.spyOn(context.internalAdapter, "createSession").mockImplementation(async (...args) => {
      reached()
      await gate
      return original(...args)
    })

    const setupTab = browser()
    await setupTab.setup()
    const late = browser(nextIp(), () => appB)
    const pending = late.passwordSignIn()
    await atGate
    const { secret } = await setupTab.enable()
    expect((await setupTab.verify(totp(secret))).status).toBe(200)
    expect((await setupTab.call("POST", "/api/auth/revoke-other-sessions", { body: {} })).status).toBe(200)
    open()
    const signedIn = await pending
    spy.mockRestore()
    // The gap: a session that never passed a second factor, valid because the account now has two-factor on.
    expect(signedIn.status).toBe(200)
    expect(signedIn.json.twoFactorRedirect).toBeUndefined()
    expect((await v1(late)).status).toBe(200)
    expect(await sessions()).toHaveLength(2)
    // Its creation is still in the audit, as a password-stage sign-in: the hook does not decide from the flag.
    const passwordStage = (await auditRows()).filter(
      (r) => r.action === "session.sign_in" && (r.after as { stage?: string }).stage === "password",
    )
    expect(passwordStage).toHaveLength(2)
  })

  it("G7(b), accepted: when the setup page never signs out the others, the older session stays", async () => {
    const setupTab = browser()
    await setupTab.setup()
    const early = browser()
    await early.passwordSignIn()
    const { secret } = await setupTab.enable()
    await setupTab.verify(totp(secret))
    expect((await v1(early)).status).toBe(200)
  })

  it("asks for the code at sign-in and accepts a backup code once", async () => {
    const { backupCodes, secret } = await browser().enrolledOwner()
    const b = browser()
    const first = await b.passwordSignIn()
    expect(first.json.twoFactorRedirect).toBe(true)
    expect(first.json.twoFactorMethods).toEqual(["totp"])
    expect((await v1(b)).status).toBe(401)
    const code = backupCodes[0] as string
    const used = await b.call("POST", "/api/auth/two-factor/verify-backup-code", { body: { code } })
    expect(used.status).toBe(200)
    expect((await v1(b)).status).toBe(200)
    const other = browser()
    await other.passwordSignIn()
    const again = await other.call("POST", "/api/auth/two-factor/verify-backup-code", { body: { code } })
    expect([again.status, again.json.code]).toEqual([401, "INVALID_BACKUP_CODE"])
    await other.signIn(secret)
    const signIns = (await auditRows()).filter((r) => r.action === "session.sign_in").map((r) => r.after)
    expect(signIns).toEqual([
      { stage: "password" },
      { stage: "password" },
      { stage: "second_factor", method: "backup_code" },
      { stage: "password" },
      { stage: "password" },
      { stage: "second_factor", method: "totp" },
    ])
  })

  it("replaces a lost authenticator: disable with the password, then enrol a new one", async () => {
    const b = browser()
    const old = await b.owner()
    const disabled = await b.call("POST", "/api/auth/two-factor/disable", { body: { password: TEST_PASSWORD } })
    expect(disabled.status).toBe(200)
    expect((await v1(b)).json.error.code).toBe("totp_required")
    const { secret } = await b.enable()
    expect(secret).not.toBe(old)
    expect((await b.verify(totp(secret))).status).toBe(200)
    expect((await v1(b)).status).toBe(200)
    const twoFactorActions = (await actions()).filter((a) => a.startsWith("account.totp"))
    expect(twoFactorActions).toEqual(["account.totp_enable", "account.totp_disable", "account.totp_enable"])
  })

  it("new backup codes replace the old ones and are audited", async () => {
    const b = browser()
    const { backupCodes } = await b.enrolledOwner()
    const fresh = await b.call("POST", "/api/auth/two-factor/generate-backup-codes", {
      body: { password: TEST_PASSWORD },
    })
    expect(fresh.status).toBe(200)
    expect(fresh.json.backupCodes).toHaveLength(10)
    const other = browser()
    await other.passwordSignIn()
    const old = await other.call("POST", "/api/auth/two-factor/verify-backup-code", {
      body: { code: backupCodes[0] },
    })
    expect(old.status).toBe(401)
    expect(await actions()).toContain("account.backup_codes_new")
  })

  it("lets a challenge live 180 seconds (twoFactorCookieMaxAge), not Better Auth's default 10 minutes", async () => {
    expect(TWO_FACTOR_CHALLENGE_S).toBe(180)
    const secret = await browser().owner()
    const inTime = browser()
    await inTime.passwordSignIn()
    moveDate(170_000)
    expect((await inTime.verify(totp(secret, Date.now()))).status).toBe(200)
    vi.useRealTimers()

    const late = browser()
    await late.passwordSignIn()
    moveDate(181_000)
    const expired = await late.verify(totp(secret, Date.now()))
    expect([expired.status, expired.json.code]).toEqual([401, "INVALID_TWO_FACTOR_COOKIE"])
  })

  it("locks the account after ten wrong codes (Better Auth's account lockout)", async () => {
    const secret = await browser().owner()
    let locked: { status: number; json: { code?: string } } | undefined
    for (let i = 0; i < 4 && !locked; i++) {
      const b = browser()
      await b.passwordSignIn()
      for (let j = 0; j < 3; j++) {
        const answer = await b.verify(wrongTotp(secret))
        if (answer.status === 429) locked = answer
      }
    }
    const b = browser()
    await b.passwordSignIn()
    const refused = await b.verify(totp(secret))
    expect([refused.status, refused.json.code]).toEqual([429, "ACCOUNT_TEMPORARILY_LOCKED"])
  })
})

describe("trustDevice is refused on every route whose body accepts it", () => {
  /** Signs in with the password and asserts the refusal leaves no trusted device behind. */
  async function refusedWithTrust(b: TestBrowser, path: string, body: Record<string, unknown>) {
    const answer = await b.call("POST", `/api/auth${path}`, { body: { ...body, trustDevice: true } })
    expect([answer.status, answer.json.code]).toEqual([400, "TRUST_DEVICE_UNSUPPORTED"])
    expect(trustCookie(answer.setCookies)).toBe(false)
    expect([...b.cookies.keys()].some((name) => name.includes("trust_device"))).toBe(false)
    const next = await b.passwordSignIn()
    expect(next.json.twoFactorRedirect).toBe(true)
  }

  it("/two-factor/verify-totp", async () => {
    const secret = await browser().owner()
    const b = browser()
    await b.passwordSignIn()
    await refusedWithTrust(b, "/two-factor/verify-totp", { code: totp(secret) })
  })

  it("/two-factor/verify-backup-code", async () => {
    const { backupCodes } = await browser().enrolledOwner()
    const b = browser()
    await b.passwordSignIn()
    await refusedWithTrust(b, "/two-factor/verify-backup-code", { code: backupCodes[0] })
  })

  describe("with sign-in codes sent to Telegram (the owner's choice)", () => {
    let botApi: StandInBotApi
    beforeEach(async () => {
      botApi = await StandInBotApi.start(testBotToken())
      build({ telegramApiUrl: botApi.url })
    })
    afterEach(async () => {
      await core.telegramService.stop()
      await botApi.close()
    })

    async function withOtpOn() {
      const b = browser()
      await b.owner()
      const saved = await b.call("PATCH", "/api/v1/settings", {
        body: { telegramBotToken: botApi.token, telegramChatId: "4242", otpViaTelegram: true },
      })
      expect(saved.status).toBe(200)
      expect(core.auth.settings.otpViaTelegram).toBe(true)
      return b
    }

    it("/two-factor/send-otp", async () => {
      await withOtpOn()
      const b = browser()
      const first = await b.passwordSignIn()
      expect(first.json.twoFactorMethods).toEqual(["totp", "otp"])
      await refusedWithTrust(b, "/two-factor/send-otp", {})
      expect(botApi.sent).toHaveLength(0)
    })

    it("/two-factor/verify-otp, and the code goes to the owner's chat, never to the log", async () => {
      await withOtpOn()
      const lines: string[] = []
      const spies = [
        vi.spyOn(console, "log").mockImplementation((line: unknown) => void lines.push(String(line))),
        vi.spyOn(console, "error").mockImplementation((line: unknown) => void lines.push(String(line))),
      ]
      const b = browser()
      await b.passwordSignIn()
      expect((await b.call("POST", "/api/auth/two-factor/send-otp", { body: {} })).status).toBe(200)
      await waitFor(() => botApi.sent.length === 1)
      const code = /\b(\d{6})\b/.exec(botApi.sent[0]?.text ?? "")?.[1] ?? ""
      expect(botApi.sent[0]?.chatId).toBe("4242")
      await refusedWithTrust(b, "/two-factor/verify-otp", { code })
      for (const spy of spies) spy.mockRestore()
      expect(lines.join("\n")).not.toContain(code)
      // Without trustDevice the same flow signs in.
      const c = browser()
      await c.passwordSignIn()
      await c.call("POST", "/api/auth/two-factor/send-otp", { body: {} })
      await waitFor(() => botApi.sent.length === 2)
      const second = /\b(\d{6})\b/.exec(botApi.sent[1]?.text ?? "")?.[1] ?? ""
      expect((await c.call("POST", "/api/auth/two-factor/verify-otp", { body: { code: second } })).status).toBe(200)
      expect((await v1(c)).status).toBe(200)
    })
  })

  it("keeps the OTP routes closed while sign-in codes to Telegram are off", async () => {
    await browser().owner()
    const b = browser()
    const first = await b.passwordSignIn()
    expect(first.json.twoFactorMethods).toEqual(["totp"])
    expect((await b.call("POST", "/api/auth/two-factor/send-otp", { body: {} })).status).toBe(404)
  })
})

describe("enrolment takes the authenticator app only", () => {
  let botApi: StandInBotApi
  beforeEach(async () => {
    botApi = await StandInBotApi.start(testBotToken())
    build({ telegramApiUrl: botApi.url })
  })
  afterEach(async () => {
    await core.telegramService.stop()
    await botApi.close()
  })

  it("refuses Better Auth's OTP method at enable while sign-in codes go to Telegram, and TOTP still enrols", async () => {
    const b = browser()
    await b.owner()
    const saved = await b.call("PATCH", "/api/v1/settings", {
      body: { telegramBotToken: botApi.token, telegramChatId: "4242", otpViaTelegram: true },
    })
    expect(saved.status).toBe(200)
    // A new authenticator: two-factor is off until the new one is verified, and a password sign-in gets a session.
    const disabled = await b.call("POST", "/api/auth/two-factor/disable", { body: { password: TEST_PASSWORD } })
    expect(disabled.status).toBe(200)
    const other = browser()
    const signedIn = await other.passwordSignIn()
    expect([signedIn.status, signedIn.json.twoFactorRedirect]).toEqual([200, undefined])
    expect((await v1(other)).json.error.code).toBe("totp_required")

    // Any method other than totp is refused, from either browser.
    const enable = (tab: TestBrowser, method: unknown) =>
      tab.call("POST", "/api/auth/two-factor/enable", { body: { password: TEST_PASSWORD, method } })
    for (const [tab, method] of [
      [other, "otp"],
      [other, "OTP"],
      [other, ["otp"]],
      [other, null],
      [b, "otp"],
    ] as const) {
      const refused = await enable(tab, method)
      expect([refused.status, refused.json.code]).toEqual([400, "TOTP_ONLY"])
    }
    expect((await owner())?.twoFactorEnabled).toBe(false)
    expect((await v1(other)).json.error.code).toBe("totp_required")
    expect((await v1(b)).json.error.code).toBe("totp_required")
    expect(botApi.sent).toHaveLength(0)

    // TOTP, named or by default, still enrols; the flag turns on only with the code.
    expect((await enable(b, "totp")).status).toBe(200)
    const { secret } = await b.enable()
    expect((await owner())?.twoFactorEnabled).toBe(false)
    expect((await b.verify(totp(secret))).status).toBe(200)
    expect((await v1(b)).status).toBe(200)
  })
})

describe("the allow-list in hooks.before", () => {
  it("answers 404 over HTTP to every route outside the list; server calls still work", async () => {
    const b = browser()
    await b.owner()
    for (const [method, path, body] of [
      ["POST", "/sign-in/email", { email: ownerEmail("owner.name"), password: TEST_PASSWORD }],
      ["POST", "/update-user", { name: "x" }],
      ["GET", "/reset-password/abc123?callbackURL=/", undefined],
      ["GET", "/callback/x", undefined],
      ["POST", "/request-password-reset", { email: ownerEmail("owner.name") }],
      ["POST", "/reset-password", { token: "x", newPassword: TEST_PASSWORD }],
      ["GET", "/list-accounts", undefined],
      ["POST", "/api-key/update", { keyId: "x", name: "y" }],
      ["GET", "/api-key/get?id=x", undefined],
      ["POST", "/two-factor/get-totp-uri", { password: TEST_PASSWORD }],
      ["POST", "/two-factor/view-backup-codes", { userId: "x" }],
    ] as const) {
      const answer = await b.call(method, `/api/auth${path}`, body === undefined ? {} : { body })
      expect([method, path, answer.status]).toEqual([method, path, 404])
    }
    const headers = new Headers({ cookie: b.cookieHeader })
    const accounts = await core.auth.current.api.listUserAccounts({ headers })
    expect(accounts).toHaveLength(1)
  })

  it("refuses a cookie-carrying change from another origin (403) and a body that is not JSON (415)", async () => {
    const b = browser()
    await b.owner()
    const evil = await b.call("POST", "/api/auth/sign-out", { body: {}, headers: { origin: "https://evil.example" } })
    expect(evil.status).toBe(403)
    const plain = await app.fetch(
      new Request(`${TEST_ORIGIN}/api/auth/sign-in/username`, {
        method: "POST",
        headers: { "content-type": "text/plain", origin: TEST_ORIGIN, "x-forwarded-for": nextIp() },
        body: JSON.stringify({ username: TEST_USERNAME, password: TEST_PASSWORD }),
      }),
    )
    expect(plain.status).toBe(415)
    expect((await v1(b)).status).toBe(200)
  })
})

describe("rate limits keyed on X-Forwarded-For", () => {
  it("allows 5 sign-in attempts per 5 minutes per address", async () => {
    await browser().owner()
    const ip = nextIp()
    for (let i = 0; i < 5; i++)
      expect((await browser(ip).passwordSignIn(TEST_USERNAME, "wrong password 123")).status).toBe(401)
    expect((await browser(ip).passwordSignIn()).status).toBe(429)
    expect((await browser().passwordSignIn()).status).toBe(200)
  })

  it("behind trusted proxies, a forged leftmost address does not change the key", async () => {
    build({ auth: { trustedProxies: ["192.0.2.0/24"] } })
    await browser().owner()
    const client = "203.0.113.5"
    for (let i = 0; i < 5; i++) {
      const forged = browser(`198.51.100.${200 + i}, ${client}, 192.0.2.10`)
      expect((await forged.passwordSignIn(TEST_USERNAME, "wrong password 123")).status).toBe(401)
    }
    expect((await browser(`198.51.100.250, ${client}, 192.0.2.10`).passwordSignIn()).status).toBe(429)
    expect((await browser(`203.0.113.6, 192.0.2.10`).passwordSignIn()).status).toBe(200)
  })
})

describe("password, sessions and sign-out on Better Auth's routes", () => {
  it("changes the password and signs out the other browsers in one step", async () => {
    const a = browser()
    const secret = await a.owner()
    const b = browser()
    await b.signIn(secret)
    const changed = await a.call("POST", "/api/auth/change-password", {
      body: { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD, revokeOtherSessions: true },
    })
    expect(changed.status).toBe(200)
    expect((await v1(a)).status).toBe(200)
    expect((await v1(b)).status).toBe(401)
    expect((await browser().passwordSignIn(TEST_USERNAME, TEST_PASSWORD)).status).toBe(401)
    expect((await browser().passwordSignIn(TEST_USERNAME, NEW_PASSWORD)).json.twoFactorRedirect).toBe(true)
    expect(await actions()).toContain("account.password_change")
  })

  it("keeps the old password when the change fails after writing it (Drizzle with transaction: true)", async () => {
    const a = browser()
    await a.owner()
    await t.ctx.db.execute(
      sql.raw("alter table auth_session add constraint test_no_session check (created_at < '2000-01-01') not valid"),
    )
    try {
      const failed = await a.call("POST", "/api/auth/change-password", {
        body: { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD, revokeOtherSessions: true },
      })
      expect(failed.status).toBe(500)
    } finally {
      await t.ctx.db.execute(sql.raw("alter table auth_session drop constraint test_no_session"))
    }
    expect((await browser().passwordSignIn(TEST_USERNAME, TEST_PASSWORD)).json.twoFactorRedirect).toBe(true)
  })

  it("lists, signs out the others and signs out everywhere, also in a session older than a day (freshAge 0)", async () => {
    const a = browser()
    const secret = await a.owner()
    const b = browser()
    await b.signIn(secret)
    const c = browser()
    await c.signIn(secret)
    moveDate(2 * DAY)
    const listed = await a.call("GET", "/api/auth/list-sessions")
    expect(listed.status).toBe(200)
    expect(listed.json).toHaveLength(3)
    expect((await a.call("POST", "/api/auth/revoke-other-sessions", { body: {} })).status).toBe(200)
    expect((await v1(b)).status).toBe(401)
    expect((await v1(a)).status).toBe(200)
    expect((await a.call("POST", "/api/auth/revoke-sessions", { body: {} })).status).toBe(200)
    expect((await v1(a)).status).toBe(401)
    expect(await sessions()).toHaveLength(0)
    const ends = (await auditRows()).filter((r) => r.action === "session.end").map((r) => r.after)
    expect(ends).toEqual([
      { via: "revoke-other-sessions" },
      { via: "revoke-other-sessions" },
      { via: "revoke-sessions" },
    ])
  })

  it("signs out and records it after the fact", async () => {
    const b = browser()
    await b.owner()
    expect((await b.call("POST", "/api/auth/sign-out", { body: {} })).status).toBe(200)
    expect((await v1(b)).status).toBe(401)
    expect((await actions()).at(-1)).toBe("session.sign_out")
  })
})

describe("audit rows from the documented hooks, and their refusals", () => {
  afterEach(acceptAudit)

  it("a failing audit write refuses the password change, the 2FA change, sign-out of others and key creation", async () => {
    const b = browser()
    const secret = await b.owner()
    const other = browser()
    await other.signIn(secret)

    await refuseAudit("account.password_change")
    const password = await b.call("POST", "/api/auth/change-password", {
      body: { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD },
    })
    expect(password.status).toBe(500)
    expect((await browser().passwordSignIn()).json.twoFactorRedirect).toBe(true)
    await acceptAudit()

    await refuseAudit("account.totp_disable")
    const disable = await b.call("POST", "/api/auth/two-factor/disable", { body: { password: TEST_PASSWORD } })
    expect(disable.status).toBe(500)
    expect((await owner())?.twoFactorEnabled).toBe(true)
    expect(await t.ctx.db.select().from(authTwoFactor)).toHaveLength(1)
    await acceptAudit()

    await refuseAudit("session.end")
    expect((await b.call("POST", "/api/auth/revoke-sessions", { body: {} })).status).toBe(500)
    expect(await sessions()).toHaveLength(2)
    await acceptAudit()

    await refuseAudit("api_key.create")
    expect((await b.call("POST", "/api/auth/api-key/create", { body: { name: "sync" } })).status).toBe(500)
    expect(await t.ctx.db.select().from(authApiKey)).toHaveLength(0)
  })

  it("a failing sign-out audit never leaves the session valid (the hook runs after the fact and never throws)", async () => {
    const b = browser()
    await b.owner()
    await refuseAudit("session.sign_out")
    expect((await b.call("POST", "/api/auth/sign-out", { body: {} })).status).toBe(200)
    expect((await v1(b)).status).toBe(401)
    expect(await sessions()).toHaveLength(0)
  })

  it("G5, accepted: a refused change after its row leaves the row (the audit is on Adiutor's own connection)", async () => {
    const b = browser()
    await b.owner()
    await t.ctx.db.execute(
      sql.raw("alter table auth_session add constraint test_no_session check (created_at < '2000-01-01') not valid"),
    )
    try {
      await b.call("POST", "/api/auth/change-password", {
        body: { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD, revokeOtherSessions: true },
      })
    } finally {
      await t.ctx.db.execute(sql.raw("alter table auth_session drop constraint test_no_session"))
    }
    expect(await actions()).toContain("account.password_change")
    expect((await browser().passwordSignIn(TEST_USERNAME, TEST_PASSWORD)).json.twoFactorRedirect).toBe(true)
  })
})

describe("signing out after days without Adiutor open (sliding expiresIn, deferSessionRefresh)", () => {
  const expiry = async () => (await sessions())[0]?.expiresAt.getTime() ?? 0

  it("never extends a session on a read; a POST /get-session does", async () => {
    const b = browser()
    await b.owner()
    await b.call("POST", "/api/auth/revoke-other-sessions", { body: {} })
    const start = await expiry()
    moveDate(2 * HOUR)
    const read = await b.call("GET", "/api/auth/get-session")
    expect(read.json.needsRefresh).toBe(true)
    await b.call("GET", "/api/auth/list-sessions")
    await v1(b)
    await core.auth.current.api.getSession({ headers: new Headers({ cookie: b.cookieHeader }) })
    expect(await expiry()).toBe(start)
    const refreshed = await b.call("POST", "/api/auth/get-session", { body: {} })
    expect(refreshed.status).toBe(200)
    expect(await expiry()).toBeGreaterThan(start + HOUR)
  })

  describe("through the real Node adapter (@hono/node-server), as the browser sends it", () => {
    let server: ServerType
    let base = ""
    beforeEach(async () => {
      server = serve({ fetch: (request) => app.fetch(request), port: 0, hostname: "127.0.0.1" })
      await new Promise<void>((resolve) => server.once("listening", () => resolve()))
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    })
    afterEach(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })

    it("the client's bodiless POST /get-session extends the session (the transport fix in app.ts)", async () => {
      const b = browser()
      await b.owner()
      await b.call("POST", "/api/auth/revoke-other-sessions", { body: {} })
      await t.ctx.db.execute(
        sql`update auth_session set expires_at = expires_at - interval '2 hours', updated_at = updated_at - interval '2 hours'`,
      )
      const start = await expiry()
      // No body: fetch sends Content-Length: 0, and node-server still attaches an (empty) body stream.
      const answer = await fetch(`${base}/api/auth/get-session`, {
        method: "POST",
        headers: { cookie: b.cookieHeader, origin: TEST_ORIGIN, "x-forwarded-for": nextIp() },
      })
      expect(answer.status).toBe(200)
      expect(((await answer.json()) as { session?: unknown }).session).toBeTruthy()
      expect(await expiry()).toBeGreaterThan(start + HOUR)
    })

    it("a request with a real body keeps Better Auth's own Content-Type checks", async () => {
      await browser().owner()
      const ip = nextIp()
      const asText = await fetch(`${base}/api/auth/sign-in/username`, {
        method: "POST",
        headers: { "content-type": "text/plain", origin: TEST_ORIGIN, "x-forwarded-for": ip },
        body: JSON.stringify({ username: TEST_USERNAME, password: TEST_PASSWORD }),
      })
      expect(asText.status).toBe(415)
      const untyped = await fetch(`${base}/api/auth/sign-in/username`, {
        method: "POST",
        headers: { origin: TEST_ORIGIN, "x-forwarded-for": ip },
        body: new Blob([JSON.stringify({ username: TEST_USERNAME, password: TEST_PASSWORD })]),
      })
      expect(untyped.status).toBe(415)
      const asJson = await fetch(`${base}/api/auth/sign-in/username`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: TEST_ORIGIN, "x-forwarded-for": ip },
        body: JSON.stringify({ username: TEST_USERNAME, password: TEST_PASSWORD }),
      })
      expect(asJson.status).toBe(200)
      expect(((await asJson.json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(true)
    })
  })

  it("lets Adiutor's own polling alone run out: the session ends after the set days", async () => {
    const b = browser()
    await b.owner()
    for (let day = 1; day <= 31; day++) {
      vi.useFakeTimers({ toFake: ["Date"] })
      vi.setSystemTime(Date.now() + DAY)
      await v1(b, "/morning")
    }
    expect((await v1(b)).status).toBe(401)
  })

  it("applies a new length by swapping the instance live; requests in flight finish", async () => {
    const b = browser()
    const secret = await b.owner()
    const inFlight = browser().signIn(secret)
    const before = core.auth.current
    await b.call("PATCH", "/api/v1/settings", { body: { sessionIdleDays: 10 } })
    expect(core.auth.current).not.toBe(before)
    expect(core.auth.settings.sessionIdleDays).toBe(10)
    await inFlight
    // A new sign-in gets the new length.
    const c = browser()
    await c.signIn(secret)
    const newest = (await sessions()).sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime())[0]
    const left = (newest?.expiresAt.getTime() ?? 0) - Date.now()
    expect(left).toBeGreaterThan(10 * DAY - HOUR)
    expect(left).toBeLessThanOrEqual(10 * DAY + 1000)
  })

  it("G2: a shorter length applies only once the time left falls under it minus updateAge", async () => {
    const b = browser()
    await b.owner()
    await b.call("POST", "/api/auth/revoke-other-sessions", { body: {} })
    const start = await expiry()
    expect(start - Date.now()).toBeGreaterThan(29 * DAY)
    core.auth.apply({ sessionIdleDays: 10, otpViaTelegram: false })
    const refresh = () => b.call("POST", "/api/auth/get-session", { body: {} })
    await refresh()
    expect(await expiry()).toBe(start)
    // 10 days left: not yet (the refresh needs expiresIn - updateAge, 10 days less one hour, or less left).
    moveDate(20 * DAY)
    await refresh()
    expect(await expiry()).toBe(start)
    vi.useRealTimers()
    // A minute past the boundary: the session gets the new length from now.
    moveDate(20 * DAY + HOUR + 60_000)
    await refresh()
    const now = Date.now()
    expect((await expiry()) - now).toBeGreaterThan(10 * DAY - 60_000)
    expect((await expiry()) - now).toBeLessThanOrEqual(10 * DAY + 1000)
  })
})

describe("agent keys (Better Auth's api-key plugin)", () => {
  it("creates adt_ keys from a signed-in browser with two-factor, refuses another prefix, revokes by deleting", async () => {
    const b = browser()
    await b.owner()
    const created = await b.call("POST", "/api/auth/api-key/create", { body: { name: "sync" } })
    expect(created.status).toBe(200)
    expect(created.json.key).toMatch(/^adt_[A-Za-z]{64}$/)
    const prefixed = await b.call("POST", "/api/auth/api-key/create", { body: { name: "x", prefix: "xyz_" } })
    expect([prefixed.status, prefixed.json.code]).toEqual([400, "INVALID_KEY_PREFIX"])
    const [stored] = await t.ctx.db.select().from(authApiKey)
    expect(stored?.key).not.toBe(created.json.key)
    expect(stored?.start).toBe(created.json.key.slice(0, 6))
    expect(stored?.rateLimitEnabled).toBe(false)

    const key = created.json.key as string
    const agent = await app.request("/api/v1/session", { headers: { authorization: `Bearer ${key}` } })
    expect(((await agent.json()) as { data: { actor: unknown } }).data.actor).toEqual({ kind: "agent", label: "agent" })
    // Never a session: Better Auth does not take it as one, and the Authorization header is refused outright.
    const asSession = await app.request("/api/auth/get-session", { headers: { "x-api-key": key } })
    expect(await asSession.json()).toBeNull()
    const asBearer = await app.request("/api/auth/get-session", { headers: { authorization: `Bearer ${key}` } })
    expect([asBearer.status, ((await asBearer.json()) as { code: string }).code]).toEqual([
      403,
      "AUTHORIZATION_NOT_ALLOWED",
    ])
    // Many verifications in a row: the plugin's own limit (10 a day by default) is off.
    for (let i = 0; i < 12; i++)
      expect((await app.request("/api/v1/projects", { headers: { authorization: `Bearer ${key}` } })).status).toBe(200)

    const listed = await b.call("GET", "/api/auth/api-key/list")
    expect(listed.json.apiKeys ?? listed.json).toHaveLength(1)
    expect((await b.call("POST", "/api/auth/api-key/delete", { body: { keyId: stored?.id } })).status).toBe(200)
    expect((await app.request("/api/v1/projects", { headers: { authorization: `Bearer ${key}` } })).status).toBe(401)
    expect((await actions()).filter((a) => a.startsWith("api_key."))).toEqual(["api_key.create", "api_key.delete"])
  })

  it("never lets a session stand in for a key: MCP and sync pushes refuse a cookie", async () => {
    const b = browser()
    await b.owner()
    const mcp = await b.call("POST", "/mcp", {
      body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      headers: { accept: "application/json, text/event-stream" },
    })
    expect(mcp.status).toBe(401)
    const snapshot = { collectedAt: new Date().toISOString(), projects: [], threads: [] }
    expect((await b.call("POST", "/api/v1/sync/t3", { body: snapshot })).status).toBe(403)
  })

  it("G18, accepted: an account without two-factor cannot create keys, but a leftover password-only session can later", async () => {
    const setupTab = browser()
    await setupTab.setup()
    const early = browser()
    await early.passwordSignIn()
    const refused = await early.call("POST", "/api/auth/api-key/create", { body: { name: "early" } })
    expect([refused.status, refused.json.code]).toEqual([403, "TOTP_REQUIRED"])
    const { secret } = await setupTab.enable()
    await setupTab.verify(totp(secret))
    // The setup page's revokeOtherSessions did not run (G7(b)): the old session now passes the account check.
    const later = await early.call("POST", "/api/auth/api-key/create", { body: { name: "early" } })
    expect(later.status).toBe(200)
    // A key outlives "Sign out everywhere".
    await setupTab.call("POST", "/api/auth/revoke-sessions", { body: {} })
    const key = later.json.key as string
    expect((await app.request("/api/v1/projects", { headers: { authorization: `Bearer ${key}` } })).status).toBe(200)
  })
})

describe("recovery: the CLI runs Better Auth's documented reset", () => {
  it("sets a new password, ends every session, keeps two-factor, and the reset routes stay closed over HTTP", async () => {
    const b = browser()
    const secret = await b.owner()
    const other = browser()
    await other.signIn(secret)
    const result = await resetOwnerPassword({
      ...testAuthBase(t, new URL(TEST_ORIGIN)),
      sessionIdleDays: (await getSettings(t.ctx.db)).sessionIdleDays,
    })
    expect(result?.username).toBe("owner.name")
    expect(await sessions()).toHaveLength(0)
    expect((await owner())?.twoFactorEnabled).toBe(true)
    expect((await browser().passwordSignIn()).status).toBe(401)
    const fresh = browser()
    await fresh.signIn(secret, TEST_USERNAME, result?.password)
    expect((await v1(fresh)).status).toBe(200)
    const rows = (await auditRows()).filter((r) => r.source === "cli")
    expect(rows.map((r) => [r.action, r.actorLabel])).toEqual([
      ["session.end", "cli"],
      ["session.end", "cli"],
      ["account.password_reset", "cli"],
    ])
    expect(
      (await browser().call("POST", "/api/auth/request-password-reset", { body: { email: ownerEmail("owner.name") } }))
        .status,
    ).toBe(404)
  })

  it("G3, accepted: a challenge opened before the reset can still be finished within its 180 seconds", async () => {
    const secret = await browser().owner()
    const attacker = browser()
    expect((await attacker.passwordSignIn()).json.twoFactorRedirect).toBe(true)
    await resetOwnerPassword({ ...testAuthBase(t, new URL(TEST_ORIGIN)), sessionIdleDays: 30 })
    expect((await attacker.verify(totp(secret))).status).toBe(200)
  })

  it("answers null without an owner", async () => {
    expect(await resetOwnerPassword({ ...testAuthBase(t, new URL(TEST_ORIGIN)), sessionIdleDays: 30 })).toBeNull()
  })
})

describe("secrets and logging", () => {
  it("still verifies TOTP after rotating to 2:new,1:old", async () => {
    const secret = await browser().owner()
    const rotated = testSecret()
    build({
      auth: {
        secrets: [
          { version: 2, value: rotated },
          { version: 1, value: TEST_AUTH_SECRET },
        ],
      },
    })
    const b = browser()
    await b.signIn(secret)
    expect((await v1(b)).status).toBe(200)
  })

  it("logs a failed sign-in's database error without its query, parameters or token", async () => {
    await browser().enrolledOwner()
    await t.ctx.db.execute(sql`delete from auth_two_factor`)
    await t.ctx.db.execute(sql`update auth_user set two_factor_enabled = false`)
    await t.ctx.db.execute(
      sql.raw("alter table auth_session add constraint test_no_session check (created_at < '2000-01-01') not valid"),
    )
    const lines: string[] = []
    const spies = [
      vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" "))),
      vi
        .spyOn(console, "error")
        .mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" "))),
      vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" "))),
    ]
    try {
      const answer = await browser().passwordSignIn()
      expect([answer.status, answer.json?.error?.code]).toEqual([500, "internal_error"])
    } finally {
      for (const spy of spies) spy.mockRestore()
      await t.ctx.db.execute(sql.raw("alter table auth_session drop constraint test_no_session"))
    }
    const logged = lines.join("\n")
    expect(logged).toContain('"sqlstate":"23514"')
    expect(logged).not.toMatch(/insert into|params|owner\.name/i)
    expect(inspect(logged)).not.toContain(TEST_PASSWORD)
  })
})
