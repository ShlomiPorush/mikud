// Seeds a pull request stack (scripts/try-pr.sh) through the HTTP API. First the owner, as the first-run setup
// does it from the browser, on Better Auth's routes: sign-up with a generated password, TOTP enrolment, then an
// agent key (api-key plugin). The username, password, TOTP secret, backup codes and agent key go to
// ADIUTOR_OWNER_FILE (0600) and are never printed. Then invented fixtures with that agent key only, so the board has
// something to show: projects from a T3 snapshot, items in every status, goals, a stage proposal, security sources,
// comments and an inbox item.
// Reads ADIUTOR_URL, ADIUTOR_ORIGIN (the stack's public URL, for the origin check) and ADIUTOR_OWNER_FILE from the
// environment. Never prints a key, password or secret.

import { createHmac, randomBytes } from "node:crypto"
import { writeFileSync } from "node:fs"

const base = process.env.ADIUTOR_URL
const origin = process.env.ADIUTOR_ORIGIN
const ownerFile = process.env.ADIUTOR_OWNER_FILE
if (!base || !origin || !ownerFile) {
  console.error("ADIUTOR_URL, ADIUTOR_ORIGIN and ADIUTOR_OWNER_FILE are required")
  process.exit(2)
}

// --- The owner ---

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 seconds) from a base32 secret. */
function totp(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
  let bits = ""
  for (const char of secret.replace(/=+$/, "").toUpperCase())
    bits += alphabet.indexOf(char).toString(2).padStart(5, "0")
  const key = Buffer.from(bits.match(/.{8}/g).map((byte) => Number.parseInt(byte, 2)))
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)))
  const hmac = createHmac("sha1", key).update(counter).digest()
  const offset = hmac[hmac.length - 1] & 0xf
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0")
}

const cookies = new Map()
async function page(path, body) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join("; "),
    },
    body: JSON.stringify(body),
  })
  for (const cookie of res.headers.getSetCookie()) {
    const [pair] = cookie.split(";")
    const at = pair.indexOf("=")
    cookies.set(pair.slice(0, at), pair.slice(at + 1))
  }
  const json = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`POST ${path} answered ${res.status} ${json?.error?.code ?? json?.code ?? "unknown"}`)
  return json
}

const username = "owner"
// The username rule of src/shared/auth.ts (USERNAME_PATTERN, 3 to 30 characters), checked before the sign-up.
if (!/^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)*$/.test(username) || username.length < 3 || username.length > 30) {
  console.error("the seed username does not follow Adiutor's username rule")
  process.exit(2)
}
const password = randomBytes(18).toString("base64url")
await page("/api/auth/sign-up/email", {
  name: username,
  // The synthetic e-mail of src/shared/auth.ts (ownerEmail): the lowercased username at adiutor.local.
  email: `${username.toLowerCase()}@adiutor.local`,
  username,
  displayUsername: username,
  password,
})
const { totpURI, backupCodes } = await page("/api/auth/two-factor/enable", { password })
const totpSecret = new URL(totpURI).searchParams.get("secret")
await page("/api/auth/two-factor/verify-totp", { code: totp(totpSecret) })
const { key: token } = await page("/api/auth/api-key/create", { name: "try-pr seed", expiresIn: 30 * 86_400 })
writeFileSync(
  ownerFile,
  [
    "# Pull request stack only. Sign in at ADIUTOR_PUBLIC_URL; add the TOTP secret to an authenticator app.",
    `ADIUTOR_OWNER_USERNAME=${username}`,
    `ADIUTOR_OWNER_PASSWORD=${password}`,
    `ADIUTOR_OWNER_TOTP_SECRET=${totpSecret}`,
    `ADIUTOR_OWNER_BACKUP_CODES=${backupCodes.join(",")}`,
    "# An agent key (Settings, Agent access) for the API and MCP: Authorization: Bearer <key>.",
    `ADIUTOR_AGENT_KEY=${token}`,
    "",
  ].join("\n"),
  { mode: 0o600 },
)
console.log("    owner created with TOTP and an agent key; both written to the owner file")

// --- Fixtures, with the agent key ---

const now = Date.now()
const ago = (hours) => new Date(now - hours * 3_600_000).toISOString()

async function call(method, path, body) {
  const res = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-adiutor-agent": "try-pr seed",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = res.status === 204 ? null : await res.json().catch(() => null)
  if (!res.ok) {
    const code = json?.error?.code ?? "unknown"
    throw new Error(`${method} ${path} answered ${res.status} ${code}`)
  }
  return json?.data
}

const projects = [
  { t3ProjectId: "demo-harbor", title: "Harbor Notes", repo: "example-owner/harbor-notes" },
  { t3ProjectId: "demo-lantern", title: "Lantern Garden", repo: "example-owner/lantern-garden" },
  { t3ProjectId: "demo-ledger", title: "Quiet Ledger", repo: "example-owner/quiet-ledger" },
]

const thread = (threadId, t3ProjectId, title, status, settled, hours, extra = {}) => ({
  threadId,
  t3ProjectId,
  title,
  status,
  settled,
  settledAt: settled ? ago(hours) : null,
  parentThreadId: null,
  updatedAt: ago(hours),
  ...extra,
})

const t3 = await call("POST", "/sync/t3", {
  collectedAt: ago(0),
  projects,
  threads: [
    thread("demo-thread-harbor-1", "demo-harbor", "Add offline export", "running", false, 1),
    thread("demo-thread-harbor-1a", "demo-harbor", "Review offline export", "completed", true, 1, {
      parentThreadId: "demo-thread-harbor-1",
    }),
    thread("demo-thread-harbor-2", "demo-harbor", "Choose the sync format", "waiting", false, 3),
    thread("demo-thread-harbor-3", "demo-harbor", "Fix the date picker", "completed", true, 20),
    thread("demo-thread-lantern-1", "demo-lantern", "Plan the watering schedule view", "waiting", false, 5),
    thread("demo-thread-lantern-2", "demo-lantern", "Sketch the plant card", "completed", false, 30),
  ],
})

const byT3 = new Map((await call("GET", "/projects")).map((p) => [p.t3ProjectId, p]))
const id = (t3ProjectId) => {
  const project = byT3.get(t3ProjectId)
  if (!project) throw new Error(`project ${t3ProjectId} was not created by the snapshot`)
  return project.id
}
const harbor = id("demo-harbor")
const lantern = id("demo-lantern")
const ledger = id("demo-ledger")

await call("PATCH", `/projects/${harbor}`, {
  whereWeAre: "Export works on desktop; the phone layout is next.",
  goal: "Ship offline export",
})
await call("PATCH", `/projects/${lantern}`, { whereWeAre: "First screens sketched.", goal: "A usable first screen" })
await call("PATCH", `/projects/${ledger}`, { whereWeAre: "Paused until the import format is settled." })
const harborGoal = (await call("GET", `/projects/${harbor}`)).goal?.id ?? null

const items = [
  { projectId: harbor, type: "task", status: "todo", title: "Export to CSV", goalId: harborGoal },
  { projectId: harbor, type: "task", status: "done", title: "Export to JSON", goalId: harborGoal },
  { projectId: harbor, type: "bug", status: "in_progress", title: "Export skips empty notes", goalId: harborGoal },
  {
    projectId: harbor,
    type: "security",
    status: "todo",
    severity: "high",
    title: "Update the vulnerable markdown parser",
  },
  { projectId: harbor, type: "idea", status: "future", title: "Share a note as a link" },
  { projectId: lantern, type: "decision", status: "waiting_on_you", title: "Metric or imperial units by default?" },
  { projectId: lantern, type: "task", status: "not_relevant", title: "Port the old calendar widget" },
  { projectId: ledger, type: "task", status: "todo", title: "Write the import format notes" },
  {
    projectId: ledger,
    type: "bug",
    status: "waiting_on_you",
    title: "Totals differ after rounding",
    body: "Which rounding rule?",
  },
  {
    projectId: ledger,
    type: "security",
    status: "in_progress",
    severity: "critical",
    title: "Rotate the demo signing key",
  },
]
const created = []
for (const item of items) created.push(await call("POST", "/items", item))

await call("POST", `/items/${created[2].id}/comments`, { text: "Reproduced with a note that has only a title." })
await call("POST", `/items/${created[5].id}/comments`, { text: "Both work; metric matches the plant data source." })
await call("POST", `/projects/${harbor}/stage-proposals`, {
  stage: "development",
  reason: "Most of the export is built and used daily.",
})
await call("POST", `/projects/${ledger}/stage-proposals`, { stage: "frozen", reason: "No work for three weeks." })
await call("POST", "/capture", { text: "Try a weekly summary view\nSeen in another tool; maybe for the phone." })
await call("POST", "/threads/start", {
  threadId: "demo-thread-ledger-1",
  parentThreadId: null,
  title: "Investigate the rounding difference",
  t3ProjectId: "demo-ledger",
})

const counts = (critical, high, medium, low) => ({ critical, high, medium, low })
const security = await call("POST", "/sync/security", {
  collectedAt: ago(0),
  repos: [
    {
      repo: "example-owner/harbor-notes",
      openIssues: 4,
      issuesAsOf: ago(1),
      families: [
        { family: "dependabot", coverage: "enabled", counts: counts(1, 2, 0, 1), asOf: ago(1) },
        { family: "code_scanning", coverage: "enabled", counts: counts(0, 0, 1, 2), asOf: ago(1) },
        { family: "secret_scanning", coverage: "not_enabled", counts: counts(0, 0, 0, 0), asOf: null },
      ],
    },
    {
      repo: "example-owner/lantern-garden",
      openIssues: 0,
      issuesAsOf: ago(1),
      families: [{ family: "dependabot", coverage: "no_access", counts: counts(0, 0, 0, 0), asOf: null }],
    },
    {
      repo: "example-owner/quiet-ledger",
      openIssues: 2,
      issuesAsOf: ago(50),
      families: [{ family: "dependabot", coverage: "enabled", counts: counts(0, 1, 0, 0), asOf: ago(50) }],
    },
  ],
})

console.log(
  `    seeded ${byT3.size} projects, ${created.length + 2} items besides the synced ones, 2 stage proposals;` +
    ` T3 sync ${t3.outcome}, security sync ${security.outcome}`,
)
