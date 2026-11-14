#!/usr/bin/env bash
# Tests for scripts/try-pr.sh without Docker: the address the pull request stack is served on, what its
# generated Compose and proxy files publish and pass on, the origin its seed uses, and what status says about
# an unfinished or older stack. The script is sourced with its cache directory in a temporary directory.
# Run with the guards (scripts/lib/guards.sh).
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/adiutor-try-pr-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
FAILED=0
PASSED=0

check() {
  local what="$1"
  shift
  if "$@"; then
    PASSED=$((PASSED + 1))
  else
    FAILED=$((FAILED + 1))
    echo "FAIL: $what"
  fi
}

# Every path try-pr.sh writes derives from XDG_CACHE_HOME, set before it is sourced.
export XDG_CACHE_HOME="$WORK/cache"
# shellcheck source=scripts/try-pr.sh
source "$REPO/scripts/try-pr.sh"
set +e

inside_work() {
  local path
  for path in "$CACHE_DIR" "$STATE_DIR" "$STATE_FILE" "$ENV_FILE" "$OWNER_FILE" "$COMPOSE_FILE" "$PROXY_CONF" \
    "$DATA_DIR" "$WORKTREE"; do
    [[ "$path" == "$WORK"/* ]] || {
      echo "      $path is outside $WORK"
      return 1
    }
  done
}
check "every path try-pr.sh writes is inside the test's directory" inside_work
[ "$FAILED" -eq 0 ] || {
  echo "try-pr.sh tests: stopped before writing anything"
  exit 1
}

mkdir -p "$STATE_DIR"
PR=7 COMMIT=0123456789abcdef REF=refs/adiutor/try-pr/7 PORT=18091 IMAGE=adiutor:pr-7

host_of() { sed -E 's#^[a-z]+://([^/:]+).*#\1#' <<<"$1"; }
# Succeed when the text $2 holds, or lacks, the fixed string $1.
holds() { grep -qF -- "$1" <<<"$2"; }
lacks() { ! grep -qF -- "$1" <<<"$2"; }

# --- the address ---

(write_env) || echo "      write_env failed"
public_url="$(sed -n 's/^ADIUTOR_PUBLIC_URL=//p' "$ENV_FILE")"
dev_default="$(grep -oE 'ADIUTOR_PUBLIC_URL:-https?://[^:}/]+' "$REPO/docker/docker-compose-dev.example.yml" | sed 's/.*:-//')"
check "the development stack's default address is found" test -n "$dev_default"
check "the pull request stack is served on its own host name" test "$public_url" = "http://$PR_HOST:$PORT"
check "its host differs from the development stack's default host" \
  test "$(host_of "$public_url")" != "$(host_of "$dev_default")"

seed_origin() {
  build_toolchain() { :; }
  in_toolchain() {
    printf '%s\n' "${TOOLCHAIN_EXTRA_ARGS[@]}" >"$WORK/seed-args"
    : >"$OWNER_FILE"
  }
  seed >/dev/null
  grep -qx "ADIUTOR_ORIGIN=$public_url" "$WORK/seed-args"
}
check "the seed's origin is the public address" seed_origin

# --- what is published and passed on ---

(write_compose) || echo "      write_compose failed"
# Prints the lines of one top-level service of the generated Compose file.
service() { awk -v name="  $1:" '$0 == name { on = 1; next } /^  [a-z]+:$/ { on = 0 } on' "$COMPOSE_FILE"; }
check "the pull request's server publishes no port" lacks "ports:" "$(service adiutor)"
check "only the proxy publishes a port, on 127.0.0.1" \
  test "$(grep -c '^      - "127.0.0.1:' "$COMPOSE_FILE")" = 1 -a -n "$(service proxy | grep -Fx "      - \"127.0.0.1:$PORT:8080\"")"
check "the proxy is healthy only when it serves the pull request's host" holds "\"Host: $PR_HOST\"" "$(service proxy)"
check "the proxy has a read-only root" holds "    read_only: true" "$(service proxy)"
check "the proxy holds no capabilities" holds "      - ALL" "$(service proxy)"
check "the proxy runs as UID 101" holds '    user: "101:101"' "$(service proxy)"

(write_proxy_conf) || echo "      write_proxy_conf failed"
check "any other host gets 421" grep -Pzq 'listen 8080 default_server;\n\s*return 421;' "$PROXY_CONF"
check "the proxy passes on its own host name only" \
  test "$(grep -E '^\s*server_name ' "$PROXY_CONF" | tr -s ' ')" = " server_name $PR_HOST;"
check "the proxy configuration is readable by nginx's user" test "$(stat -c %a "$PROXY_CONF")" = 644

# --- status ---

status_out() { (status 2>&1) || true; }

rm -f "$ENV_FILE" "$COMPOSE_FILE" "$PROXY_CONF"
save_state
out="$(status_out)"
check "status of an unfinished start asks for restore" grep -q "setup did not finish" <<<"$out"
check "status of an unfinished start shows no address" lacks "http://" "$out"

(write_env)
out="$(status_out)"
check "status before the stack was written shows the address" grep -qF "on $public_url" <<<"$out"
check "status before the stack was written does not call it older" lacks "older" "$out"

sed -i "s#^ADIUTOR_PUBLIC_URL=.*#ADIUTOR_PUBLIC_URL=http://127.0.0.1:$PORT#" "$ENV_FILE"
out="$(status_out)"
check "status of a stack started by an older try-pr.sh shows where it runs" grep -qF "on http://127.0.0.1:$PORT" <<<"$out"
check "status of a stack started by an older try-pr.sh says to restore and run again" \
  grep -qF "older try-pr.sh; to serve it on $public_url" <<<"$out"

echo "try-pr.sh tests: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
