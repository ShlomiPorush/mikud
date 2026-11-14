#!/usr/bin/env bash
# Repository guards. scripts/verify.sh runs this inside the toolchain container; run it there, not on
# the host. Checks tracked files and new files that are not ignored, so a violation fails before commit.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
# grep -P reads \x{...} code points only in a UTF-8 locale; in C or POSIX it fails on the Hebrew range.
export LC_ALL=C.UTF-8

fail=0
files=()
while IFS= read -r -d '' file; do
  [ -f "$file" ] && files+=("$file")
done < <(git ls-files -z -co --exclude-standard)

hebrew_files=()
ip_files=()
for file in "${files[@]}"; do
  [ "$file" = src/shared/locales/he.json ] || hebrew_files+=("$file")
  # pnpm-lock.yaml and the generated Drizzle snapshots are left out of the IPv4 guard: they are
  # machine-written, hold version strings and hashes only, and are reviewed through their sources.
  [[ "$file" == pnpm-lock.yaml || "$file" == drizzle/meta/* ]] || ip_files+=("$file")
done

# Runs grep with the given arguments (ending with -- and the files) and prints file:line[:match].
# No match is fine; a grep error (exit 2) stops the guards, so a broken pattern never passes silently.
search() {
  local rc=0
  grep -HIn "$@" || rc=$?
  if [ "$rc" -gt 1 ]; then
    echo "error: grep failed (exit $rc)" >&2
    exit 2
  fi
}

# Prints file:line, and what matched only outside CI: CI logs of a public repository must not repeat it.
report() {
  local what="$1" file line match
  while IFS=: read -r file line match; do
    if [ -n "${CI:-}" ]; then
      echo "  $file:$line"
    else
      echo "  $file:$line: ${what:-$match}"
    fi
  done
}

echo "--- Hebrew only in src/shared/locales/he.json"
hebrew="$(search -l -P '[\x{0590}-\x{05FF}\x{FB1D}-\x{FB4F}]' -- "${hebrew_files[@]}")"
if [ -n "$hebrew" ]; then
  echo "Hebrew text is allowed only in src/shared/locales/he.json:"
  while IFS= read -r file; do echo "  $file"; done <<<"$hebrew"
  fail=1
fi

echo "--- IPv4 addresses only from loopback, 0.0.0.0 and the documentation ranges"
# Four dot-separated numbers inside a longer dotted run (1.2.3.4.5) are not an address.
ips="$(search -o -P '(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?!\.?\d)' -- "${ip_files[@]}" |
  awk -F: '{
    n = split($NF, o, ".")
    for (i = 1; i <= n; i++) if (o[i] + 0 > 255) next
    if ($NF == "127.0.0.1" || $NF == "0.0.0.0") next
    if ($NF ~ /^(192\.0\.2|198\.51\.100|203\.0\.113)\./) next
    print
  }')"
if [ -n "$ips" ]; then
  echo "IP addresses are not allowed in the repository (use 192.0.2.x, 198.51.100.x or 203.0.113.x in examples):"
  report "" <<<"$ips"
  fail=1
fi

echo "--- Environment files only as examples, with no secret values"
# The repository holds no value a stack runs on, not even a "fake" or "dev-only" one: stacks generate theirs.
env_examples=()
for file in "${files[@]}"; do
  case "${file##*/}" in
    .env.example | *.env.example) env_examples+=("$file") ;;
    *.example) ;;
    .env | .env.* | *.env)
      echo "  $file: an environment file; keep only an example (<name>.example) with empty values"
      fail=1
      ;;
  esac
done
if [ ${#env_examples[@]} -gt 0 ]; then
  secret_values="$(search -E \
    '^[[:space:]]*(export[[:space:]]+)?(DATABASE_URL|POSTGRES_PASSWORD|[A-Z0-9_]*_(SECRET|SECRETS|KEYS|TOKEN))[[:space:]]*=[[:space:]]*[^[:space:]#]' \
    -- "${env_examples[@]}")"
  if [ -n "$secret_values" ]; then
    echo "Example environment files must leave secrets and connection strings empty:"
    report "a value" <<<"$secret_values"
    fail=1
  fi
fi

echo "--- No build: in the Compose files"
compose_files=(docker-compose.yml docker/docker-compose-dev.example.yml)
[ -f docker-compose-dev.yml ] && compose_files+=(docker-compose-dev.yml)
if grep -nE '^[[:space:]]*build[[:space:]]*:' "${compose_files[@]}"; then
  echo "Compose files must not contain build:. Images are built by the scripts."
  fail=1
fi

echo "--- Local deny list"
deny=docs/private/deny-list.txt
if [ -f "$deny" ]; then
  while IFS= read -r term || [ -n "$term" ]; do
    term="${term%$'\r'}"
    term="${term#"${term%%[![:space:]]*}"}"
    term="${term%"${term##*[![:space:]]}"}"
    [ -z "$term" ] || [[ "$term" == \#* ]] && continue
    hits="$(search -i -w -F -e "$term" -- "${files[@]}")"
    if [ -n "$hits" ]; then
      echo "A term from $deny appears in the repository:"
      report "$term" <<<"$hits"
      fail=1
    fi
  done <"$deny"
else
  echo "  $deny not found; skipped (it exists only on the owner's machine)"
fi

echo "--- Locale files have the same keys"
node -e '
  const fs = require("node:fs")
  const keys = (v, p = "") => (typeof v === "object" && v !== null)
    ? Object.entries(v).flatMap(([k, x]) => keys(x, p ? p + "." + k : k)) : [p]
  const [a, b] = process.argv.slice(1).map((f) => new Set(keys(JSON.parse(fs.readFileSync(f, "utf8")))))
  const missing = (x, y, name) => [...x].filter((k) => !y.has(k)).map((k) => "  missing in " + name + ": " + k)
  const problems = [...missing(a, b, "he.json"), ...missing(b, a, "en.json")]
  if (problems.length) { console.log(problems.join("\n")); process.exit(1) }
' src/shared/locales/en.json src/shared/locales/he.json || {
  echo "en.json and he.json must have the same keys."
  fail=1
}

echo "--- The agent skill is plain ASCII English"
# Agents read skill/ as instructions: no Hebrew, no bidirectional controls, no look-alike characters.
skill_files=()
for file in "${files[@]}"; do
  [[ "$file" == skill/* ]] && skill_files+=("$file")
done
if [ ${#skill_files[@]} -gt 0 ]; then
  non_ascii="$(search -P '[^\x{0009}\x{000A}\x{000D}\x{0020}-\x{007E}]' -- "${skill_files[@]}")"
  if [ -n "$non_ascii" ]; then
    echo "Files under skill/ must hold printable ASCII only:"
    report "a character outside ASCII" <<<"$non_ascii"
    fail=1
  fi
fi

echo "--- Shell scripts"
scripts=()
for file in "${files[@]}"; do
  [[ "$file" == scripts/*.sh || "$file" == skill/adiutor/scripts/adiutor || "$file" == skill/adiutor/scripts/*.sh ]] &&
    scripts+=("$file")
done
shellcheck -x "${scripts[@]}" || fail=1
shfmt -d -i 2 -ci "${scripts[@]}" || {
  echo "Run: shfmt -w -i 2 -ci scripts skill/adiutor/scripts"
  fail=1
}
while read -r mode _ _ path; do
  [[ "$path" == scripts/lib/* ]] && continue
  [ "$mode" = 100755 ] || {
    echo "$path is not executable: git update-index --chmod=+x $path"
    fail=1
  }
done < <(git ls-files -s 'scripts/*.sh' skill/adiutor/scripts/adiutor skill/adiutor/scripts/adiutor.mjs 'skill/adiutor/scripts/*.sh')

echo "--- Release script: refusals and resume paths against a local remote"
bash scripts/test-release.sh || fail=1

echo "--- CI result script: which CI run a release reuses, against a stand-in gh"
bash scripts/test-ci-result.sh || fail=1

echo "--- Release workflow: jobs and steps on both CI paths, with and without dry_run"
bash scripts/test-release-workflow.sh || fail=1

echo "--- Pull request stack: its address, what it publishes and its status, without Docker"
bash scripts/test-try-pr.sh || fail=1

exit "$fail"
