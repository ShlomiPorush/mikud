# Shared helpers for the workflow scripts. Source it; do not execute it.
# shellcheck shell=bash

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export REPO_ROOT

TOOLCHAIN_IMAGE="adiutor-toolchain:local"
# Browsers for the end-to-end tests; the tag must match @playwright/test in package.json.
PLAYWRIGHT_IMAGE="mcr.microsoft.com/playwright:v1.65.0-noble"
export PLAYWRIGHT_IMAGE
# The oldest Node the agent skill's adiutor.mjs supports: its contract tests also run there.
SKILL_NODE_IMAGE="node:20.20.2-bookworm-slim"
export SKILL_NODE_IMAGE
# The PostgreSQL of the verification and pull-request stacks: the major version production runs, the oldest
# Adiutor supports. This image keeps its data in /var/lib/postgresql/data. The development stack keeps its own.
TEST_POSTGRES_IMAGE="postgres:16.16-bookworm"
TEST_POSTGRES_DATA="/var/lib/postgresql/data"
TEST_POSTGRES_MAJOR=16
export TEST_POSTGRES_IMAGE TEST_POSTGRES_DATA TEST_POSTGRES_MAJOR
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/adiutor"

die() {
  echo "error: $*" >&2
  exit 1
}

info() {
  echo "==> $*"
}

require_docker() {
  command -v docker >/dev/null 2>&1 || die "docker is not available. Run this inside WSL with Docker running."
  docker info >/dev/null 2>&1 || die "docker is installed but not reachable. Start Docker and try again."
}

# Builds the toolchain image (cached by Docker when nothing changed).
build_toolchain() {
  require_docker
  docker build --quiet -f "$REPO_ROOT/docker/toolchain.Dockerfile" -t "$TOOLCHAIN_IMAGE" "$REPO_ROOT/docker" >/dev/null ||
    die "building the toolchain image failed"
}

# Runs a command inside the toolchain container with the repository mounted at /repo.
in_toolchain() {
  mkdir -p "$CACHE_DIR/pnpm-store"
  local tty=()
  [ -t 1 ] && tty=(-t)
  docker run --rm "${tty[@]}" \
    --user "$(id -u):$(id -g)" \
    -v "$REPO_ROOT:/repo" \
    -v "$CACHE_DIR/pnpm-store:/pnpm-store" \
    -e npm_config_store_dir=/pnpm-store \
    -e CI="${CI:-}" \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    "${TOOLCHAIN_EXTRA_ARGS[@]}" \
    "$TOOLCHAIN_IMAGE" bash -c "$*"
}
TOOLCHAIN_EXTRA_ARGS=()

# Installs dependencies from the lockfile.
install_deps() {
  in_toolchain "pnpm install --frozen-lockfile --reporter=append-only"
}

# Builds the Adiutor image with the given tag.
build_image() {
  local tag="$1" version="${2:-$1}"
  require_docker
  info "Building adiutor:$tag"
  docker build -f "$REPO_ROOT/docker/adiutor.Dockerfile" --build-arg "VERSION=$version" -t "adiutor:$tag" "$REPO_ROOT" ||
    die "building adiutor:$tag failed"
}

# Fails when any process of a running Compose service runs as UID 0.
check_non_root() {
  local project="$1" service cid uids
  shift
  for service in "$@"; do
    cid="$(docker ps -q --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=$service")"
    [ -n "$cid" ] || die "service $service is not running"
    uids="$(docker top "$cid" -o pid,uid | awk 'NR > 1 { print $2 }' | sort -u | tr '\n' ' ')"
    [ -n "$uids" ] || die "service $service has no process"
    if grep -qw 0 <<<"$uids"; then
      die "service $service runs a process as root (UIDs: $uids)"
    fi
    echo "    $service runs as UID ${uids% }"
  done
}

# Fails unless each given service (default: adiutor) holds no capability, cannot gain privileges and has a
# read-only root.
check_hardening() {
  local project="$1" service cid
  shift
  [ $# -gt 0 ] || set -- adiutor
  for service in "$@"; do
    cid="$(docker ps -q --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=$service")"
    [ -n "$cid" ] || die "service $service is not running"
    [ "$(docker inspect -f '{{json .HostConfig.CapDrop}} {{json .HostConfig.CapAdd}}' "$cid")" = '["ALL"] null' ] ||
      die "$service holds capabilities"
    [ "$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$cid")" = true ] || die "$service has a writable root file system"
    docker inspect -f '{{range .HostConfig.SecurityOpt}}{{println .}}{{end}}' "$cid" | grep -qxE 'no-new-privileges(:true)?' ||
      die "$service may gain new privileges"
    echo "    $service holds no capabilities, read-only root, no new privileges"
  done
}

# Refuses a data directory on the Windows file system: development and test data live on Linux.
require_linux_dir() {
  local resolved
  resolved="$(realpath -m "$1")"
  case "$resolved" in
    /mnt/*) die "$resolved is on the Windows file system; set ADIUTOR_DATA_DIR to a Linux path" ;;
  esac
}

# Removes a project-owned data directory. PostgreSQL's files belong to its own UID, so the contents
# are deleted from a throwaway container.
remove_data_dir() {
  local dir="$1"
  [ -d "$dir" ] || return 0
  build_toolchain
  docker run --rm --user 0 -v "$dir:/target" "$TOOLCHAIN_IMAGE" bash -c 'shopt -s dotglob; rm -rf /target/*' ||
    die "could not empty $dir"
  rmdir "$dir"
}

# Refuses a data directory inside the repository: a stack's database and keys must never be committable.
require_outside_repo() {
  local resolved
  resolved="$(realpath -m "$1")"
  case "$resolved/" in
    "$REPO_ROOT"/*) die "$resolved is inside the repository; set ADIUTOR_DATA_DIR to a path outside it" ;;
  esac
}

# --- Stack secrets ---
# The development and verification stacks' database password and keys are generated on this machine into
# <data dir>/stack.env (0600), next to the database they open. The repository holds none of them.
STACK_ENV_NAMES=(POSTGRES_USER POSTGRES_DB POSTGRES_PASSWORD DATABASE_URL ADIUTOR_AUTH_SECRETS ADIUTOR_SETTINGS_KEYS)

random_hex() {
  od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
}

# A regular file, mode 600, with a non-empty value for every name.
stack_env_valid() {
  local file="$1" name
  if [ ! -f "$file" ] || [ -L "$file" ]; then return 1; fi
  [ "$(stat -c %a "$file")" = 600 ] || return 1
  for name in "${STACK_ENV_NAMES[@]}"; do
    grep -qE "^$name=.+" "$file" || return 1
  done
}

# Creates <data dir>/stack.env once, before PostgreSQL first starts, and never rewrites it. A database without
# its file is refused: new keys would not open it.
ensure_stack_env() {
  local dir="$1" file="$1/stack.env" tmp contents password
  require_linux_dir "$dir"
  require_outside_repo "$dir"
  mkdir -p "$dir/postgres"
  chmod 700 "$dir"
  if [ ! -e "$file" ]; then
    contents="$(ls -A "$dir/postgres")" || die "cannot read $dir/postgres; no keys were created"
    [ -z "$contents" ] || die "$dir/postgres holds a database, but its password and keys are not in $file.
  Restore that file, or start over with: scripts/local.sh nuke"
    password="$(random_hex)"
    tmp="$(mktemp "$dir/.stack.env.XXXXXX")"
    cat >"$tmp" <<EOF
# Generated by scripts/lib/common.sh for the stack whose database is in this directory. Never commit or copy it.
POSTGRES_USER=adiutor
POSTGRES_DB=adiutor
POSTGRES_PASSWORD=$password
DATABASE_URL=postgres://adiutor:$password@postgres:5432/adiutor
ADIUTOR_AUTH_SECRETS=1:$(random_hex)
ADIUTOR_SETTINGS_KEYS=1:$(random_hex)
EOF
    chmod 600 "$tmp"
    stack_env_valid "$tmp" || {
      rm -f "$tmp"
      die "could not write $file"
    }
    # ln fails when the file exists, so a run that started at the same time keeps the values it published.
    ln "$tmp" "$file" 2>/dev/null || true
    rm -f "$tmp"
  fi
  stack_env_valid "$file" || die "$file is incomplete or not mode 600. Fix or restore it; new keys would not open the database"
}

# The stack's database password, for test connection strings.
stack_db_password() {
  sed -n 's/^POSTGRES_PASSWORD=//p' "$1/stack.env"
}

# --- Development stack ---
DEV_PROJECT="adiutor-dev"
DEV_COMPOSE_FILE="$REPO_ROOT/docker-compose-dev.yml"
DEV_DEFAULT_DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/adiutor-dev"

# The developer's .env.dev (or ADIUTOR_LOCAL_ENV_FILE) is both the service's last env_file and the file Compose
# interpolates from, so ADIUTOR_PORT and ADIUTOR_PUBLIC_URL set there reach the template. Never printed.
dev_compose() {
  [ -f "$DEV_COMPOSE_FILE" ] || die "docker-compose-dev.yml is missing. Create it with:
  cp docker/docker-compose-dev.example.yml docker-compose-dev.yml"
  grep -q ADIUTOR_STACK_ENV_FILE "$DEV_COMPOSE_FILE" || die "docker-compose-dev.yml is an older copy. Copy it again:
  cp docker/docker-compose-dev.example.yml docker-compose-dev.yml"
  local data_dir="${ADIUTOR_DATA_DIR:-$DEV_DEFAULT_DATA_DIR}"
  local local_env="${ADIUTOR_LOCAL_ENV_FILE:-$REPO_ROOT/.env.dev}" interpolation=/dev/null
  [ -f "$local_env" ] && interpolation="$local_env"
  env -u COMPOSE_ENV_FILES -u ADIUTOR_POSTGRES_IMAGE -u ADIUTOR_POSTGRES_DATA \
    ADIUTOR_DATA_DIR="$data_dir" ADIUTOR_IMAGE_TAG=dev ADIUTOR_STACK_ENV_FILE="$data_dir/stack.env" \
    ADIUTOR_LOCAL_ENV_FILE="$local_env" \
    docker compose --env-file "$interpolation" -p "$DEV_PROJECT" --project-directory "$REPO_ROOT" -f "$DEV_COMPOSE_FILE" "$@"
}
