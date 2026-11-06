// The excerpt a notes list shows: the server answers it (docs/api.md, NoteSummary) and the mock builds it the
// same way.

/** Only the start of a body can reach the excerpt; reading no more keeps the work small for any body. */
const READ = 2_000

/** A table's rule line, such as `| --- | :---: |`: only bars, colons, dashes and spaces, with a dash run. */
const isTableRule = (line: string) => line.includes("---") && /^[\s|:-]*$/.test(line)

/** The start of a Markdown body as plain text on one line: link and image text kept, markup marks dropped. */
export function plainExcerpt(body: string, max = 240): string {
  const plain = body
    .slice(0, READ)
    .split("\n")
    .filter((line) => !isTableRule(line))
    .join("\n")
    .replace(/!?\[([^\]\n]{0,200})\]\([^)\n]{0,500}\)/g, "$1")
    .replace(/^ {0,3}(#{1,6}|>|[-*+]|\d{1,9}[.)])[ \t]+/gm, "")
    .replace(/`{3,}[^\n]*/g, "")
    .replace(/[*~`]+/g, "")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain
}
