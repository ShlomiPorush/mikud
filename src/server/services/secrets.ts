// High-confidence secret patterns for text written by agents (see "Secrets in agent text" in
// docs/project-foundation.md). A safety net, not a promise that every secret is caught. A refusal names
// the rule, never the matched text.

export const REDACTED = "[redacted]"

type Rule = {
  name: string
  /** Global, so it can be used with matchAll and replace. */
  pattern: RegExp
  /** When set, only this capture group is the secret: redact() keeps the rest of the match. */
  group?: number
  /** Returns false for a match that is not a secret after all (a placeholder, a documentation address). */
  accept?: (match: RegExpMatchArray) => boolean
}

/** Values that stand for a secret without being one: ***, <token>, [redacted], ${VAR}, SOME_ENV_NAME. */
export function isPlaceholder(value: string): boolean {
  const v = value.trim().replace(/^["'`]|["'`]$/g, "")
  if (v === "") return true
  return (
    /^[*•.…x]+$/i.test(v) ||
    // A closing bracket may be missing: the value pattern stops before it.
    /^<[^<>]*>?$/.test(v) ||
    /^\[[^[\]]*\]?$/.test(v) ||
    /^\{\{?[^{}]*\}?\}?$/.test(v) ||
    /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(v) ||
    /^%[A-Za-z_][A-Za-z0-9_]*%$/.test(v) ||
    /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(v) ||
    /^(?:redacted|hidden|secret|password|token|changeme|example|placeholder|none|null|empty|undefined|your[-_a-z]*)$/i.test(
      v,
    )
  )
}

/**
 * Sentence punctuation after a value is not part of it. A backward loop, so the time is linear in the
 * value's length: an unanchored /[.!?:]+$/ retries at every position of a long run and is quadratic.
 */
function stripTrailingPunctuation(value: string): string {
  let end = value.length
  while (end > 0 && ".!?:".includes(value.charAt(end - 1))) end--
  return value.slice(0, end)
}

/** A value after "password=" and friends looks like a credential, not a word of prose. */
function looksLikeCredential(raw: string): boolean {
  const value = stripTrailingPunctuation(raw)
  if (isPlaceholder(value) || value.length < 6) return false
  // A plain lower-case word ("token: expired", "secret: rotated") is prose.
  return !/^[a-z]+$/.test(value)
}

const IPV4 = /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?!\.?\d)/g

/** Loopback, unspecified, broadcast and the documentation ranges (RFC 5737) are not server details. */
function isReportableIpv4(address: string): boolean {
  const octets = address.split(".").map(Number)
  if (octets.some((o) => o > 255)) return false
  const [a, b, c] = octets
  if (a === 127 || a === 0 || a === 255) return false
  if (a === 192 && b === 0 && c === 2) return false
  if (a === 198 && b === 51 && c === 100) return false
  if (a === 203 && b === 0 && c === 113) return false
  return true
}

const ASSIGNMENT_KEYS =
  "password|passwd|pwd|passphrase|secret|client[_-]?secret|token|access[_-]?token|auth[_-]?token|refresh[_-]?token|bearer|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|private[_-]?key"

/** The endings of environment-style secret names; `api` + `key` covers APIKEY. */
const ENV_SUFFIXES = "token|secret|password|passwd|key"

const BASE_RULES: Rule[] = [
  {
    name: "private_key",
    // The whole block, BEGIN through END; a block cut off before its END runs to the end of the text.
    pattern:
      /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|$)/g,
  },
  {
    name: "url_credentials",
    // The scheme is at most 32 characters, so a long run of "a." or "a-" is not rescanned from every
    // word boundary in it. User and password keep no cap (a long token can be the password); they cannot
    // cross a "/", so only the few starts in front of one "://" scan them.
    pattern: /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s/:@]+:([^\s/@]+)@/gi,
    group: 1,
    accept: (m) => !isPlaceholder(m[1] ?? ""),
  },
  // Adiutor's own agent keys (Better Auth's api-key plugin: adt_ and 64 letters).
  { name: "agent_key", pattern: /\badt_[A-Za-z]{64}(?![A-Za-z0-9_])/g },
  { name: "github_token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/g },
  { name: "anthropic_key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: "openai_key", pattern: /\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g },
  { name: "slack_token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { name: "slack_webhook", pattern: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g },
  { name: "aws_access_key", pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g },
  { name: "google_api_key", pattern: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g },
  { name: "telegram_bot_token", pattern: /\b\d{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g },
  // A JWT does not start inside a run of token characters, so a long run is scanned from one start only
  // (a JWT glued to a word by "-" is not found). The header has no length cap: one with an embedded
  // certificate chain is several kilobytes.
  { name: "jwt", pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  {
    name: "secret_assignment",
    // key, optional closing quote of a JSON key, = or :, optional quote, then the value.
    pattern: new RegExp(`\\b(?:${ASSIGNMENT_KEYS})["']?\\s*[:=]\\s*["'\`]?([^\\s"'\`,;)}\\]]+)`, "gi"),
    group: 1,
    accept: (m) => looksLikeCredential(m[1] ?? ""),
  },
  {
    name: "secret_assignment",
    // Environment-style names (ADIUTOR_OWNER_TOKEN, DB_PASSWORD, signing-key, OPENAI_APIKEY): the word
    // boundary of the rule above does not see a key after "_", so these get their own rule. The name says
    // the value is a secret, so any value of 8 or more characters is one, lower-case words and hex
    // included; only placeholders (***, <...>, [redacted], ${VAR}, changeme, example) pass.
    pattern: new RegExp(
      `(?<![A-Za-z0-9_-])(?:[A-Za-z0-9]+[_-])*(?:[A-Za-z0-9]+[_-]|[A-Za-z0-9]*api)(?:${ENV_SUFFIXES})["']?\\s*[:=]\\s*["'\`]?([^\\s"'\`,;)}\\]]+)`,
      "gi",
    ),
    group: 1,
    accept: (m) => {
      const value = stripTrailingPunctuation(m[1] ?? "")
      return value.length >= 8 && !isPlaceholder(value)
    },
  },
  { name: "ipv4_address", pattern: IPV4, accept: (m) => isReportableIpv4(m[0]) },
]

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function privateHostRule(domains: readonly string[]): Rule | undefined {
  const names = domains
    .map((d) =>
      d
        .trim()
        .toLowerCase()
        .replace(/^\.+|\.+$/g, ""),
    )
    .filter(Boolean)
  if (names.length === 0) return undefined
  const alternatives = names.map(escapeRegExp).join("|")
  return {
    name: "private_host",
    // The domain itself or any name under it, not part of a longer name.
    pattern: new RegExp(`(?<![\\w.-])(?:[a-z0-9-]+\\.)*(?:${alternatives})(?![\\w-]|\\.[\\w-])`, "gi"),
  }
}

export type SecretScanner = {
  /** The name of the first rule the text breaks, or null when it passes. */
  find(text: string): string | null
  /** The text with every match replaced by [redacted]. For text that must not be refused (sync). */
  redact(text: string): string
}

export function createSecretScanner(privateDomains: readonly string[] = []): SecretScanner {
  const host = privateHostRule(privateDomains)
  const rules = host ? [...BASE_RULES, host] : BASE_RULES

  return {
    find(text) {
      for (const rule of rules) {
        for (const match of text.matchAll(rule.pattern)) {
          if (!rule.accept || rule.accept(match)) return rule.name
        }
      }
      return null
    },
    redact(text) {
      let out = text
      for (const rule of rules) {
        out = out.replace(rule.pattern, (...args) => {
          const match = toMatch(args)
          if (rule.accept && !rule.accept(match)) return match[0]
          if (rule.group === undefined) return REDACTED
          const value = match[rule.group] ?? ""
          const start = match[0].lastIndexOf(value)
          return `${match[0].slice(0, start)}${REDACTED}${match[0].slice(start + value.length)}`
        })
      }
      return out
    },
  }
}

/** Rebuilds a RegExpMatchArray from the arguments String.replace passes to its callback. */
function toMatch(args: unknown[]): RegExpMatchArray {
  const last = args[args.length - 1]
  const groupsAtEnd = typeof last === "object" && last !== null
  const end = args.length - (groupsAtEnd ? 3 : 2)
  return args.slice(0, end) as unknown as RegExpMatchArray
}

/** A scanner whose private domains change at run time: Settings replaces them after a save, without a restart. */
export class ReloadableSecretScanner implements SecretScanner {
  private inner: SecretScanner

  constructor(privateDomains: readonly string[] = []) {
    this.inner = createSecretScanner(privateDomains)
  }

  setPrivateDomains(privateDomains: readonly string[]): void {
    this.inner = createSecretScanner(privateDomains)
  }

  find(text: string): string | null {
    return this.inner.find(text)
  }

  redact(text: string): string {
    return this.inner.redact(text)
  }
}
