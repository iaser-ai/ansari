# The operator-environment check for the cutover scripts (spec 300 amendment
# H-8): sourced by copy.sh and complete-tombstones.sh, which run on the
# owner's machine over the owner's Tailscale route to Railway's private
# network. It replaces the old auth-image marker. It refuses, before any
# database is touched:
#
#   1. a missing or empty APP_DATABASE_URL / AUTH_DATABASE_URL, or both the same;
#   2. a database host that is not Railway-internal (`<name>.railway.internal`,
#      reached over the Tailscale route): Railway's public TCP proxy
#      (`*.proxy.rlwy.net`) and every other host are refused;
#   3. a psql that is not major 18 (the production major);
#   4. a checkout that is not clean, or whose HEAD is not PROMOTED_COMMIT, the
#      commit the window recorded: the scripts and SQL run from this tree;
#   5. stdout that is not a terminal, so the output (counts and checksums
#      only) cannot be captured to a file by accident.
#
# It prints a warning when a URL does not carry sslmode=require (runbook step
# 1 records whether TLS is offered on the Tailscale path). Ids only; it never
# prints a URL.
#
# Usage: operator_check <script name>   (dies with exit 2 on the first refusal)

operator_die() { echo "$1: $2" >&2; exit 2; }

# The host of a postgres URL: scheme://[user[:password]@]host[:port][/db][?params].
operator_url_host() {
  local rest="${1#*://}"
  rest="${rest##*@}"
  rest="${rest%%[/?]*}"
  if [[ "$rest" == \[* ]]; then
    rest="${rest%%]*}"
    echo "${rest#[}"
  else
    echo "${rest%%:*}"
  fi
}

# 0 when the host is Railway-internal, 1 otherwise. Lower-cased; a trailing dot is allowed.
operator_host_allowed() {
  local host
  host="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  host="${host%.}"
  [[ "$host" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?\.railway\.internal$ ]]
}

operator_check() {
  local name="$1"
  [ -n "${APP_DATABASE_URL:-}" ] || operator_die "$name" "APP_DATABASE_URL is unset"
  [ -n "${AUTH_DATABASE_URL:-}" ] || operator_die "$name" "AUTH_DATABASE_URL is unset"
  [ "$APP_DATABASE_URL" != "$AUTH_DATABASE_URL" ] \
    || operator_die "$name" "APP_DATABASE_URL and AUTH_DATABASE_URL are the same database"

  local var host
  for var in APP_DATABASE_URL AUTH_DATABASE_URL; do
    host="$(operator_url_host "${!var}")"
    case "$host" in
      *.proxy.rlwy.net | *.proxy.rlwy.net.)
        operator_die "$name" "$var points at Railway's public TCP proxy; use the <name>.railway.internal host over the Tailscale route" ;;
    esac
    operator_host_allowed "$host" \
      || operator_die "$name" "$var's host is not Railway-internal (<name>.railway.internal over the Tailscale route)"
  done

  command -v psql >/dev/null 2>&1 || operator_die "$name" "psql is not on PATH (install the PostgreSQL 18 client)"
  local version major
  version="$(psql --version 2>/dev/null || true)"
  major="$(printf '%s' "$version" | sed -nE 's/^psql \(PostgreSQL\) ([0-9]+).*/\1/p')"
  [ "$major" = "18" ] || operator_die "$name" "psql must be major 18 (found: ${version:-none})"

  local here repo
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  repo="$(git -C "$here" rev-parse --show-toplevel 2>/dev/null)" \
    || operator_die "$name" "not inside a git checkout"
  [ -n "${PROMOTED_COMMIT:-}" ] || operator_die "$name" "PROMOTED_COMMIT is unset (the commit the window recorded)"
  [ -z "$(git -C "$repo" status --porcelain)" ] || operator_die "$name" "the checkout has uncommitted changes"
  [ "$(git -C "$repo" rev-parse HEAD)" = "$(git -C "$repo" rev-parse --verify --quiet "$PROMOTED_COMMIT^{commit}")" ] \
    || operator_die "$name" "HEAD is not PROMOTED_COMMIT"

  [ -t 1 ] || operator_die "$name" "refusing to run with stdout redirected: run it in the terminal, and read its counts there"

  for var in APP_DATABASE_URL AUTH_DATABASE_URL; do
    case "${!var}" in
      *sslmode=require* | *sslmode=verify-ca* | *sslmode=verify-full*) ;;
      *) echo "$name: WARNING: $var carries no sslmode=require (runbook step 1 records whether TLS is offered on this path)" >&2 ;;
    esac
  done
}
