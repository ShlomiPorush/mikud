import { apiKey } from "@better-auth/api-key"
import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { APIError, createAuthMiddleware } from "better-auth/api"
import { bearer, deviceAuthorization, twoFactor, username } from "better-auth/plugins"
import {
  AGENT_KEY_DAYS_MAX,
  AGENT_KEY_DAYS_MIN,
  AGENT_KEY_NAME_MAX,
  AGENT_KEY_PREFIX,
  CONNECT_CLIENT_ID,
  CONNECT_DEVICE_PATH,
  isValidUsername,
  ownerEmail,
} from "../../shared/auth.ts"
import type { VersionedKey } from "../config.ts"
import {
  authAccount,
  authApiKey,
  authDeviceCode,
  authRateLimit,
  authSession,
  authTwoFactor,
  authUser,
  authVerification,
} from "../db/schema.ts"
import { errorFacts, log } from "../log.ts"
import type { By, Ctx } from "../services/context.ts"
import { writeAudit } from "../services/context.ts"

// Better Auth as it documents itself: its routes, its plugins (username, twoFactor, api-key, deviceAuthorization,
// bearer), its options and its documented hooks. Adiutor does not wrap its handler. The hooks below only refuse (a
// closed route, a second owner, a trusted device, an agent key or an agent approval without two-factor, an
// Authorization header outside what `adiutor connect` needs) and write audit rows; Better Auth makes every decision
// about passwords, sessions and codes. See "Security design" in docs/project-foundation.md for what this leaves open.

const DAY_S = 86_400
const HOUR_S = 3_600

/** How long a two-factor challenge (after the password, before the code) lives: 3 minutes, not 10. */
export const TWO_FACTOR_CHALLENGE_S = 180

/**
 * The only /api/auth routes a browser may call (matched on Better Auth's route pattern, `ctx.path`). Everything else
 * answers 404 over HTTP, including routes a future Better Auth version adds. Server calls (`auth.api.*`) are not
 * HTTP requests and are not limited by this list: the recovery CLI resets the password through them.
 */
export const ALLOWED_PATHS = [
  "/ok",
  "/get-session",
  "/sign-up/email",
  "/sign-in/username",
  "/sign-out",
  "/change-password",
  "/list-sessions",
  "/revoke-other-sessions",
  "/revoke-sessions",
  "/revoke-session",
  "/two-factor/enable",
  "/two-factor/disable",
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
  "/two-factor/generate-backup-codes",
  "/api-key/create",
  "/api-key/list",
  "/api-key/delete",
  // Agent approval (deviceAuthorization): the CLI asks for a code and polls for its answer without a session; the
  // owner's signed-in browser claims the code (GET /device), then approves or denies it.
  "/device/code",
  "/device/token",
  "/device",
  "/device/approve",
  "/device/deny",
] as const

/**
 * The only routes an HTTP request with an `Authorization` header reaches. bearer() turns `Authorization: Bearer
 * <session token>` into a session on every route; Adiutor lets the header through only where `adiutor connect` uses its
 * device session: create its one key, then end that same session (/revoke-session, its own token only). Everything
 * else, listing the sessions included, refuses the header, with or without a cookie.
 */
export const BEARER_PATHS = ["/api-key/create", "/revoke-session"] as const

/** Where the owner's browser decides about an agent approval: open only once the account has two-factor on. */
export const DEVICE_DECISION_PATHS = ["/device", "/device/approve", "/device/deny"] as const

/** The device code lives 10 minutes; the CLI polls every 5 seconds (the plugin answers slow_down when faster). */
export const DEVICE_CODE_LIFETIME = "10m"
export const DEVICE_POLL_INTERVAL = "5s"

/** Routes of Better Auth's two-factor OTP: open only while the owner sends sign-in codes to Telegram. */
export const OTP_PATHS = ["/two-factor/send-otp", "/two-factor/verify-otp"] as const

/** Every route whose body accepts `trustDevice` (a 30-day cookie that skips the code). Adiutor refuses it. */
export const TRUST_DEVICE_PATHS = [
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
  "/two-factor/verify-otp",
  "/two-factor/send-otp",
] as const

/** Credential routes: 5 attempts per 5 minutes per address and route. */
const CREDENTIAL_PATHS = [
  "/sign-up/email",
  "/sign-in/username",
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
  "/two-factor/enable",
  "/two-factor/disable",
  "/two-factor/generate-backup-codes",
  "/change-password",
  ...OTP_PATHS,
]

/** New agent approval codes: 10 per 10 minutes per address. */
const DEVICE_CODE_RULE = { window: 600, max: 10 }

/**
 * Polling for an approval. Better Auth counts a route's requests until the route has been quiet for a whole window, so
 * the global 100 per minute ends a 5-second poll after about 8 minutes, while a code lives 10. This allows the whole
 * code lifetime at 5 seconds, twice over, for one address.
 */
const DEVICE_TOKEN_RULE = { window: 900, max: 300 }

/** Paths whose session deletions are ended sessions (one audit row each). Sign-out is audited after the fact. */
const SESSION_END_PATHS = new Set(["/revoke-other-sessions", "/revoke-sessions", "/reset-password"])

/** Second-factor routes and the method each one records at sign-in. */
const SECOND_FACTOR: Record<string, string> = {
  "/two-factor/verify-totp": "totp",
  "/two-factor/verify-backup-code": "backup_code",
  "/two-factor/verify-otp": "otp",
}

export type AuthSettings = {
  /** Settings: sign out after this many days without a refresh by the Better Auth client. */
  sessionIdleDays: number
  /** Settings: Better Auth's two-factor OTP through the Telegram bot. Off by default. */
  otpViaTelegram: boolean
}

export type AuthOptions = AuthSettings & {
  ctx: Ctx
  /** ADIUTOR_AUTH_SECRETS: Better Auth's versioned `secrets`. */
  secrets: VersionedKey[]
  publicUrl: URL
  /** ADIUTOR_TRUSTED_PROXIES: the proxies whose X-Forwarded-For hop Better Auth skips. */
  trustedProxies: string[]
  /** Sends a sign-in code to the owner's Telegram chat; used only while otpViaTelegram is on. */
  sendOtp?: (code: string) => Promise<void>
  /** The recovery CLI only: receives the reset token instead of sending it anywhere. */
  sendResetPassword?: (token: string) => Promise<void>
}

type OwnerRow = { id: string; username: string; twoFactorEnabled: boolean }

/** The one owner, read on Adiutor's own connection (outside Better Auth's transaction), or null before setup. */
async function readOwner(ctx: Ctx): Promise<OwnerRow | null> {
  const [row] = await ctx.db
    .select({
      id: authUser.id,
      username: authUser.username,
      name: authUser.name,
      twoFactorEnabled: authUser.twoFactorEnabled,
    })
    .from(authUser)
    .limit(1)
  return row
    ? { id: row.id, username: row.username ?? row.name, twoFactorEnabled: row.twoFactorEnabled === true }
    : null
}

type HookContext = { path?: string; request?: Request; context?: { session?: unknown } } | null | undefined

const refuse = (status: "NOT_FOUND" | "FORBIDDEN" | "BAD_REQUEST", code: string, message: string) =>
  new APIError(status, { code, message })

/** The value of `Authorization: Bearer <value>`, or null for another scheme or none. */
function bearerValue(header: string | null): string | null {
  const match = /^bearer\s+(\S+)\s*$/i.exec(header ?? "")
  return match?.[1] ?? null
}

/**
 * Better Auth for the one owner: username and password, then TOTP (or a backup code), and agent keys. The instance
 * is rebuilt when a setting it reads changes (AuthHolder).
 */
export function createAuth(options: AuthOptions) {
  const { ctx, publicUrl } = options
  const otp = options.otpViaTelegram && options.sendOtp ? options.sendOtp : undefined
  const allowed = new Set<string>([...ALLOWED_PATHS, ...(otp ? OTP_PATHS : [])])
  const bearerPaths = new Set<string>(BEARER_PATHS)
  const deviceDecision = new Set<string>(DEVICE_DECISION_PATHS)

  const ownerBy = (owner: OwnerRow | null): By => ({
    actor: { kind: "owner", label: owner?.username ?? "owner" },
    source: "ui",
  })
  const audit = async (by: By, action: string, entityType: string, after?: unknown, entityId: string | null = null) =>
    writeAudit(ctx, ctx.db, by, { action, entityType, entityId, after })

  /** One documented `hooks.before`: the allow-list, the refusals and the audit rows that may refuse. */
  const beforeAuthRoute = createAuthMiddleware(async (c) => {
    const path = c.path
    const http = Boolean(c.request)
    if (http && !allowed.has(path)) throw refuse("NOT_FOUND", "NOT_FOUND", "Nothing is here.")
    const body = (c.body ?? {}) as Record<string, unknown>
    // This hook runs before bearer()'s own, so it sees the header as the client sent it.
    const authorization = c.request?.headers.get("authorization") ?? null
    const viaBearer = http && authorization !== null
    if (viaBearer) {
      if (!bearerPaths.has(path))
        throw refuse("FORBIDDEN", "AUTHORIZATION_NOT_ALLOWED", "This route takes the browser's session only.")
      if (path === "/revoke-session" && (typeof body.token !== "string" || body.token !== bearerValue(authorization)))
        throw refuse("FORBIDDEN", "OWN_SESSION_ONLY", "A session sent as a bearer can end only itself.")
    }

    if (path === "/sign-up/email") {
      if (await readOwner(ctx)) throw refuse("FORBIDDEN", "ALREADY_SET_UP", "Adiutor already has its owner.")
      if (typeof body.username !== "string" || body.email !== ownerEmail(body.username))
        throw refuse("BAD_REQUEST", "INVALID_EMAIL", "The e-mail must be the one Adiutor derives from the username.")
      return
    }
    if ((TRUST_DEVICE_PATHS as readonly string[]).includes(path) && body.trustDevice)
      throw refuse("BAD_REQUEST", "TRUST_DEVICE_UNSUPPORTED", "Adiutor asks for the code at every sign-in.")
    // Enrolment takes the authenticator app only (totp, Better Auth's default); a Telegram code is for sign-in.
    if (path === "/two-factor/enable" && body.method !== undefined && body.method !== "totp")
      throw refuse("BAD_REQUEST", "TOTP_ONLY", "Two-factor is set up with an authenticator app.")
    if (path === "/two-factor/generate-backup-codes") {
      await audit(ownerBy(await readOwner(ctx)), "account.backup_codes_new", "account")
      return
    }
    if (http && deviceDecision.has(path)) {
      // The owner's account must have two-factor on before any browser may see, approve or deny a request.
      const owner = await readOwner(ctx)
      if (!owner?.twoFactorEnabled)
        throw refuse("FORBIDDEN", "TOTP_REQUIRED", "Set up two-factor authentication first.")
      if (path === "/device/approve") await audit(ownerBy(owner), "device.approve", "device_code")
      else if (path === "/device/deny") await audit(ownerBy(owner), "device.deny", "device_code")
      return
    }
    if (path.startsWith("/api-key/")) {
      const owner = await readOwner(ctx)
      // Browsers only: server calls (verifying a key) keep working while the owner sets up a new authenticator.
      if (http && !owner?.twoFactorEnabled)
        throw refuse("FORBIDDEN", "TOTP_REQUIRED", "Set up two-factor authentication first.")
      const by: By = http
        ? { ...ownerBy(owner), source: viaBearer ? "api" : "ui" }
        : { actor: { kind: "system", label: "system" }, source: "api" }
      if (path === "/api-key/create") {
        if (body.prefix !== undefined && body.prefix !== AGENT_KEY_PREFIX)
          throw refuse("BAD_REQUEST", "INVALID_KEY_PREFIX", `Agent keys start with ${AGENT_KEY_PREFIX}.`)
        // The plugin applies keyExpiration's bounds only to an expiresIn it is given, and stores a key without one
        // with no end. Every key a request creates names its end, so the bounds always apply.
        if (http && typeof body.expiresIn !== "number")
          throw refuse(
            "BAD_REQUEST",
            "EXPIRES_IN_REQUIRED",
            `Agent keys end after ${AGENT_KEY_DAYS_MIN} to ${AGENT_KEY_DAYS_MAX} days: send expiresIn in seconds.`,
          )
        await audit(by, "api_key.create", "api_key", {
          name: typeof body.name === "string" ? body.name.slice(0, AGENT_KEY_NAME_MAX) : null,
          ...(typeof body.expiresIn === "number" ? { expiresIn: body.expiresIn } : {}),
        })
      } else if (path === "/api-key/delete") {
        const keyId = typeof body.keyId === "string" ? body.keyId.slice(0, 100) : null
        await audit(by, "api_key.delete", "api_key", undefined, keyId)
      }
    }
  })

  /**
   * One documented `hooks.after`: the rows of a sign-out and of one ended session. A throwing hook on sign-out would be
   * swallowed by Better Auth and leave the session valid, and a refused /revoke-session would leave the device session
   * of `adiutor connect` alive: both are recorded after the fact, and this hook never throws.
   */
  const auditAfterTheFact = createAuthMiddleware(async (c) => {
    if (c.path !== "/sign-out" && c.path !== "/revoke-session") return
    const returned = (c.context as { returned?: unknown }).returned
    if (returned instanceof APIError || returned instanceof Error) return
    try {
      const by = ownerBy(await readOwner(ctx))
      if (c.path === "/sign-out") await audit(by, "session.sign_out", "session")
      else {
        const viaBearer = Boolean(c.request?.headers.get("authorization"))
        await audit({ ...by, source: viaBearer ? "api" : "ui" }, "session.revoke", "session")
      }
    } catch (error) {
      log.error("the session audit row was not written", errorFacts(error))
    }
  })

  const pathOf = (context: HookContext) => context?.path ?? ""
  const viaHttp = (context: HookContext) => Boolean(context?.request)

  return betterAuth({
    appName: "Adiutor",
    secrets: options.secrets.map((k) => ({ version: k.version, value: k.value })),
    basePath: "/api/auth",
    baseURL: publicUrl.origin,
    trustedOrigins: [publicUrl.origin],
    telemetry: { enabled: false },
    // Better Auth would log the raw error, whose message can hold a failed query with its parameters. Its own lines
    // go through logBetterAuth; an error that is not an APIError leaves the handler (onAPIError.throw) and Adiutor's
    // app.onError logs only errorFacts.
    logger: { level: "error", log: logBetterAuth },
    onAPIError: { throw: true },
    database: drizzleAdapter(ctx.db, {
      provider: "pg",
      transaction: true,
      schema: {
        user: authUser,
        session: authSession,
        account: authAccount,
        verification: authVerification,
        twoFactor: authTwoFactor,
        rateLimit: authRateLimit,
        apikey: authApiKey,
        deviceCode: authDeviceCode,
      },
    }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true,
      ...(options.sendResetPassword
        ? {
            sendResetPassword: async ({ token }: { token: string }) => {
              await options.sendResetPassword?.(token)
            },
          }
        : {}),
    },
    // The sliding idle limit. GET reads never extend a session (deferSessionRefresh); the Better Auth client's own
    // refresh (POST /get-session) does, at most once per updateAge. freshAge 0: listing sessions works in any session.
    session: {
      expiresIn: options.sessionIdleDays * DAY_S,
      updateAge: HOUR_S,
      deferSessionRefresh: true,
      freshAge: 0,
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 100,
      customRules: {
        ...Object.fromEntries(CREDENTIAL_PATHS.map((p) => [p, { window: 300, max: 5 }])),
        "/device/code": DEVICE_CODE_RULE,
        "/device/token": DEVICE_TOKEN_RULE,
      },
    },
    advanced: {
      // Better Auth skips its origin check under NODE_ENV=test; Adiutor keeps it on everywhere.
      disableOriginCheck: false,
      disableCSRFCheck: false,
      useSecureCookies: publicUrl.protocol === "https:",
      ipAddress: { ipAddressHeaders: ["x-forwarded-for"], trustedProxies: options.trustedProxies },
    },
    hooks: { before: beforeAuthRoute, after: auditAfterTheFact },
    databaseHooks: {
      user: {
        create: {
          // Inside the sign-up transaction: a second owner is refused (the single-owner index backs this up).
          before: async (user) => {
            if (await readOwner(ctx)) throw refuse("FORBIDDEN", "ALREADY_SET_UP", "Adiutor already has its owner.")
            const name = String((user as { username?: string }).username ?? user.name)
            await audit({ actor: { kind: "owner", label: name }, source: "ui" }, "account.setup", "account", {
              username: name,
            })
          },
        },
        update: {
          // Only the audit row of a two-factor change; a refusal leaves the factor as it was.
          before: async (data, context) => {
            if (!("twoFactorEnabled" in data) || data.twoFactorEnabled === undefined) return
            const owner = await readOwner(ctx)
            if (!owner || owner.twoFactorEnabled === Boolean(data.twoFactorEnabled)) return
            const by = viaHttp(context) ? ownerBy(owner) : { actor: { kind: "system", label: "system" }, source: "api" }
            await audit(by as By, data.twoFactorEnabled ? "account.totp_enable" : "account.totp_disable", "account")
          },
        },
      },
      session: {
        create: {
          before: async (session, context) => {
            const path = pathOf(context)
            if (path === "/device/token") {
              // The session `adiutor connect` receives once the owner approved: it creates one key, then ends itself.
              const owner = await readOwner(ctx)
              await audit(
                { actor: { kind: "owner", label: owner?.username ?? "owner" }, source: "api" },
                "session.connect",
                "session",
              )
              return
            }
            const prior = Boolean((context as HookContext)?.context?.session)
            // Every session Better Auth creates after a password is recorded as the password stage, whatever the
            // account's two-factor flag says now: with two-factor on, the plugin turns it into a challenge, and a
            // sign-in racing enrolment (G6) keeps it. The second-factor routes record the second stage.
            let after: { stage: "password" | "second_factor"; method?: string } | null = null
            if (path === "/sign-up/email" || path === "/sign-in/username") after = { stage: "password" }
            else if (SECOND_FACTOR[path] && !prior) after = { stage: "second_factor", method: SECOND_FACTOR[path] }
            if (!after) return
            const owner = await readOwner(ctx)
            const label = owner?.username ?? String((session as { userId?: string }).userId ?? "owner")
            await audit({ actor: { kind: "owner", label }, source: "ui" }, "session.sign_in", "session", after)
          },
        },
        delete: {
          // Never on /sign-out (a throw there is swallowed and leaves the session valid): see hooks.after.
          before: async (_session, context) => {
            const path = pathOf(context)
            if (!SESSION_END_PATHS.has(path)) return
            const by: By =
              path === "/reset-password"
                ? { actor: { kind: "system", label: "cli" }, source: "cli" }
                : ownerBy(await readOwner(ctx))
            await audit(by, "session.end", "session", { via: path.slice(1) })
          },
        },
      },
      account: {
        update: {
          before: async (data, context) => {
            if (!(data as { password?: string }).password) return
            const path = pathOf(context)
            if (path === "/reset-password")
              await audit(
                { actor: { kind: "system", label: "cli" }, source: "cli" },
                "account.password_reset",
                "account",
              )
            else await audit(ownerBy(await readOwner(ctx)), "account.password_change", "account")
          },
        },
      },
    },
    plugins: [
      // The documented usernameValidator: no dot at either end and no two dots in a row, so the username is the
      // readable local part of the synthetic e-mail that the authenticator app shows (ownerEmail).
      username({ usernameValidator: isValidUsername }),
      twoFactor({
        issuer: "Adiutor",
        twoFactorCookieMaxAge: TWO_FACTOR_CHALLENGE_S,
        ...(otp
          ? {
              otpOptions: {
                sendOTP: async ({ otp: code }: { otp: string }) => {
                  await otp(code)
                },
              },
            }
          : {}),
      }),
      apiKey({
        defaultPrefix: AGENT_KEY_PREFIX,
        enableSessionForAPIKeys: false,
        rateLimit: { enabled: false },
        requireName: true,
        maximumNameLength: AGENT_KEY_NAME_MAX,
        keyExpiration: { minExpiresIn: AGENT_KEY_DAYS_MIN, maxExpiresIn: AGENT_KEY_DAYS_MAX },
      }),
      // Agent approval in the browser: `adiutor connect` asks for a code, the owner approves it at /connect/device, and
      // the CLI receives a session token for that one approval. Its session lasts what every session lasts
      // (session.expiresIn, the idle days); the plugin has no option of its own for it.
      deviceAuthorization({
        expiresIn: DEVICE_CODE_LIFETIME,
        interval: DEVICE_POLL_INTERVAL,
        verificationUri: CONNECT_DEVICE_PATH,
        validateClient: (clientId) => clientId === CONNECT_CLIENT_ID,
      }),
      // Documented on the device page: the CLI sends that token as `Authorization: Bearer`. hooks.before keeps the
      // header to BEARER_PATHS; Adiutor's /api/v1, /mcp and /api/setup never hand it to getSession.
      bearer(),
    ],
  })
}

export type Auth = ReturnType<typeof createAuth>

/**
 * The running Better Auth instance. Some of its options are fixed when it is built (the idle length, the OTP
 * route), so a change of those settings builds a new instance with the same options and swaps it in. A request
 * in flight finishes on the instance it started with; sessions live in the database, so both agree on them.
 */
export class AuthHolder {
  private instance: Auth
  private applied: AuthSettings

  constructor(
    private readonly base: Omit<AuthOptions, keyof AuthSettings>,
    settings: AuthSettings,
  ) {
    this.applied = { ...settings }
    this.instance = createAuth({ ...base, ...settings })
  }

  get current(): Auth {
    return this.instance
  }

  get settings(): AuthSettings {
    return { ...this.applied }
  }

  /** Builds a new instance when a setting it reads changed. Returns true when it swapped. */
  apply(settings: AuthSettings): boolean {
    if (
      settings.sessionIdleDays === this.applied.sessionIdleDays &&
      settings.otpViaTelegram === this.applied.otpViaTelegram
    )
      return false
    this.instance = createAuth({ ...this.base, ...settings })
    this.applied = { ...settings }
    return true
  }
}

/** Better Auth's own log lines: the level and the facts of any error passed along, never the message itself. */
export function logBetterAuth(level: string, _message: string, ...args: unknown[]): void {
  const error = args.find((arg) => arg instanceof Error)
  const facts = error ? errorFacts(error) : {}
  if (level === "error") log.error("better auth reported an error", facts)
  else if (level === "warn") log.warn("better auth reported a warning", facts)
}
