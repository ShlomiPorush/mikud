import { randomBytes, randomInt } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  AGENT_KEY_DAYS_MAX,
  AGENT_KEY_DAYS_MIN,
  AGENT_KEY_NAME_MAX,
  CONNECT_CLIENT_ID as SERVER_CLIENT_ID,
  AGENT_KEY_PREFIX as SERVER_KEY_PREFIX,
} from "../shared/auth.ts"
import { connectUrl, DEFAULT_DAYS, main } from "./cli.ts"
import {
  AGENT_KEY_PREFIX,
  aclEntries,
  CLAUDE_NAME_TAKEN,
  CLAUDE_REMOVE_ARGS,
  CONNECT_CLIENT_ID,
  type ConnectDeps,
  type ConnectOptions,
  claudeAddArgs,
  claudeCommand,
  codexAddArgs,
  codexEnvFile,
  codexVariableLine,
  connect,
  DAYS_MAX,
  DAYS_MIN,
  defaultEnvFile,
  NAME_MAX,
  withSyncKey,
} from "./connect.ts"
import { parseEnvFile } from "./env.ts"
import type { Runner, RunResult } from "./exec.ts"

// `connect` against a stand-in Adiutor: the device flow's answers, the key, and the end of the temporary session.
// The session, the device code and the key are new on every run: nothing in the repository works as one.

const URL_BASE = "https://adiutor.example.com"
const SESSION = randomBytes(32).toString("base64url")
const DEVICE_CODE = randomBytes(32).toString("base64url")
const LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
/** Like Better Auth's api-key plugin makes them: adt_ and 64 letters. */
const KEY = `adt_${Array.from({ length: 64 }, () => LETTERS[randomInt(LETTERS.length)]).join("")}`
const temps: string[] = []

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "adiutor-connect-"))
  temps.push(dir)
  return dir
}

type Sent = { path: string; body: Record<string, unknown>; auth?: string; userAgent?: string }
type Reply = { status: number; body: unknown }

/** A stand-in Adiutor: token answers in order, then the key and the revoke answers a test chooses. */
function standIn(options: { polls?: Reply[]; create?: Reply; revoke?: Reply | "network" } = {}) {
  const sent: Sent[] = []
  const polls = [...(options.polls ?? [{ status: 200, body: { access_token: SESSION, token_type: "Bearer" } }])]
  const fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const path = new URL(input).pathname.replace(/^\/api\/auth/, "")
    const headers = init.headers as Record<string, string>
    sent.push({
      path,
      body: JSON.parse(String(init.body)),
      auth: headers.authorization,
      userAgent: headers["user-agent"],
    })
    const json = (reply: Reply) =>
      new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { "content-type": "application/json" },
      })
    if (path === "/device/code")
      return json({
        status: 200,
        body: {
          device_code: DEVICE_CODE,
          user_code: "ABCDEFGH",
          verification_uri: `${URL_BASE}/connect/device`,
          verification_uri_complete: `${URL_BASE}/connect/device?user_code=ABCDEFGH`,
          expires_in: 600,
          interval: 5,
        },
      })
    if (path === "/device/token") return json(polls.shift() ?? { status: 400, body: { error: "expired_token" } })
    if (path === "/api-key/create")
      return json(
        options.create ?? { status: 200, body: { key: KEY, id: "k1", expiresAt: "2027-01-31T08:00:00.000Z" } },
      )
    if (path === "/revoke-session") {
      if (options.revoke === "network")
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } })
      return json(options.revoke ?? { status: 200, body: { status: true } })
    }
    return json({ status: 404, body: { code: "NOT_FOUND" } })
  }
  return { fetch, sent }
}

const pending = { status: 400, body: { error: "authorization_pending" } }
const slowDown = { status: 400, body: { error: "slow_down" } }

function deps(
  fetch: ConnectDeps["fetch"],
  overrides: Partial<ConnectDeps> = {},
): ConnectDeps & { lines: string[]; waits: number[]; ran: { command: string; args: string[] }[] } {
  const lines: string[] = []
  const waits: number[] = []
  const ran: { command: string; args: string[] }[] = []
  let clock = 0
  const runner: Runner = async (command, args) => {
    ran.push({ command, args })
    return { code: 0, stdout: "", stderr: "" }
  }
  return {
    fetch,
    out: (line) => lines.push(line),
    runner,
    // No client installed unless a test says so.
    findCommand: async () => undefined,
    systemCommand: async (name) => `C:\\Windows\\System32\\${name}.exe`,
    platform: "linux",
    env: {},
    sleep: async (ms) => {
      waits.push(ms)
      clock += ms
    },
    now: () => clock,
    ...overrides,
    lines,
    waits,
    ran,
  }
}

const options = (overrides: Partial<ConnectOptions> = {}): ConnectOptions => ({
  url: URL_BASE,
  name: "claude-laptop",
  days: 30,
  target: "claude",
  envFile: join(tempDir(), "adiutor", "sync.env"),
  open: false,
  ...overrides,
})

describe("connect: the device flow", () => {
  it("polls through authorization_pending and slow_down, creates one named key with its days, then ends the session", async () => {
    const adiutor = standIn({ polls: [pending, slowDown, pending, { status: 200, body: { access_token: SESSION } }] })
    const d = deps(adiutor.fetch)
    expect(await connect(options(), d)).toBe(0)

    expect(adiutor.sent.map((s) => s.path)).toEqual([
      "/device/code",
      "/device/token",
      "/device/token",
      "/device/token",
      "/device/token",
      "/api-key/create",
      "/revoke-session",
    ])
    expect(adiutor.sent[0]?.body).toEqual({ client_id: CONNECT_CLIENT_ID })
    expect(adiutor.sent.every((s) => s.userAgent === CONNECT_CLIENT_ID)).toBe(true)
    // RFC 8628: slow_down adds 5 seconds to every later wait.
    expect(d.waits).toEqual([5000, 5000, 10_000, 10_000])
    const create = adiutor.sent[5]
    expect(create?.auth).toBe(`Bearer ${SESSION}`)
    expect(create?.body).toEqual({ name: "claude-laptop", expiresIn: 30 * 86_400 })
    const revoke = adiutor.sent[6]
    expect(revoke?.auth).toBe(`Bearer ${SESSION}`)
    expect(revoke?.body).toEqual({ token: SESSION })
    // The device code and polling never carry a session.
    expect(adiutor.sent.slice(0, 5).every((s) => s.auth === undefined)).toBe(true)
    expect(d.lines.join("\n")).toContain("ABCD-EFGH")
    expect(d.lines.join("\n")).not.toContain(SESSION)
  })

  it("treats a rate-limited poll (429) as slow_down and keeps waiting for the approval", async () => {
    const limited = { status: 429, body: { message: "Too many requests" } }
    const adiutor = standIn({ polls: [pending, limited, limited, { status: 200, body: { access_token: SESSION } }] })
    const d = deps(adiutor.fetch)
    expect(await connect(options(), d)).toBe(0)
    expect(d.waits).toEqual([5000, 5000, 10_000, 15_000])
    expect(adiutor.sent.map((s) => s.path)).toContain("/api-key/create")
  })

  it("stops at access_denied without a key or a session", async () => {
    const adiutor = standIn({ polls: [pending, { status: 400, body: { error: "access_denied" } }] })
    const d = deps(adiutor.fetch)
    expect(await connect(options(), d)).toBe(1)
    expect(adiutor.sent.map((s) => s.path)).not.toContain("/api-key/create")
    expect(adiutor.sent.map((s) => s.path)).not.toContain("/revoke-session")
    expect(d.lines.join("\n")).toContain("denied")
  })

  it("stops when the code expires, by Adiutor's answer or by its own clock", async () => {
    const byAnswer = standIn({ polls: [pending, { status: 400, body: { error: "expired_token" } }] })
    expect(await connect(options(), deps(byAnswer.fetch))).toBe(1)
    const neverAnswered = standIn({ polls: Array.from({ length: 200 }, () => pending) })
    const d = deps(neverAnswered.fetch)
    expect(await connect(options(), d)).toBe(1)
    // 600 seconds at 5 seconds: the last poll is before the code's end.
    expect(neverAnswered.sent.filter((s) => s.path === "/device/token").length).toBe(119)
    expect(d.lines.join("\n")).toContain("expired")
  })

  it("ends the session even when Adiutor does not create the key", async () => {
    const adiutor = standIn({ create: { status: 400, body: { code: "EXPIRES_IN_IS_TOO_LARGE" } } })
    const d = deps(adiutor.fetch)
    expect(await connect(options(), d)).toBe(1)
    expect(adiutor.sent.at(-1)?.path).toBe("/revoke-session")
    expect(d.lines.join("\n")).toContain("EXPIRES_IN_IS_TOO_LARGE")
  })

  it("says so when the end of the session is not confirmed", async () => {
    for (const revoke of [{ status: 403, body: { code: "OWN_SESSION_ONLY" } }, "network" as const]) {
      const adiutor = standIn({ revoke })
      const d = deps(adiutor.fetch)
      expect(await connect(options(), d)).toBe(0)
      expect(d.lines.join("\n")).toContain("could not confirm that the approval's temporary session ended")
      expect(d.lines.join("\n")).toContain("adiutor connect (agent approval)")
      expect(d.lines.join("\n")).not.toContain(SESSION)
    }
  })

  it("refuses an approval link on another address and never opens it", async () => {
    const adiutor = standIn()
    const d = deps(adiutor.fetch)
    expect(await connect(options({ url: "https://other.example.com", open: true }), d)).toBe(1)
    expect(d.ran).toEqual([])
  })

  it("opens the approval page without a shell", async () => {
    for (const [platform, command] of [
      ["win32", "C:\\Windows\\System32\\rundll32.exe"],
      ["darwin", "open"],
      ["linux", "xdg-open"],
    ] as const) {
      const adiutor = standIn()
      const d = deps(adiutor.fetch, { platform })
      await connect(options({ open: true }), d)
      expect(d.ran[0]?.command).toBe(command)
      expect(d.ran[0]?.args.at(-1)).toBe(`${URL_BASE}/connect/device?user_code=ABCDEFGH`)
    }
  })

  it("on Windows, runs rundll32 only from System32, and asks to open the link by hand when it is missing", async () => {
    const asked: string[] = []
    const d = deps(standIn().fetch, {
      platform: "win32",
      systemCommand: async (name) => {
        asked.push(name)
        return undefined
      },
    })
    expect(await connect(options({ open: true }), d)).toBe(0)
    expect(asked).toEqual(["rundll32"])
    expect(d.ran).toEqual([])
    expect(d.lines.join("\n")).toContain("Could not open the browser; open the link yourself.")
  })
})

describe("connect: Claude Code", () => {
  const CLAUDE = "/opt/bin/claude"
  const addArgs = claudeAddArgs(URL_BASE, KEY)
  const keyLines = (lines: string[]) => lines.filter((line) => line.includes(KEY))
  const scripted = (answers: RunResult[]) => {
    const ran: { command: string; args: string[] }[] = []
    const runner: Runner = async (command, args) => {
      ran.push({ command, args })
      return answers.shift() ?? { code: 0, stdout: "", stderr: "" }
    }
    return { ran, runner }
  }
  const ok: RunResult = { code: 0, stdout: "Added HTTP MCP server adiutor", stderr: "" }
  const exists: RunResult = {
    code: 1,
    stdout: "",
    stderr: "MCP server adiutor already exists in user config",
    error: "exit code 1",
  }

  it("adds Adiutor at user scope with claude mcp add, the key only in its header, and prints no key", async () => {
    const { ran, runner } = scripted([ok])
    const d = deps(standIn().fetch, { runner, findCommand: async (name) => (name === "claude" ? CLAUDE : undefined) })
    expect(await connect(options({ target: "claude" }), d)).toBe(0)
    expect(addArgs).toEqual([
      "mcp",
      "add",
      "--transport",
      "http",
      "--scope",
      "user",
      "adiutor",
      `${URL_BASE}/mcp`,
      "--header",
      `Authorization: Bearer ${KEY}`,
    ])
    expect(ran).toEqual([{ command: CLAUDE, args: addArgs }])
    expect(d.lines.join("\n")).toContain("Added the adiutor server to Claude Code (user scope)")
    expect(keyLines(d.lines)).toEqual([])
    expect(d.lines.join("\n")).not.toContain("shell history")
  })

  it("replaces an existing adiutor server: claude mcp remove at user scope, then add again", async () => {
    const { ran, runner } = scripted([exists, { code: 0, stdout: "Removed", stderr: "" }, ok])
    const d = deps(standIn().fetch, { runner, findCommand: async () => CLAUDE })
    expect(await connect(options({ target: "claude" }), d)).toBe(0)
    expect(ran).toEqual([
      { command: CLAUDE, args: addArgs },
      { command: CLAUDE, args: ["mcp", "remove", "adiutor", "--scope", "user"] },
      { command: CLAUDE, args: addArgs },
    ])
    expect(CLAUDE_REMOVE_ARGS).toEqual(["mcp", "remove", "adiutor", "--scope", "user"])
    expect(d.lines.join("\n")).toContain("Replaced the adiutor server in Claude Code (user scope)")
    expect(keyLines(d.lines)).toEqual([])
  })

  it("prints the command once when claude is not installed", async () => {
    const { ran, runner } = scripted([])
    const d = deps(standIn().fetch, { runner, findCommand: async () => undefined })
    expect(await connect(options({ target: "claude" }), d)).toBe(0)
    expect(ran).toEqual([])
    const command = `claude mcp add --transport http --scope user adiutor ${URL_BASE}/mcp --header 'Authorization: Bearer ${KEY}'`
    expect(claudeCommand(URL_BASE, KEY, "linux")).toBe(command)
    expect(d.lines.join("\n")).toContain("Could not add Adiutor to Claude Code: the claude command was not found.")
    expect(keyLines(d.lines)).toEqual([command])
    expect(d.lines.join("\n")).toContain("shell history")
  })

  it("removes nothing when add fails for any reason other than the name taken in user scope", async () => {
    const refusals = [
      // Managed settings that allow only plugin servers (docs: errors, "Cannot add MCP server").
      "Cannot add MCP server: your organization's managed settings allow only MCP servers that plugins provide",
      "MCP server adiutor already exists in local config",
      "MCP server adiutor-old already exists in user config",
      "Error: something else went wrong",
      "",
    ]
    for (const stderr of refusals) {
      const failed = scripted([{ code: 1, stdout: "", stderr, error: "exit code 1" }])
      const d = deps(standIn().fetch, { runner: failed.runner, findCommand: async () => CLAUDE })
      expect(await connect(options({ target: "claude" }), d)).toBe(0)
      expect(failed.ran.map((r) => r.args[1])).toEqual(["add"])
      expect(d.lines.join("\n")).toContain("Could not add Adiutor to Claude Code: claude mcp add exit code 1")
      expect(keyLines(d.lines)).toEqual([claudeCommand(URL_BASE, KEY, "linux")])
    }
    expect(CLAUDE_NAME_TAKEN.test("MCP server adiutor already exists in user config\r\n")).toBe(true)
    expect(CLAUDE_NAME_TAKEN.test("warning\nMCP server adiutor already exists in user config.\n")).toBe(true)
  })

  it("masks the key before shortening the reason, so no part of it shows", async () => {
    // The key crosses the 200-character cut of the reason.
    const stderr = `${"x".repeat(185)} ${KEY} end`
    const failed = scripted([{ code: 1, stdout: "", stderr, error: "exit code 1" }])
    const d = deps(standIn().fetch, { runner: failed.runner, findCommand: async () => CLAUDE })
    expect(await connect(options({ target: "claude" }), d)).toBe(0)
    const others = d.lines.filter((line) => line !== claudeCommand(URL_BASE, KEY, "linux"))
    expect(others.some((line) => line.includes("[redacted]"))).toBe(true)
    expect(others.filter((line) => line.includes(KEY.slice(0, 6)))).toEqual([])
  })

  it("prints the command once when claude fails, with the reason and never the key in it", async () => {
    const echoed = { code: 1, stdout: "", stderr: `bad header Authorization: Bearer ${KEY}`, error: "exit code 1" }
    const failed = scripted([echoed])
    const d = deps(standIn().fetch, { runner: failed.runner, findCommand: async () => CLAUDE })
    expect(await connect(options({ target: "claude" }), d)).toBe(0)
    expect(failed.ran.map((r) => r.args[1])).toEqual(["add"])
    const text = d.lines.join("\n")
    expect(text).toContain(
      "Could not add Adiutor to Claude Code: claude mcp add exit code 1: bad header Authorization:",
    )
    expect(text).toContain("[redacted]")
    expect(keyLines(d.lines)).toEqual([claudeCommand(URL_BASE, KEY, "linux")])

    // A command that did not start is not retried, and nothing is removed.
    const unstarted = scripted([{ code: null, stdout: "", stderr: "", error: "could not start (ENOENT)" }])
    const e = deps(standIn().fetch, { runner: unstarted.runner, findCommand: async () => CLAUDE })
    expect(await connect(options({ target: "claude" }), e)).toBe(0)
    expect(unstarted.ran).toHaveLength(1)
    expect(e.lines.join("\n")).toContain("claude mcp add could not start (ENOENT)")
    expect(keyLines(e.lines)).toEqual([claudeCommand(URL_BASE, KEY, "linux")])

    // The existing entry was removed, but the new add still fails: the command to run by hand.
    const twice = scripted([exists, { code: 0, stdout: "", stderr: "" }, { ...exists, stderr: "write failed" }])
    const f = deps(standIn().fetch, { runner: twice.runner, findCommand: async () => CLAUDE })
    expect(await connect(options({ target: "claude" }), f)).toBe(0)
    expect(twice.ran.map((r) => r.args[1])).toEqual(["add", "remove", "add"])
    expect(f.lines.join("\n")).toContain("claude mcp add exit code 1: write failed")
    expect(keyLines(f.lines)).toEqual([claudeCommand(URL_BASE, KEY, "linux")])
  })
})

describe("connect: Codex", () => {
  const CODEX = "C:\\Users\\owner\\AppData\\Roaming\\npm\\codex.cmd"
  const SETX = "C:\\Windows\\System32\\setx.exe"
  const windowsCommands = async (name: string) => ({ setx: SETX, codex: CODEX })[name]
  const keyLines = (lines: string[]) => lines.filter((line) => line.includes(KEY))
  const recording = (answer: (command: string) => RunResult) => {
    const ran: { command: string; args: string[] }[] = []
    const runner: Runner = async (command, args) => {
      ran.push({ command, args })
      return answer(command)
    }
    return { ran, runner }
  }
  const fine = () => ({ code: 0, stdout: "", stderr: "" })
  const configLines = [`[mcp_servers.adiutor]`, `url = "${URL_BASE}/mcp"`, `bearer_token_env_var = "ADIUTOR_AGENT_KEY"`]

  it("on Windows, sets ADIUTOR_AGENT_KEY with setx, then runs codex mcp add, and prints no key", async () => {
    const { ran, runner } = recording(fine)
    const d = deps(standIn().fetch, { platform: "win32", runner, findCommand: windowsCommands })
    expect(await connect(options({ target: "codex" }), d)).toBe(0)
    expect(codexAddArgs(URL_BASE)).toEqual([
      "mcp",
      "add",
      "adiutor",
      "--url",
      `${URL_BASE}/mcp`,
      "--bearer-token-env-var",
      "ADIUTOR_AGENT_KEY",
    ])
    // codex mcp add replaces an entry of the same name itself: a second connect runs the same, without a remove.
    expect(ran).toEqual([
      { command: SETX, args: ["ADIUTOR_AGENT_KEY", KEY] },
      { command: CODEX, args: codexAddArgs(URL_BASE) },
    ])
    const text = d.lines.join("\n")
    expect(text).toContain("Set ADIUTOR_AGENT_KEY for your Windows user.")
    expect(text).toContain("Added the adiutor server to Codex; it reads the key from ADIUTOR_AGENT_KEY.")
    expect(text).toContain("Restart Codex from a new terminal")
    expect(keyLines(d.lines)).toEqual([])

    const again = recording(fine)
    await connect(
      options({ target: "codex" }),
      deps(standIn().fetch, { platform: "win32", runner: again.runner, findCommand: windowsCommands }),
    )
    expect(again.ran.map((r) => r.args.slice(0, 2))).toEqual([
      ["ADIUTOR_AGENT_KEY", KEY],
      ["mcp", "add"],
    ])
  })

  it("elsewhere, writes the key to an owner-only codex.env and prints the line for the shell profile", async () => {
    const config = tempDir()
    const { ran, runner } = recording(fine)
    const d = deps(standIn().fetch, {
      env: { XDG_CONFIG_HOME: config },
      runner,
      findCommand: async () => "/opt/bin/codex",
    })
    expect(await connect(options({ target: "codex" }), d)).toBe(0)
    const file = join(config, "adiutor", "codex.env")
    expect(codexEnvFile({ XDG_CONFIG_HOME: config })).toBe(file)
    expect(readFileSync(file, "utf8")).toBe(`export ADIUTOR_AGENT_KEY='${KEY}'\n`)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(ran).toEqual([{ command: "/opt/bin/codex", args: codexAddArgs(URL_BASE) }])
    expect(d.lines).toContain(`. "${file}"`)
    expect(keyLines(d.lines)).toEqual([])

    // A second connect replaces the old key in the file.
    writeFileSync(file, "export ADIUTOR_AGENT_KEY=old\n")
    await connect(
      options({ target: "codex" }),
      deps(standIn().fetch, { env: { XDG_CONFIG_HOME: config }, runner, findCommand: async () => "/opt/bin/codex" }),
    )
    expect(readFileSync(file, "utf8")).toBe(`export ADIUTOR_AGENT_KEY='${KEY}'\n`)
  })

  it("prints the config.toml lines, without the key, when codex is not installed or fails", async () => {
    for (const findCommand of [async (name: string) => (name === "setx" ? SETX : undefined), windowsCommands]) {
      const { ran, runner } = recording((command) =>
        command === CODEX
          ? { code: 2, stdout: "", stderr: "error: unexpected argument", error: "exit code 2" }
          : fine(),
      )
      const d = deps(standIn().fetch, { platform: "win32", runner, findCommand })
      expect(await connect(options({ target: "codex" }), d)).toBe(0)
      expect(ran[0]).toEqual({ command: SETX, args: ["ADIUTOR_AGENT_KEY", KEY] })
      const text = d.lines.join("\n")
      expect(text).toContain(
        (await findCommand("codex"))
          ? "Could not add Adiutor to Codex: codex mcp add exit code 2: error: unexpected argument."
          : "Could not add Adiutor to Codex: the codex command was not found.",
      )
      expect(text).toContain(`Add this to ~/.codex/config.toml yourself:\n\n${configLines.join("\n")}`)
      expect(text).toContain("Restart Codex from a new terminal")
      expect(keyLines(d.lines)).toEqual([])
    }
  })

  it("prints the variable's line once, with the key, when setx or the env file fails, and still adds Codex", async () => {
    const { ran, runner } = recording((command) =>
      command === SETX ? { code: 1, stdout: "", stderr: "ERROR: Access is denied.", error: "exit code 1" } : fine(),
    )
    const windows = deps(standIn().fetch, { platform: "win32", runner, findCommand: windowsCommands })
    expect(await connect(options({ target: "codex" }), windows)).toBe(0)
    expect(ran.map((r) => r.command)).toEqual([SETX, CODEX])
    expect(windows.lines.join("\n")).toContain(
      "Could not set ADIUTOR_AGENT_KEY: setx exit code 1: ERROR: Access is denied.",
    )
    expect(keyLines(windows.lines)).toEqual([`setx ADIUTOR_AGENT_KEY "${KEY}"`])
    expect(codexVariableLine(KEY, "win32")).toBe(`setx ADIUTOR_AGENT_KEY "${KEY}"`)

    const noSetx = deps(standIn().fetch, {
      platform: "win32",
      runner: recording(fine).runner,
      findCommand: windowsCommands,
      systemCommand: async () => undefined,
    })
    expect(await connect(options({ target: "codex" }), noSetx)).toBe(0)
    expect(noSetx.lines.join("\n")).toContain(
      "Could not set ADIUTOR_AGENT_KEY: setx was not found in %SystemRoot%\\System32.",
    )
    expect(keyLines(noSetx.lines)).toEqual([`setx ADIUTOR_AGENT_KEY "${KEY}"`])

    // A file where the folder should be: the env file cannot be written.
    const blocked = join(tempDir(), "not-a-folder")
    writeFileSync(blocked, "")
    const linux = deps(standIn().fetch, {
      env: { XDG_CONFIG_HOME: blocked },
      runner: recording(fine).runner,
      findCommand: async () => "/opt/bin/codex",
    })
    expect(await connect(options({ target: "codex" }), linux)).toBe(0)
    expect(linux.lines.join("\n")).toContain("Could not set ADIUTOR_AGENT_KEY: cannot write")
    expect(keyLines(linux.lines)).toEqual([`export ADIUTOR_AGENT_KEY='${KEY}'`])
    expect(linux.lines.join("\n")).toContain("Added the adiutor server to Codex")
  })
})

describe("connect: the sync's env file", () => {
  it("writes the key into a file only the owner can read, keeps its other values, never the session token", async () => {
    const file = join(tempDir(), "adiutor", "sync.env")
    const d = deps(standIn().fetch)
    expect(await connect(options({ target: "sync", envFile: file }), d)).toBe(0)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(join(file, "..")).mode & 0o077).toBe(0)
    expect(readFileSync(file, "utf8")).toBe(`ADIUTOR_URL=${URL_BASE}\nADIUTOR_AGENT_TOKEN=${KEY}\n`)
    expect(d.lines.join("\n")).not.toContain(KEY)

    writeFileSync(file, `# the sync\nT3CODE_CLI_PATH=C:\\t3\\t3.cmd\nADIUTOR_AGENT_TOKEN=old\n`, { mode: 0o644 })
    expect(await connect(options({ target: "sync", envFile: file }), deps(standIn().fetch))).toBe(0)
    expect(readFileSync(file, "utf8")).toBe(
      `# the sync\nT3CODE_CLI_PATH=C:\\t3\\t3.cmd\nADIUTOR_AGENT_TOKEN=${KEY}\nADIUTOR_URL=${URL_BASE}\n`,
    )
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readFileSync(file, "utf8")).not.toContain(SESSION)
  })

  it("leaves exactly one definition of each value when the file holds duplicates, so the new key wins", async () => {
    const file = join(tempDir(), "sync.env")
    writeFileSync(
      file,
      [
        "ADIUTOR_URL=https://old.example.com",
        "ADIUTOR_AGENT_TOKEN=old-one",
        "T3CODE_CLI_PATH=C:\\t3\\t3.cmd",
        "export ADIUTOR_AGENT_TOKEN=old-two",
        "# a comment",
        "ADIUTOR_URL=https://older.example.com",
        "ADIUTOR_OVERVIEW_DIR=C:\\overview",
        "",
      ].join("\n"),
    )
    expect(await connect(options({ target: "sync", envFile: file }), deps(standIn().fetch))).toBe(0)
    const text = readFileSync(file, "utf8")
    expect(parseEnvFile(text)).toEqual({
      ADIUTOR_URL: URL_BASE,
      ADIUTOR_AGENT_TOKEN: KEY,
      T3CODE_CLI_PATH: "C:\\t3\\t3.cmd",
      ADIUTOR_OVERVIEW_DIR: "C:\\overview",
    })
    expect(text.split("\n").filter((line) => /ADIUTOR_AGENT_TOKEN=/.test(line))).toEqual([`ADIUTOR_AGENT_TOKEN=${KEY}`])
    expect(text.split("\n").filter((line) => /ADIUTOR_URL=/.test(line))).toEqual([`ADIUTOR_URL=${URL_BASE}`])
    expect(text).toContain("# a comment\n")
  })

  it("ends the session when the key cannot be saved, and says which key to disconnect", async () => {
    const file = join(tempDir(), "sync.env")
    writeFileSync(file, "this line is not KEY=VALUE\n")
    const adiutor = standIn()
    const d = deps(adiutor.fetch)
    expect(await connect(options({ target: "sync", envFile: file }), d)).toBe(1)
    expect(adiutor.sent.at(-1)?.path).toBe("/revoke-session")
    expect(d.lines.join("\n")).toContain('the key "claude-laptop" was created but could not be saved')
    expect(readFileSync(file, "utf8")).not.toContain(KEY)
  })

  it("on Windows, restricts the file with icacls and checks it before asking Adiutor for anything", async () => {
    const file = join(tempDir(), "sync.env")
    const acl = (entries: string[]): RunResult => ({
      code: 0,
      stdout: `${file} ${entries.join("\n    ")}\n\nSuccessfully processed 1 files; Failed processing 0 files\n`,
      stderr: "",
    })
    const env = { USERNAME: "owner", USERDOMAIN: "DESKTOP" }
    const ok = standIn()
    const calls: string[][] = []
    const good = deps(ok.fetch, {
      platform: "win32",
      env,
      runner: async (command, args) => {
        calls.push([command, ...args])
        return args.length === 1 ? acl(["DESKTOP\\owner:(F)"]) : { code: 0, stdout: "", stderr: "" }
      },
    })
    expect(await connect(options({ target: "sync", envFile: file }), good)).toBe(0)
    const icacls = "C:\\Windows\\System32\\icacls.exe"
    expect(calls[0]).toEqual([icacls, file, "/inheritance:r", "/grant:r", "DESKTOP\\owner:F"])
    expect(calls[1]).toEqual([icacls, file])
    expect(readFileSync(file, "utf8")).toContain(KEY)

    for (const entries of [
      ["DESKTOP\\owner:(F)", "BUILTIN\\Administrators:(I)(F)"],
      ["DESKTOP\\owner:(I)(F)"],
      ["DESKTOP\\someone:(F)"],
      ["DESKTOP\\owner:(R)"],
    ]) {
      const refused = standIn()
      const d = deps(refused.fetch, {
        platform: "win32",
        env,
        runner: async (_command, args) => (args.length === 1 ? acl(entries) : { code: 0, stdout: "", stderr: "" }),
      })
      expect(await connect(options({ target: "sync", envFile: join(tempDir(), "sync.env") }), d)).toBe(1)
      expect(refused.sent).toEqual([])
      expect(d.lines.join("\n")).toContain("not restricted to the current user")
    }
  })

  it("on Windows, refuses the env file before asking Adiutor when icacls is not in System32", async () => {
    const file = join(tempDir(), "sync.env")
    const adiutor = standIn()
    const asked: string[] = []
    const d = deps(adiutor.fetch, {
      platform: "win32",
      env: { USERNAME: "owner", USERDOMAIN: "DESKTOP" },
      systemCommand: async (name) => {
        asked.push(name)
        return undefined
      },
    })
    expect(await connect(options({ target: "sync", envFile: file }), d)).toBe(1)
    expect(asked).toEqual(["icacls"])
    expect(d.ran).toEqual([])
    expect(adiutor.sent).toEqual([])
    expect(d.lines.join("\n")).toContain("icacls was not found in %SystemRoot%\\System32")
    expect(readFileSync(file, "utf8")).toBe("")
  })

  it("reads icacls entries and sets only the two keys", () => {
    const path = "C:\\Users\\owner\\AppData\\Local\\adiutor\\sync.env"
    expect(aclEntries(`${path} DESKTOP\\owner:(F)\n                 NT AUTHORITY\\SYSTEM:(F)\n\nDone\n`, path)).toEqual(
      ["DESKTOP\\owner:(F)", "NT AUTHORITY\\SYSTEM:(F)"],
    )
    expect(withSyncKey("export ADIUTOR_URL=x\r\nOTHER=1\r\n", "https://m", "k")).toBe(
      "ADIUTOR_URL=https://m\nOTHER=1\nADIUTOR_AGENT_TOKEN=k\n",
    )
  })

  it("keeps the env file outside every repository by default", () => {
    expect(defaultEnvFile("win32", { LOCALAPPDATA: "C:\\Users\\owner\\AppData\\Local" })).toBe(
      "C:\\Users\\owner\\AppData\\Local\\adiutor\\sync.env",
    )
    expect(defaultEnvFile("linux", { XDG_CONFIG_HOME: "/home/owner/.config" })).toBe(
      "/home/owner/.config/adiutor/sync.env",
    )
  })
})

describe("connect: the key Adiutor answers", () => {
  const letters = "a".repeat(64)
  // Each holds something a shell or the env file would read as more than a key.
  const refused = [
    `${KEY};echo injected`,
    "adt_x$(id)",
    `adt_${letters}\nT3CODE_CLI_PATH=/tmp/program`,
    `adt_${letters}\r`,
    `adt_~${letters}`,
    `adt_${letters}'`,
    `adt_${letters} `,
    `adt_${letters}\u2028`,
    `adt_${"a".repeat(31)}`,
    `adt_${"a".repeat(257)}`,
    letters,
    "adt_short",
    "",
    // Not a string, or missing.
    null,
    42,
    [KEY],
    { key: KEY },
    undefined,
  ]
  const refusal =
    'connect: Adiutor created the key "claude-laptop", but its answer is not a valid agent key, so nothing was ' +
    "saved. Disconnect it in Adiutor, Settings, Agent access."
  const before = `# the sync\nT3CODE_CLI_PATH=C:\\t3\\t3.cmd\nADIUTOR_URL=${URL_BASE}\nADIUTOR_AGENT_TOKEN=old\n`

  it("refuses a key that is not an agent key before saving, printing or passing it on, and still ends the session", async () => {
    for (const bad of refused)
      for (const [target, platform] of [
        ["sync", "linux"],
        ["claude", "linux"],
        ["claude", "win32"],
        ["codex", "linux"],
        ["codex", "win32"],
      ] as const) {
        const config = tempDir()
        const envFile = join(config, "sync.env")
        writeFileSync(envFile, before)
        const adiutor = standIn({
          create: { status: 200, body: { key: bad, id: "k1", expiresAt: "2027-01-31T08:00:00.000Z" } },
        })
        const ran: string[] = []
        const d = deps(adiutor.fetch, {
          platform,
          env: { XDG_CONFIG_HOME: config },
          findCommand: async (name) => `/opt/bin/${name}`,
          runner: async (command) => {
            ran.push(command)
            return { code: 0, stdout: "", stderr: "" }
          },
        })
        expect(await connect(options({ target, envFile }), d)).toBe(1)
        expect(adiutor.sent.at(-1)?.path).toBe("/revoke-session")
        expect(ran).toEqual([])
        const text = d.lines.join("\n")
        expect(text).toContain(refusal)
        if (typeof bad === "string")
          for (const part of bad.split(/[\r\n\u2028]/).filter(Boolean)) expect(text).not.toContain(part)
        expect(text).not.toContain(KEY)
        expect(readFileSync(envFile, "utf8")).toBe(before)
        expect(existsSync(join(config, "adiutor", "codex.env"))).toBe(false)
      }
  })

  it("says nothing was created when Adiutor refuses, as before", async () => {
    const adiutor = standIn({ create: { status: 403, body: { code: "FORBIDDEN", key: "adt_x$(id)" } } })
    const d = deps(adiutor.fetch)
    expect(await connect(options({ target: "claude" }), d)).toBe(1)
    expect(d.lines.join("\n")).toContain("connect: Adiutor did not create the key: HTTP 403, FORBIDDEN")
    expect(d.lines.join("\n")).not.toContain("$(id)")
  })

  it("accepts an agent key of letters and digits, from 32 to 256 after the prefix", async () => {
    for (const key of [
      `adt_${randomBytes(48).toString("hex")}`,
      `adt_${randomBytes(16).toString("hex")}`,
      `adt_${randomBytes(128).toString("hex")}`,
    ]) {
      const file = join(tempDir(), "sync.env")
      const adiutor = standIn({ create: { status: 200, body: { key, expiresAt: "2027-01-31T08:00:00.000Z" } } })
      expect(await connect(options({ target: "sync", envFile: file }), deps(adiutor.fetch))).toBe(0)
      expect(parseEnvFile(readFileSync(file, "utf8")).ADIUTOR_AGENT_TOKEN).toBe(key)
    }
    expect(AGENT_KEY_PREFIX).toBe(SERVER_KEY_PREFIX)
  })

  it("never writes a line break into the sync's env file", () => {
    for (const value of [`${KEY}\nT3CODE_CLI_PATH=/tmp/program`, `${KEY}\r`, "\n"]) {
      expect(() => withSyncKey("", URL_BASE, value)).toThrow("ADIUTOR_AGENT_TOKEN holds a line break")
      expect(() => withSyncKey("", `${URL_BASE}${value}`, KEY)).toThrow("ADIUTOR_URL holds a line break")
    }
  })

  it("quotes the key in every line written or printed for a POSIX shell", () => {
    expect(claudeCommand(URL_BASE, KEY, "linux")).toBe(
      `claude mcp add --transport http --scope user adiutor ${URL_BASE}/mcp --header 'Authorization: Bearer ${KEY}'`,
    )
    expect(claudeCommand(URL_BASE, KEY, "darwin")).toContain(`--header 'Authorization: Bearer ${KEY}'`)
    expect(claudeCommand(URL_BASE, KEY, "win32")).toContain(`--header "Authorization: Bearer ${KEY}"`)
    expect(codexVariableLine(KEY, "linux")).toBe(`export ADIUTOR_AGENT_KEY='${KEY}'`)
    expect(codexVariableLine(KEY, "win32")).toBe(`setx ADIUTOR_AGENT_KEY "${KEY}"`)
  })
})

describe("connect: the command line", () => {
  const run = async (args: string[], env: Record<string, string> = {}) => {
    const lines: string[] = []
    const code = await main(["connect", ...args], {
      env,
      runner: async () => ({ code: 0, stdout: "", stderr: "" }),
      fetch: async () => {
        throw new Error("no request expected")
      },
      out: (line) => lines.push(line),
      now: () => new Date(0),
      nodePath: "/fake/node",
    })
    return { code, text: lines.join("\n") }
  }

  it("refuses a missing name, target or address, days out of range, and http other than this machine", async () => {
    expect((await run(["--for", "claude", "--url", URL_BASE])).code).toBe(2)
    expect((await run(["--name", "x", "--url", URL_BASE])).code).toBe(2)
    expect((await run(["--name", "x", "--for", "other", "--url", URL_BASE])).code).toBe(2)
    expect((await run(["--name", "x", "--for", "claude", "--url", URL_BASE, "--days", "0"])).code).toBe(2)
    expect((await run(["--name", "x", "--for", "claude", "--url", URL_BASE, "--days", "366"])).code).toBe(2)
    expect((await run(["--name", "x", "--for", "claude", "--url", URL_BASE, "--days", "1.5"])).code).toBe(2)
    expect((await run(["--name", "x".repeat(33), "--for", "claude", "--url", URL_BASE])).code).toBe(2)
    expect((await run(["--name", "x", "--for", "claude", "--env", "/nonexistent/sync.env"])).code).toBe(2)
    expect(connectUrl("http://adiutor.example.com")).toBeUndefined()
    expect(connectUrl("https://user:pw@adiutor.example.com")).toBeUndefined()
    expect(connectUrl("https://adiutor.example.com/?q=1")).toBeUndefined()
    expect(connectUrl("https://adiutor.example.com/")).toBe("https://adiutor.example.com")
    expect(connectUrl("http://127.0.0.1:8090")).toBe("http://127.0.0.1:8090")
  })

  it("matches the server's client id and key limits, and defaults to 90 days", () => {
    expect(CONNECT_CLIENT_ID).toBe(SERVER_CLIENT_ID)
    expect([DAYS_MIN, DAYS_MAX, NAME_MAX]).toEqual([AGENT_KEY_DAYS_MIN, AGENT_KEY_DAYS_MAX, AGENT_KEY_NAME_MAX])
    expect(DEFAULT_DAYS).toBe(90)
  })
})
