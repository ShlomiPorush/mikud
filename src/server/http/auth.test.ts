import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { type Context, Hono } from "hono"
import { describe, expect, it } from "vitest"
import { clientAddress, RateLimiter } from "./auth.ts"

describe("RateLimiter", () => {
  it("blocks after the maximum failures in the window and forgets them after it", () => {
    let now = 0
    const limiter = new RateLimiter(3, 60_000, () => now)
    for (let i = 0; i < 3; i++) {
      expect(limiter.blocked("a")).toBe(false)
      limiter.fail("a")
    }
    expect(limiter.blocked("a")).toBe(true)
    expect(limiter.blocked("b")).toBe(false)
    now = 60_000
    expect(limiter.blocked("a")).toBe(false)
  })
})

describe("clientAddress", () => {
  const PROXY = "192.0.2.10"
  /** The address clientAddress gives a request from `peer` with the given X-Forwarded-For. */
  async function keyOf(trustedProxies: string[], peer: string, forwardedFor?: string): Promise<string> {
    const address = clientAddress(trustedProxies, (c: Context) => c.req.header("x-test-peer") ?? "")
    const app = new Hono().get("/", (c) => c.text(address(c)))
    const headers: Record<string, string> = { "x-test-peer": peer }
    if (forwardedFor !== undefined) headers["x-forwarded-for"] = forwardedFor
    return (await app.request("/", { headers })).text()
  }

  it("is the socket peer without trusted proxies, whatever X-Forwarded-For says", async () => {
    expect(await keyOf([], PROXY, "203.0.113.5")).toBe(PROXY)
  })

  it("ignores X-Forwarded-For from a peer that is not a trusted proxy", async () => {
    expect(await keyOf(["192.0.2.0/24"], "198.51.100.20", "203.0.113.5")).toBe("198.51.100.20")
    expect(await keyOf(["192.0.2.0/24"], "198.51.100.20", "203.0.113.6")).toBe("198.51.100.20")
  })

  it("takes the first untrusted hop from the right behind a trusted proxy", async () => {
    expect(await keyOf(["192.0.2.0/24"], PROXY, "203.0.113.5")).toBe("203.0.113.5")
    expect(await keyOf(["192.0.2.0/24"], PROXY, "203.0.113.6")).toBe("203.0.113.6")
    // A client's own leftmost entry does not choose the key.
    expect(await keyOf(["192.0.2.0/24"], PROXY, "198.51.100.9, 203.0.113.5, 192.0.2.11")).toBe("203.0.113.5")
  })

  it("is the trusted proxy itself when it sends no X-Forwarded-For", async () => {
    expect(await keyOf(["192.0.2.0/24"], PROXY)).toBe(PROXY)
  })

  it("trusts an IPv4-mapped peer by its IPv4 address, as Better Auth reads the entry", async () => {
    expect(await keyOf(["192.0.2.0/24"], `::ffff:${PROXY}`, "203.0.113.5")).toBe("203.0.113.5")
    // Better Auth reads an IPv4-mapped entry as an IPv4 address, so /32 trusts that one address only.
    expect(await keyOf(["::ffff:192.0.2.5/32"], "::ffff:192.0.2.99", "203.0.113.5")).toBe("::ffff:192.0.2.99")
    expect(await keyOf(["::ffff:192.0.2.5/32"], "192.0.2.5", "203.0.113.5")).toBe("203.0.113.5")
  })

  it("skips an entry Better Auth cannot read, without failing", async () => {
    expect(await keyOf(["1.2.3.4/99"], "1.2.3.4", "203.0.113.5")).toBe("1.2.3.4")
    expect(await keyOf(["1.2.3.4/99", "192.0.2.0/24"], PROXY, "203.0.113.5")).toBe("203.0.113.5")
  })

  it("keys IPv6 clients by their /64, as Better Auth does", async () => {
    const one = await keyOf(["192.0.2.0/24"], PROXY, "2001:db8:0:1::1")
    expect(await keyOf(["192.0.2.0/24"], PROXY, "2001:DB8:0:1::2")).toBe(one)
    expect(await keyOf(["192.0.2.0/24"], PROXY, "2001:db8:0:2::1")).not.toBe(one)
  })

  it("never takes a forged value from a header Better Auth cannot read", async () => {
    const unreadable = await keyOf(["192.0.2.0/24"], PROXY, "not-an-address")
    expect(unreadable).not.toBe("not-an-address")
    expect(await keyOf(["192.0.2.0/24"], PROXY, "203.0.113.5, not-an-address")).toBe(unreadable)
  })

  // Better Auth answers 127.0.0.1 instead of null for an unreadable header under NODE_ENV test, and reads NODE_ENV
  // when it loads; production's answer (the peer) needs a process that starts in production mode.
  it("falls back to the peer for an unreadable header in production", async () => {
    const harness = `
      import { Hono } from "hono"
      import { clientAddress } from "./auth.ts"
      const address = clientAddress(["192.0.2.0/24"], (c) => c.req.header("x-test-peer") ?? "")
      const app = new Hono().get("/", (c) => c.text(address(c)))
      const keys = []
      for (const [peer, forwardedFor] of [
        ["192.0.2.10", "not-an-address"],
        ["192.0.2.10", "203.0.113.5"],
        ["192.0.2.10", undefined],
        ["198.51.100.20", "203.0.113.5"],
        ["unknown", "203.0.113.5"],
      ]) {
        const headers = { "x-test-peer": peer, ...(forwardedFor ? { "x-forwarded-for": forwardedFor } : {}) }
        keys.push(await (await app.request("/", { headers })).text())
      }
      console.log(JSON.stringify(keys))
    `
    const bundle = await build({
      stdin: { contents: harness, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts" },
      bundle: true,
      platform: "node",
      format: "esm",
      write: false,
      logLevel: "silent",
    })
    const { TEST: _test, VITEST: _vitest, ...env } = process.env
    const run = spawnSync(process.execPath, ["--input-type=module"], {
      input: bundle.outputFiles[0]?.text,
      env: { ...env, NODE_ENV: "production" },
      encoding: "utf8",
    })
    expect(run.stderr).toBe("")
    expect(JSON.parse(run.stdout)).toEqual(["192.0.2.10", "203.0.113.5", "192.0.2.10", "198.51.100.20", "unknown"])
  }, 30_000)
})
