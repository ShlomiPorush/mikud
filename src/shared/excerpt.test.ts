import { describe, expect, it } from "vitest"
import { plainExcerpt } from "./excerpt.ts"

describe("plainExcerpt", () => {
  it("drops Markdown marks and keeps the words and link text", () => {
    const body =
      "## Retries\n\nA batch is retried **three times**.\n\n- Network errors `retry`.\n> Quote\n\nSee [the design](https://example.com/x)."
    expect(plainExcerpt(body)).toBe(
      "Retries A batch is retried three times. Network errors retry. Quote See the design.",
    )
  })

  it("drops table rules and code fences, and cuts at the limit", () => {
    expect(plainExcerpt("| a | b |\n| --- | --- |\n| 1 | 2 |\n```\ncode\n```")).toBe("a b 1 2 code")
    expect(plainExcerpt("x".repeat(300))).toHaveLength(240)
    expect(plainExcerpt("Set IMPORT_RETRIES to 3")).toBe("Set IMPORT_RETRIES to 3")
  })
})

describe("plainExcerpt on hostile bodies (R5)", () => {
  it("stays fast on the longest bodies of spaces, brackets and dashes", () => {
    for (const body of [
      `${" ".repeat(99_999)}x`,
      "[".repeat(100_000),
      `| ${"-".repeat(99_990)} |`,
      `${"#".repeat(50_000)} ${"(".repeat(49_000)}`,
    ]) {
      const started = performance.now()
      plainExcerpt(body)
      expect(performance.now() - started).toBeLessThan(50)
    }
  })
})
