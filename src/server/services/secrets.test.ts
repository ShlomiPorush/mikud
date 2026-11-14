import { describe, expect, it } from "vitest"
import { createSecretScanner, isPlaceholder, REDACTED, ReloadableSecretScanner } from "./secrets.ts"

// Every fake secret is assembled at run time, so no file in the repository holds a string that looks
// like a real credential (and GitHub push protection has nothing to flag).
const rep = (chars: string, n: number) => chars.repeat(Math.ceil(n / chars.length)).slice(0, n)
const ip = (...octets: number[]) => octets.join(".")

const fake = {
  github_classic: `${"gh"}p_${rep("aB3dE6gH9k", 36)}`,
  github_oauth: `${"gh"}o_${rep("Zx8Cv7Bn6M", 36)}`,
  github_pat: `${"github"}_pat_${rep("11ABCDEFG0", 22)}_${rep("aZ09bY18cX", 59)}`,
  openai: `${"sk"}-proj-${rep("Ab12Cd34Ef", 48)}`,
  openai_legacy: `${"sk"}-${rep("T3BlbkFJx9", 48)}`,
  anthropic: `${"sk"}-ant-api03-${rep("Qw-Er_Ty12", 90)}`,
  slack: `${"xo"}xb-${rep("1234567890", 12)}-${rep("abcdEFGH12", 24)}`,
  slack_webhook: `https://hooks.${"slack"}.com/services/T0${rep("A1B2C3", 8)}/B0${rep("D4E5F6", 8)}/${rep("x9Y8z7", 24)}`,
  aws: `${"AK"}IA${rep("Q2W3E4R5T6", 16)}`,
  google: `${"AI"}za${rep("Sy9_x-Lk2P", 35)}`,
  telegram: `${"123456"}789:${rep("AAF-xY_12z", 35)}`,
  jwt: `${"ey"}JhbGciOiJIUzI1NiJ9.${"ey"}JzdWIiOiIxMjM0NTY3ODkwIn0.${rep("dBjftJeZ4C", 43)}`,
  privateKey: `-----BEGIN ${"OPENSSH"} PRIVATE KEY-----\n${rep("b3BlbnNzaC1rZXk", 60)}\n-----END OPENSSH PRIVATE KEY-----`,
  rsaKey: `-----BEGIN ${"RSA"} PRIVATE KEY-----`,
}

const scanner = createSecretScanner(["corp.example", "internal.test"])

describe("secret scanner", () => {
  it.each([
    ["github_token", `Pushed with ${fake.github_classic} today`],
    ["github_token", fake.github_oauth],
    ["github_token", `token was ${fake.github_pat}`],
    ["openai_key", `OPENAI ${fake.openai}`],
    ["openai_key", fake.openai_legacy],
    ["anthropic_key", fake.anthropic],
    ["slack_token", fake.slack],
    ["slack_webhook", `posts to ${fake.slack_webhook}`],
    ["aws_access_key", `key id ${fake.aws}`],
    ["google_api_key", `maps key ${fake.google}`],
    ["telegram_bot_token", `bot ${fake.telegram}`],
    ["jwt", `Authorization header had ${fake.jwt}`],
    ["private_key", fake.privateKey],
    ["private_key", fake.rsaKey],
    ["url_credentials", "connect to postgres://app:S3cretPassw0rd@db.example.com:5432/app"],
    ["url_credentials", "https://deploy:hunter22@git.example.org/repo.git"],
    ["secret_assignment", "set password=Winter2026! in the env"],
    ["secret_assignment", 'config {"api_key": "a8f5f167f44f4964e6c998dee827110c"}'],
    ["secret_assignment", "TOKEN: Zq81-kd92-xx01"],
    ["secret_assignment", "client_secret = 9f8e7d6c5b4a"],
    ["secret_assignment", `ADIUTOR_OWNER_TOKEN=${rep("0123456789abcdef", 64)}`],
    ["secret_assignment", `export ADIUTOR_AGENT_TOKEN="${rep("f00dCafe12", 40)}"`],
    ["secret_assignment", "DB_PASSWORD=Spring2026x"],
    ["secret_assignment", "smtp_passwd: x9k2m4q7z"],
    ["secret_assignment", `STRIPE_SECRET=${rep("q1w2e3r4", 24)}`],
    ["secret_assignment", `OPENAI_APIKEY=${rep("Zz9Yy8Xx7", 24)}`],
    ["secret_assignment", `signing-key: ${rep("a1b2c3d4", 16)}`],
    // Lower-case values (hex, a passphrase of words) after an env-style secret name.
    ["secret_assignment", `ADIUTOR_OWNER_TOKEN=${rep("deadbeef", 64)}`],
    ["secret_assignment", `DB_PASSWORD=${["correct", "horse", "battery"].join("")}`],
    ["ipv4_address", `server at ${ip(10, 1, 20, 30)}`],
    ["ipv4_address", `ssh to ${ip(192, 168, 1, 50)}:22`],
    ["ipv4_address", `public ${ip(8, 8, 4, 4)}`],
    ["private_host", "deployed on app01.corp.example yesterday"],
    ["private_host", "see CORP.EXAMPLE for the VPN"],
    ["private_host", "db.internal.test."],
  ])("refuses %s", (rule, text) => {
    expect(scanner.find(text)).toBe(rule)
  })

  it.each([
    ["a commit SHA", "Fixed in 9fceb02d0ae598e95dc970b74767f19372d61af8 and merged"],
    ["a short SHA", "see 9fceb02 on main"],
    ["a sha256 checksum", "sha256: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["a UUID", "item 0b8f2d4e-6c1a-4f3e-9d2b-7a5c8e1f3b6d moved"],
    ["a version number", "upgraded to 1.32.2, then 24.21.0-bookworm-slim and v1.2.3.4"],
    ["a dotted version run", "release 1.2.3.4.5"],
    [
      "loopback and documentation addresses",
      `binds ${ip(127, 0, 0, 1)}, example ${ip(192, 0, 2, 10)} and ${ip(203, 0, 113, 7)}`,
    ],
    ["a masked password", "password=***"],
    ["a placeholder token", "token: <token>"],
    ["a redacted value", "api_key=[redacted]"],
    ["an environment variable reference", `token=${"$"}{GITHUB_TOKEN} and secret: ADIUTOR_AGENT_TOKEN`],
    ["prose about tokens", "The token: expired after a week. Rotate the secret: done."],
    ["an env-style placeholder", "ADIUTOR_OWNER_TOKEN=<64 hex characters> and DB_PASSWORD=*** and API_KEY=changeme"],
    ["an env-style reference", `ADIUTOR_AGENT_TOKEN=${"$"}{ADIUTOR_AGENT_TOKEN} and CACHE_KEY=${"$"}CACHE`],
    ["a short env-style value", "SORT_KEY=name1"],
    ["an env-style name in prose", "Set ADIUTOR_OWNER_TOKEN: rotated last week"],
    ["a placeholder in a URL", "postgres://adiutor:<password>@db.example.com/adiutor"],
    ["a URL with a port", "open https://example.com:8443/path@v2"],
    ["the public domain of a private one", "corp.example.org is someone else's"],
    ["a time", "meet at 10:30, deploy at 12:00:01"],
    ["plain words", "Agents may not delete items. Mark it done when the PR is merged."],
  ])("passes %s", (_, text) => {
    expect(scanner.find(text)).toBeNull()
  })

  it("finds host names only when private domains are configured", () => {
    expect(createSecretScanner().find("app01.corp.example")).toBeNull()
    expect(createSecretScanner([" .Corp.Example. "]).find("app01.corp.example")).toBe("private_host")
  })

  it("redacts every match and keeps the rest of the text", () => {
    const text = `Thread: fix ${fake.github_classic} leak on ${ip(10, 0, 0, 5)}, password=Winter2026! at app.corp.example, commit 9fceb02`
    const out = scanner.redact(text)
    expect(out).toBe(`Thread: fix ${REDACTED} leak on ${REDACTED}, password=${REDACTED} at ${REDACTED}, commit 9fceb02`)
    expect(scanner.find(out)).toBeNull()
  })

  it("redacts a whole private key block, and a truncated one to the end of the text", () => {
    const body = rep("b3BlbnNzaC1rZXk", 60)
    const begin = `-----BEGIN ${"OPENSSH"} PRIVATE KEY-----`
    const full = [`key: ${begin}`, body, "-----END OPENSSH PRIVATE KEY-----", "after"].join(" ")
    expect(scanner.redact(full)).toBe(`key: ${REDACTED} after`)
    const truncated = [`pasted ${begin}`, body, body].join(" ")
    expect(scanner.redact(truncated)).toBe(`pasted ${REDACTED}`)
  })

  it("redacts only the password of URL credentials", () => {
    expect(scanner.redact("postgres://app:S3cretPassw0rd@db.example.com/app")).toBe(
      `postgres://app:${REDACTED}@db.example.com/app`,
    )
  })

  it("leaves text without secrets unchanged", () => {
    const text = "Refactor the sync, version 1.2.3, see 0b8f2d4e-6c1a-4f3e-9d2b-7a5c8e1f3b6d"
    expect(scanner.redact(text)).toBe(text)
  })

  it.each(["***", "<token>", "[redacted]", `${"$"}{VAR}`, "ADIUTOR_OWNER_TOKEN", "changeme", ""])(
    "treats %s as a placeholder",
    (value) => {
      expect(isPlaceholder(value)).toBe(true)
    },
  )
})

describe("scan time", () => {
  // A long run of sentence punctuation inside an assignment's value, at the length a note body accepts.
  // The check must stay linear: one request must not hold the server for seconds.
  const budgetMs = 250
  const run = (chars: string) => `a${rep(chars, 100_000)}a`
  const scanner = createSecretScanner()
  const timed = <T>(fn: () => T): [T, number] => {
    const start = performance.now()
    const result = fn()
    return [result, performance.now() - start]
  }

  it.each([
    ["token=", "."],
    ["DB_PASSWORD=", "."],
    ["token=", "!?:."],
    ["DB_PASSWORD=", "!?:."],
  ])(
    "finds %s with a long %s run in linear time",
    (key, chars) => {
      const [rule, ms] = timed(() => scanner.find(`${key}${run(chars)}`))
      expect(rule).toBe("secret_assignment")
      expect(ms).toBeLessThan(budgetMs)
    },
    30_000,
  )

  it.each([
    ["token=", "."],
    ["DB_PASSWORD=", "."],
  ])(
    "redacts %s with a long %s run in linear time",
    (key, chars) => {
      const [out, ms] = timed(() => scanner.redact(`${key}${run(chars)}`))
      expect(out).toBe(`${key}${REDACTED}`)
      expect(ms).toBeLessThan(budgetMs)
    },
    30_000,
  )

  it("passes a value of punctuation alone in linear time", () => {
    const [rule, ms] = timed(() => scanner.find(`token=${rep(".", 100_000)}`))
    expect(rule).toBeNull()
    expect(ms).toBeLessThan(budgetMs)
  }, 30_000)
})

describe("sentence punctuation after a value", () => {
  const scanner = createSecretScanner()

  it.each([
    `token=${rep("Ab3dE6", 12)}!?:.`,
    `DB_PASSWORD=${["Spring", "2026x"].join("")}.`,
    `API_SECRET=${rep("q1w2e3r4", 16)}:`,
  ])("still refuses %s", (text) => {
    expect(scanner.find(text)).toBe("secret_assignment")
  })

  it.each([
    "token: expired.",
    "secret=rotated!?",
    "password=***.",
    "DB_PASSWORD=short1.",
    "DB_PASSWORD=*******.!",
    "SIGNING_KEY=<key>:",
  ])("still passes %s", (text) => {
    expect(scanner.find(text)).toBeNull()
  })
})

describe("Adiutor's own agent keys", () => {
  it("refuses an adt_ key, also inside a sentence, and lets the prefix alone pass", () => {
    const scanner = createSecretScanner()
    const key = `${"adt"}_${"AbCdEfGh".repeat(8)}`
    expect(scanner.find(`use ${key} for the sync`)).toBe("agent_key")
    expect(scanner.redact(`key=${key}`)).not.toContain(key)
    expect(scanner.find("keys start with adt_ and 64 letters")).toBeNull()
  })

  it("reloads the private domains without a new scanner", () => {
    const scanner = new ReloadableSecretScanner()
    expect(scanner.find("see build.corp.example")).toBeNull()
    scanner.setPrivateDomains(["corp.example"])
    expect(scanner.find("see build.corp.example")).toBe("private_host")
    scanner.setPrivateDomains([])
    expect(scanner.find("see build.corp.example")).toBeNull()
  })
})

describe("long runs without whitespace", () => {
  // A note body may be 100,000 characters, and the check runs on the server's only thread. No rule may
  // rescan a run from many starts, so the cost stays linear and these shapes take milliseconds.
  const budgetMs = 100
  const scanner = createSecretScanner(["corp.example"])
  const timed = <T>(fn: () => T): [T, number] => {
    const start = performance.now()
    const result = fn()
    return [result, performance.now() - start]
  }
  const header = `${"ey"}J${rep("A", 8)}`

  it.each([
    ["-eyJ", rep(`-${"ey"}J`, 100_000), null],
    ["a.", rep("a.", 100_000), null],
    ["a-", rep("a-", 100_000), null],
    [".eyJAAAAAAAA", rep(`.${header}`, 100_000), "jwt"],
    ["-eyJAAAAAAAA.eyJ", rep(`-${header}.${"ey"}J`, 100_000), "jwt"],
    ["a long scheme-like run before ://", rep(`${rep("a.", 32)}://${rep("u", 2_000)} `, 100_000), null],
    ["a user and password without @", `x://u:${rep("p:", 100_000)}`, null],
    ["a://b:c", rep("a://b:c", 100_000), null],
  ])(
    "checks %s at 100,000 characters in linear time",
    (_, text, rule) => {
      const [found, findMs] = timed(() => scanner.find(text))
      expect(found).toBe(rule)
      expect(findMs).toBeLessThan(budgetMs)
      const [out, redactMs] = timed(() => scanner.redact(text))
      expect(redactMs).toBeLessThan(budgetMs)
      if (rule === null) expect(out).toBe(text)
      else expect(scanner.find(out)).toBeNull()
    },
    30_000,
  )

  it("still finds URL credentials, also with a long password", () => {
    const password = rep("Ab9_-x:Q", 1_000)
    const text = `clone https://oauth2:${password}@git.example.org/repo.git`
    expect(scanner.find(text)).toBe("url_credentials")
    expect(scanner.redact(text)).toBe(`clone https://oauth2:${REDACTED}@git.example.org/repo.git`)
    expect(scanner.find(`redis+sentinel://cache:${"Wint3r"}IsComing@cache.example.com/0`)).toBe("url_credentials")
  })

  it("finds URL credentials after a scheme of up to 32 characters", () => {
    const credentials = `://app:${"S3cret"}Passw0rd@db.example.com/app`
    expect(scanner.find(`${rep("x", 32)}${credentials}`)).toBe("url_credentials")
    expect(scanner.find(`${rep("x", 33)}${credentials}`)).toBeNull()
  })

  it.each([
    ["at the start of the text", fake.jwt],
    ["after Bearer", `Authorization: Bearer ${fake.jwt}`],
    ["after =", `token_value=${fake.jwt}`],
    ["in quotes", `{"id_token":"${fake.jwt}"}`],
  ])("still finds a short JWT %s", (_, text) => {
    expect(scanner.find(text)).toBe("jwt")
    expect(scanner.redact(text)).not.toContain(fake.jwt)
  })

  it("still finds a JWT whose header is several kilobytes", () => {
    // A header with an embedded certificate chain (x5c) is long; the header segment has no length cap.
    const jwt = `${"ey"}J${rep("hbGciOiJSUzI1NiIsIng1YyI6WyJNSUlD", 4_000)}.${"ey"}JzdWIiOiIxMjM0NTY3ODkwIn0.${rep("dBjftJeZ4C", 43)}`
    expect(scanner.find(`header ${jwt} end`)).toBe("jwt")
    expect(scanner.redact(`header ${jwt} end`)).toBe(`header ${REDACTED} end`)
  })

  it("does not start a JWT inside a run of token characters", () => {
    // The price of linear time: a JWT glued to a word by "-" is not found.
    expect(scanner.find(`id-${fake.jwt}`)).toBeNull()
  })
})
