// `connect`: approve an agent in the browser and give it one agent key (Better Auth's device authorization, then its
// api-key plugin). The owner approves at /connect/device; this command then holds a session token for a few
// seconds, creates one key with it and ends that session at once, whatever happens in between. The key goes to the
// sync's env file, or into Claude Code or Codex through their own documented commands (`claude mcp add`,
// `codex mcp add`, and setx or an owner-only env file for Codex's variable). It is printed only when a client's
// command is missing or fails, as the setup to run by hand, and is never logged. The session token is never printed
// or stored.

import { chmod, type FileHandle, mkdir, open, readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, win32 } from "node:path"
import { parseEnvFile } from "./env.ts"
import { lastLine, type Runner, type RunResult } from "./exec.ts"
import type { FetchLike } from "./http.ts"

/** The one client id Adiutor's device plugin accepts; also the User-Agent, so Settings can name the session. */
export const CONNECT_CLIENT_ID = "adiutor-connect"
/** The api-key plugin's keyExpiration limits Adiutor sets (src/shared/auth.ts). */
export const DAYS_MIN = 1
export const DAYS_MAX = 365
export const NAME_MAX = 32
/** The variable Codex reads the key from (bearer_token_env_var). */
export const CODEX_KEY_VARIABLE = "ADIUTOR_AGENT_KEY"
/** Every agent key starts with this (src/shared/auth.ts); the api-key plugin adds 64 letters. */
export const AGENT_KEY_PREFIX = "adt_"
/**
 * An agent key as Adiutor makes it: the prefix, then letters and digits only. Checked before the key is saved, printed
 * or handed to a client, so the answer of whoever is at the address can never carry anything a shell or an env file
 * would read as more than the key.
 */
const AGENT_KEY = new RegExp(`^${AGENT_KEY_PREFIX}[A-Za-z0-9]{32,256}$`)

export const TARGETS = ["sync", "claude", "codex"] as const
export type Target = (typeof TARGETS)[number]

export type ConnectOptions = {
  /** Adiutor's address, without a trailing slash. */
  url: string
  name: string
  days: number
  target: Target
  /** The sync's env file (target sync). */
  envFile: string
  /** Open the approval page in the browser. */
  open: boolean
}

export type ConnectDeps = {
  fetch: FetchLike
  out: (line: string) => void
  runner: Runner
  /** The full path of a client's command (claude, codex), or undefined when it is not installed. */
  findCommand: (name: string) => Promise<string | undefined>
  /** The full path of a Windows component in System32 (icacls, rundll32, setx), or undefined. */
  systemCommand: (name: string) => Promise<string | undefined>
  platform: NodeJS.Platform
  env: Record<string, string | undefined>
  sleep: (ms: number) => Promise<void>
  now: () => number
  httpTimeoutMs?: number
}

export const EXIT_CONNECTED = 0
export const EXIT_NOT_CONNECTED = 1

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"

/** Where the sync's env file lives by default: outside every repository, in the user's own profile. */
export function defaultEnvFile(platform: NodeJS.Platform, env: Record<string, string | undefined>): string {
  if (platform === "win32") {
    const base = env.LOCALAPPDATA || win32.join(env.USERPROFILE || homedir(), "AppData", "Local")
    return win32.join(base, "adiutor", "sync.env")
  }
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "adiutor", "sync.env")
}

/** Where `connect --for codex` keeps Codex's variable outside Windows: next to the sync's env file. */
export function codexEnvFile(env: Record<string, string | undefined>): string {
  return join(dirname(defaultEnvFile("linux", env)), "codex.env")
}

/** ABCDEFGH as ABCD-EFGH, easier to compare with the page. */
export const groupedCode = (code: string) => (code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code)

type Answer = { status: number; body: Record<string, unknown> | null }

class ConnectError extends Error {
  override name = "ConnectError"
}

async function call(
  deps: ConnectDeps,
  url: string,
  body: unknown,
  bearer?: string,
): Promise<Answer | { error: string }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    "user-agent": CONNECT_CLIENT_ID,
  }
  if (bearer) headers.authorization = `Bearer ${bearer}`
  let response: Response
  try {
    response = await deps.fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(deps.httpTimeoutMs ?? 30_000),
    })
  } catch (error) {
    const err = error as Error & { cause?: { code?: string } }
    if (err.name === "TimeoutError") return { error: "no answer in time" }
    return { error: err.cause?.code ? `cannot reach Adiutor (${err.cause.code})` : "cannot reach Adiutor" }
  }
  const text = await response.text().catch(() => "")
  let parsed: unknown = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = null
  }
  const object = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null
  return { status: response.status, body: object }
}

const str = (value: unknown) => (typeof value === "string" ? value : "")
const num = (value: unknown, fallback: number) => (typeof value === "number" && value > 0 ? value : fallback)

/** A refusal in words: Better Auth's code or the OAuth error, never the body as a whole. */
function reason(answer: Answer | { error: string }): string {
  if ("error" in answer) return answer.error
  const code = str(answer.body?.code) || str(answer.body?.error)
  return code ? `HTTP ${answer.status}, ${code}` : `HTTP ${answer.status}`
}

// --- The env file of the sync ---

/** An env file that only the current user can read, checked before the key is written into it. */
export async function prepareEnvFile(
  path: string,
  deps: Pick<ConnectDeps, "platform" | "runner" | "env" | "systemCommand">,
) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  // Created empty if missing; an existing file keeps its values.
  const handle: FileHandle = await open(path, "a", 0o600)
  await handle.close()
  if (deps.platform === "win32") await restrictOnWindows(path, deps)
  else await restrictOnPosix(path)
}

async function restrictOnPosix(path: string): Promise<void> {
  await chmod(path, 0o600)
  const mode = (await stat(path)).mode & 0o777
  if ((mode & 0o077) !== 0) throw new ConnectError(`the env file is readable by others (mode ${mode.toString(8)})`)
}

/** The current user as icacls names it: DOMAIN\user. */
function windowsUser(env: Record<string, string | undefined>): string {
  const user = env.USERNAME ?? ""
  if (!/^[^"%\r\n\\/:*?<>|]+$/.test(user)) throw new ConnectError("cannot tell the current user (USERNAME)")
  const domain = env.USERDOMAIN ?? ""
  return /^[^"%\r\n\\/:*?<>|]+$/.test(domain) ? `${domain}\\${user}` : user
}

/**
 * icacls: inheritance removed and full control for the current user only, then read back. Anything else in the list
 * (an inherited entry, another account) refuses the file.
 */
async function restrictOnWindows(
  path: string,
  deps: Pick<ConnectDeps, "runner" | "env" | "systemCommand">,
): Promise<void> {
  const user = windowsUser(deps.env)
  const icacls = await deps.systemCommand("icacls")
  if (!icacls) throw new ConnectError("icacls was not found in %SystemRoot%\\System32")
  const set = await deps.runner(icacls, [path, "/inheritance:r", "/grant:r", `${user}:F`], { timeoutMs: 30_000 })
  if (set.code !== 0) throw new ConnectError(`icacls could not restrict the env file (${set.error ?? "failed"})`)
  const read = await deps.runner(icacls, [path], { timeoutMs: 30_000 })
  if (read.code !== 0) throw new ConnectError(`icacls could not read the env file's access (${read.error ?? "failed"})`)
  const entries = aclEntries(read.stdout, path)
  const only = entries.length === 1 ? entries[0] : undefined
  const ok =
    only !== undefined &&
    !only.includes("(I)") &&
    only.toLowerCase().startsWith(`${user.toLowerCase()}:`) &&
    only.includes("(F)")
  if (!ok) throw new ConnectError("the env file is not restricted to the current user; check it with icacls")
}

/** The access entries icacls prints for one file: the first line after the path, then the indented lines. */
export function aclEntries(output: string, path: string): string[] {
  const lines = output.split(/\r?\n/)
  const entries: string[] = []
  for (const [index, raw] of lines.entries()) {
    if (index === 0) {
      const first = raw.startsWith(path) ? raw.slice(path.length) : raw
      if (first.trim()) entries.push(first.trim())
      continue
    }
    if (!raw.trim()) break
    entries.push(raw.trim())
  }
  return entries
}

/**
 * The file's lines with exactly one ADIUTOR_URL and one ADIUTOR_AGENT_TOKEN, in the place of the first definition of each
 * (parseEnvFile keeps the last one, so a leftover duplicate would win); every other line stays as it was.
 */
export function withSyncKey(text: string, url: string, key: string): string {
  let lines = text.replace(/^﻿/, "").split(/\r?\n/)
  while (lines.length > 0 && lines.at(-1) === "") lines.pop()
  const set = (name: string, value: string) => {
    // A line break would add lines of its own to the file.
    if (/[\r\n]/.test(value)) throw new ConnectError(`${name} holds a line break`)
    const pattern = new RegExp(`^\\s*(export\\s+)?${name}\\s*=`)
    const first = lines.findIndex((line) => pattern.test(line))
    if (first === -1) {
      lines.push(`${name}=${value}`)
      return
    }
    lines = lines.flatMap((line, index) => (index === first ? [`${name}=${value}`] : pattern.test(line) ? [] : [line]))
  }
  set("ADIUTOR_URL", url)
  set("ADIUTOR_AGENT_TOKEN", key)
  return `${lines.join("\n")}\n`
}

async function saveSyncKey(path: string, url: string, key: string): Promise<void> {
  const before = await readFile(path, "utf8")
  // Checks the file still parses, so a broken file is reported before it is changed.
  parseEnvFile(before)
  // Built before the file is emptied, so a refused value leaves the file as it was.
  const after = withSyncKey(before, url, key)
  // Written in place: the restricted access list of the file stays.
  const handle = await open(path, "r+")
  try {
    await handle.truncate(0)
    await handle.write(after, 0, "utf8")
  } finally {
    await handle.close()
  }
}

// --- What the clients get ---

/** The MCP server's name in both clients. */
export const SERVER_NAME = "adiutor"
const CLIENT_TIMEOUT_MS = 120_000
const HISTORY_NOTE = "A command you paste can stay in your shell history; clear that entry if others can read it."

/** `claude mcp add` at user scope, the header last: `--header` takes every value after it. */
export function claudeAddArgs(url: string, key: string): string[] {
  return [
    "mcp",
    "add",
    "--transport",
    "http",
    "--scope",
    "user",
    SERVER_NAME,
    `${url}/mcp`,
    "--header",
    `Authorization: Bearer ${key}`,
  ]
}

export const CLAUDE_REMOVE_ARGS = ["mcp", "remove", SERVER_NAME, "--scope", "user"]

/**
 * Claude Code's refusal when the name already exists in the scope it adds to (its stderr line). Only this refusal
 * leads to `claude mcp remove`; any other failure, a managed policy for one, removes nothing.
 */
export const CLAUDE_NAME_TAKEN = new RegExp(
  `^MCP server "?${SERVER_NAME}"? already exists in user config\\.?\\r?$`,
  "m",
)

export function codexAddArgs(url: string): string[] {
  return ["mcp", "add", SERVER_NAME, "--url", `${url}/mcp`, "--bearer-token-env-var", CODEX_KEY_VARIABLE]
}

/**
 * The fallback for Claude Code: the same command, to run by hand. The header is in single quotes for a POSIX shell, so
 * it gives the value no meaning; cmd.exe has no single quotes, and the checked key holds nothing either Windows shell
 * expands inside double quotes.
 */
export function claudeCommand(url: string, key: string, platform: NodeJS.Platform): string {
  const header = `Authorization: Bearer ${key}`
  const quoted = platform === "win32" ? `"${header}"` : `'${header}'`
  return `claude mcp add --transport http --scope user ${SERVER_NAME} ${url}/mcp --header ${quoted}`
}

/** The fallback for Codex's configuration: no key, only the variable's name. */
export function codexConfigLines(url: string): string[] {
  return [`[mcp_servers.${SERVER_NAME}]`, `url = "${url}/mcp"`, `bearer_token_env_var = "${CODEX_KEY_VARIABLE}"`]
}

/** The fallback for Codex's variable, single-quoted for a POSIX shell. */
export function codexVariableLine(key: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? `setx ${CODEX_KEY_VARIABLE} "${key}"` : `export ${CODEX_KEY_VARIABLE}='${key}'`
}

/** Why a client's command failed, in one line, with the key masked (before shortening) should the client echo it. */
function failure(result: RunResult, key: string): string {
  const detail = lastLine((result.stderr || result.stdout).replaceAll(key, "[redacted]"))
  return detail ? `${result.error ?? "failed"}: ${detail}` : (result.error ?? "failed")
}

/**
 * Adds Adiutor to Claude Code at user scope. `claude mcp add` refuses a name that exists; only that refusal removes the
 * user-scope entry with `claude mcp remove` and adds again. Prints the command instead when that does not work.
 *
 * The refusal is read from add's own message rather than checked first with `claude mcp get`: get looks at every
 * scope (it reports a local entry first) and connects to the server, while the message names the scope add writes to.
 * Should the wording change, the add simply falls back to the printed command and nothing is removed.
 */
async function deliverToClaude(url: string, key: string, deps: ConnectDeps): Promise<void> {
  const say = deps.out
  const byHand = (why: string) => {
    say(`Could not add Adiutor to Claude Code: ${why}.`)
    say("Run this once to add it yourself; Adiutor shows the key only now:")
    say("")
    say(claudeCommand(url, key, deps.platform))
    say("")
    say(HISTORY_NOTE)
  }
  const claude = await deps.findCommand("claude")
  if (!claude) return byHand("the claude command was not found")
  const add = () => deps.runner(claude, claudeAddArgs(url, key), { timeoutMs: CLIENT_TIMEOUT_MS })
  let added = await add()
  let replaced = false
  if (added.code !== 0 && CLAUDE_NAME_TAKEN.test(`${added.stderr}\n${added.stdout}`)) {
    const removed = await deps.runner(claude, CLAUDE_REMOVE_ARGS, { timeoutMs: CLIENT_TIMEOUT_MS })
    if (removed.code === 0) {
      replaced = true
      added = await add()
    }
  }
  if (added.code !== 0) return byHand(`claude mcp add ${failure(added, key)}`)
  say(
    replaced
      ? `Replaced the ${SERVER_NAME} server in Claude Code (user scope); it now uses the new key.`
      : `Added the ${SERVER_NAME} server to Claude Code (user scope).`,
  )
  say("Claude Code keeps the key in its own configuration. Start a new Claude Code session to use it.")
}

/** Saves Codex's variable: setx for the Windows user, an owner-only env file elsewhere. Why not, or undefined. */
async function saveCodexVariable(key: string, deps: ConnectDeps): Promise<string | undefined> {
  const say = deps.out
  if (deps.platform === "win32") {
    const setx = await deps.systemCommand("setx")
    if (!setx) return "setx was not found in %SystemRoot%\\System32"
    const set = await deps.runner(setx, [CODEX_KEY_VARIABLE, key], { timeoutMs: 30_000 })
    if (set.code !== 0) return `setx ${failure(set, key)}`
    say(`Set ${CODEX_KEY_VARIABLE} for your Windows user.`)
    return undefined
  }
  const file = codexEnvFile(deps.env)
  try {
    await prepareEnvFile(file, deps)
    // Written in place, like the sync's file; it holds this one line only, the key in single quotes for the shell.
    const handle = await open(file, "r+")
    try {
      await handle.truncate(0)
      await handle.write(`export ${CODEX_KEY_VARIABLE}='${key}'\n`, 0, "utf8")
    } finally {
      await handle.close()
    }
  } catch (error) {
    return `cannot write ${file} (${messageOf(error)})`
  }
  say(`Saved ${CODEX_KEY_VARIABLE} in ${file}, readable by you only. Add this line to your shell profile once:`)
  say("")
  say(`. "${file}"`)
  say("")
  return undefined
}

/**
 * Codex reads the key from a variable: the variable first, then `codex mcp add` (which replaces an entry of the same
 * name). A step that does not work prints its own setup instead; only the variable's holds the key.
 */
async function deliverToCodex(url: string, key: string, deps: ConnectDeps): Promise<void> {
  const say = deps.out
  const variableFailed = await saveCodexVariable(key, deps)
  if (variableFailed) {
    say(`Could not set ${CODEX_KEY_VARIABLE}: ${variableFailed}.`)
    say(
      deps.platform === "win32"
        ? "Set it yourself for your Windows user; Adiutor shows the key only now:"
        : "Set it yourself in your shell profile; Adiutor shows the key only now:",
    )
    say("")
    say(codexVariableLine(key, deps.platform))
    say("")
    say(HISTORY_NOTE)
  }
  const codex = await deps.findCommand("codex")
  const added = codex ? await deps.runner(codex, codexAddArgs(url), { timeoutMs: CLIENT_TIMEOUT_MS }) : undefined
  if (added?.code === 0) {
    say(`Added the ${SERVER_NAME} server to Codex; it reads the key from ${CODEX_KEY_VARIABLE}.`)
  } else {
    const why = added ? `codex mcp add ${failure(added, key)}` : "the codex command was not found"
    say(`Could not add Adiutor to Codex: ${why}.`)
    say("Add this to ~/.codex/config.toml yourself:")
    say("")
    for (const line of codexConfigLines(url)) say(line)
    say("")
  }
  say(`Restart Codex from a new terminal, so that it sees ${CODEX_KEY_VARIABLE}.`)
}

// --- The browser ---

/** Opens the approval page with the system's own opener, without a shell. A failure only means: open it yourself. */
async function openBrowser(
  link: string,
  deps: Pick<ConnectDeps, "runner" | "platform" | "systemCommand">,
): Promise<boolean> {
  let command = deps.platform === "darwin" ? "open" : "xdg-open"
  let args = [link]
  if (deps.platform === "win32") {
    const rundll32 = await deps.systemCommand("rundll32")
    if (!rundll32) return false
    command = rundll32
    args = ["url.dll,FileProtocolHandler", link]
  }
  const result = await deps.runner(command, args, { timeoutMs: 15_000 })
  return result.code === 0
}

// --- The flow ---

/**
 * One connection: device code, approval in the browser, the session token, one key, then the session ends.
 * Returns the exit code.
 */
export async function connect(options: ConnectOptions, deps: ConnectDeps): Promise<number> {
  const say = deps.out
  const auth = `${options.url}/api/auth`

  if (options.target === "sync") {
    try {
      await prepareEnvFile(options.envFile, deps)
    } catch (error) {
      say(`connect: cannot prepare the env file ${options.envFile}: ${messageOf(error)}`)
      return EXIT_NOT_CONNECTED
    }
  }

  const code = await call(deps, `${auth}/device/code`, { client_id: CONNECT_CLIENT_ID })
  if ("error" in code || code.status !== 200 || !code.body) {
    say(`connect: Adiutor did not start the approval: ${reason(code)}`)
    return EXIT_NOT_CONNECTED
  }
  const deviceCode = str(code.body.device_code)
  const userCode = str(code.body.user_code)
  const link = str(code.body.verification_uri_complete)
  const linkUrl = URL.canParse(link) ? new URL(link) : null
  if (!deviceCode || !userCode || !linkUrl || linkUrl.origin !== new URL(options.url).origin) {
    say("connect: Adiutor's answer to the approval request is not usable")
    return EXIT_NOT_CONNECTED
  }
  const expiresAt = deps.now() + num(code.body.expires_in, 600) * 1000
  let interval = num(code.body.interval, 5) * 1000

  say(`Approve this agent in Adiutor: ${link}`)
  say(`Check that the page shows the code ${groupedCode(userCode)}, then choose Allow.`)
  if (options.open && !(await openBrowser(link, deps))) say("Could not open the browser; open the link yourself.")
  say("Waiting for the approval...")

  let token = ""
  while (!token) {
    await deps.sleep(interval)
    if (deps.now() >= expiresAt) {
      say("connect: the code expired before it was approved. Run the command again.")
      return EXIT_NOT_CONNECTED
    }
    const answer = await call(deps, `${auth}/device/token`, {
      grant_type: DEVICE_GRANT,
      device_code: deviceCode,
      client_id: CONNECT_CLIENT_ID,
    })
    if ("error" in answer) continue
    if (answer.status === 200 && str(answer.body?.access_token)) {
      token = str(answer.body?.access_token)
      break
    }
    const error = str(answer.body?.error)
    if (error === "authorization_pending") continue
    if (error === "slow_down" || answer.status === 429) {
      // RFC 8628: wait 5 seconds longer from now on. A rate-limited poll (429) is the same request to slow down.
      interval += 5000
      continue
    }
    if (error === "access_denied") {
      say("connect: the request was denied in the browser. Nothing was created.")
      return EXIT_NOT_CONNECTED
    }
    if (error === "expired_token") {
      say("connect: the code expired before it was approved. Run the command again.")
      return EXIT_NOT_CONNECTED
    }
    say(`connect: Adiutor refused the approval: ${reason(answer)}`)
    return EXIT_NOT_CONNECTED
  }

  let exit = EXIT_NOT_CONNECTED
  try {
    exit = await createAndDeliver(options, deps, auth, token)
  } finally {
    const ended = await call(deps, `${auth}/revoke-session`, { token }, token)
    if ("error" in ended || ended.status !== 200 || ended.body?.status !== true)
      say(
        `connect: could not confirm that the approval's temporary session ended (${reason(ended)}). End the session ` +
          `"adiutor connect (agent approval)" on the Account page in Adiutor.`,
      )
  }
  return exit
}

async function createAndDeliver(
  options: ConnectOptions,
  deps: ConnectDeps,
  auth: string,
  token: string,
): Promise<number> {
  const say = deps.out
  const created = await call(
    deps,
    `${auth}/api-key/create`,
    { name: options.name, expiresIn: options.days * 86_400 },
    token,
  )
  if ("error" in created || created.status !== 200) {
    say(`connect: Adiutor did not create the key: ${reason(created)}`)
    return EXIT_NOT_CONNECTED
  }
  // A success may have made a key even when the answer does not hold a usable one: never save or show that answer.
  const key = str(created.body?.key)
  if (!AGENT_KEY.test(key)) {
    say(
      `connect: Adiutor created the key "${options.name}", but its answer is not a valid agent key, so nothing was ` +
        "saved. Disconnect it in Adiutor, Settings, Agent access.",
    )
    return EXIT_NOT_CONNECTED
  }
  const until = str(created.body?.expiresAt).slice(0, 10)
  const ends = until ? ` It works until ${until}.` : ""

  if (options.target === "sync") {
    try {
      await saveSyncKey(options.envFile, options.url, key)
    } catch (error) {
      say(
        `connect: the key "${options.name}" was created but could not be saved (${messageOf(error)}). ` +
          "Disconnect it in Adiutor, Settings, Agent access, and run the command again.",
      )
      return EXIT_NOT_CONNECTED
    }
    say(`Connected "${options.name}". The sync's key is in ${options.envFile}, readable by you only.${ends}`)
    return EXIT_CONNECTED
  }

  say(`Connected "${options.name}".${ends}`)
  if (options.target === "claude") await deliverToClaude(options.url, key, deps)
  else await deliverToCodex(options.url, key, deps)
  return EXIT_CONNECTED
}

function messageOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code
  if (code) return code
  return error instanceof ConnectError ? error.message : "unexpected error"
}
