import { existsSync, writeSync } from "node:fs"
import type { Server } from "node:http"
import { join } from "node:path"
import { serve } from "@hono/node-server"
import { createApp, socketAddress } from "./app.ts"
import { AuthHolder } from "./auth/auth.ts"
import { ConfigError, loadConfig } from "./config.ts"
import { createDatabase, migrationFailure } from "./db/client.ts"
import { clientAddress } from "./http/auth.ts"
import { errorFacts, log } from "./log.ts"
import { getSettings } from "./services/admin.ts"
import { ReloadableSecretScanner } from "./services/secrets.ts"
import { createSettingsCipher } from "./settings/crypto.ts"
import { effectiveTelegram } from "./settings/effective.ts"
import { SettingsRuntime } from "./settings/runtime.ts"
import { TelegramService } from "./telegram/runtime.ts"

/** Writes synchronously: console output to a pipe may still be pending when the process exits. */
function fail(msg: string): never {
  writeSync(2, `${JSON.stringify({ level: "error", msg })}\n`)
  process.exit(1)
}

let config: ReturnType<typeof loadConfig>
try {
  config = loadConfig()
} catch (error) {
  if (error instanceof ConfigError) fail(error.message)
  throw error
}
for (const warning of config.warnings) log.warn(warning)

const database = createDatabase(config.databaseUrl)
try {
  await database.migrate(config.migrationsDir)
} catch (error) {
  // The driver's message may include the host but never the password; the URL itself is not logged. Drizzle wraps a
  // failed statement in DrizzleQueryError ("Failed query: ..."); PostgreSQL's own message (a migration's RAISE
  // EXCEPTION, for example) is its cause.
  fail(`Database migration failed: ${migrationFailure(error)}`)
}

const scanner = new ReloadableSecretScanner()
const ctx = { db: database.db, secrets: scanner, clock: () => new Date() }
const env = { overrides: config.overrides, cipher: createSettingsCipher(config.settingsKeys) }
const telegram = new TelegramService({ ctx, publicUrl: config.publicUrl, apiUrl: config.telegramApiUrl })

const settings = await getSettings(ctx.db)
const auth = new AuthHolder(
  {
    ctx,
    secrets: config.authSecrets,
    publicUrl: config.publicUrl,
    trustedProxies: config.trustedProxies,
    sendOtp: (code) => telegram.sendSignInCode(code),
  },
  {
    sessionIdleDays: settings.sessionIdleDays,
    otpViaTelegram: settings.otpViaTelegram && effectiveTelegram(settings, env.overrides, env.cipher).state === "on",
  },
)
const runtime = new SettingsRuntime({ ctx, env, auth, telegram, scanner })
try {
  // The secret check's domains, and the bot with the morning job when Telegram is set up.
  await runtime.apply(settings)
} catch (error) {
  fail(`Telegram could not start: ${error instanceof Error ? error.name : "unknown error"}`)
}
const pair = effectiveTelegram(settings, env.overrides, env.cipher)
if (pair.state === "incomplete") log.warn("telegram is incomplete: the bot is off", { missing: pair.missing })

// The image holds the built UI in dist/web next to the server bundle; a checkout without a UI build serves the API only.
const webRoot = process.env.ADIUTOR_WEB_DIR ?? "dist/web"
const web = existsSync(join(webRoot, "index.html")) ? { root: webRoot } : undefined
const app = createApp({
  checkDatabase: database.ping,
  core: {
    ctx,
    config,
    auth,
    settings: runtime,
    telegram,
    clientIp: clientAddress(config.trustedProxies, socketAddress),
  },
  web,
})

const server = serve({ fetch: app.fetch, port: config.port }, ({ port }) => {
  log.info(`Adiutor ${config.version} listening`, { port })
}) as Server

const shutdown = (signal: string) => {
  log.info("shutting down", { signal })
  void telegram
    .stop()
    .catch((error: unknown) => log.error("telegram did not stop cleanly", errorFacts(error)))
    .finally(() => {
      server.close(() => {
        void database.close().then(() => process.exit(0))
      })
    })
}
process.on("SIGTERM", () => shutdown("SIGTERM"))
process.on("SIGINT", () => shutdown("SIGINT"))
