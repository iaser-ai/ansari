#!/usr/bin/env bash
# The cutover copy (docs/cutover/better-auth-cutover.md, step 6): app database
# → auth database, then the cross-database audit.
#
# Run on the owner's machine, over the owner's Tailscale route to Railway's
# private network (spec 300 amendment H-8), from the promoted commit's clean
# checkout; operator-env.sh refuses anything else. APP_DATABASE_URL and
# AUTH_DATABASE_URL are entered for this session only (`read -rs`): never set
# on a service, never written to a file. This script writes no file either:
# 01's rows go through a pipe into 02's session, whose import table is TEMP, so
# the emails and hashes pass through this machine's memory and nowhere else.
#
# Prints counts and checksums only. Exits non-zero on any failure or audit
# difference; the runbook's next step (the app window migration) runs only
# after a clean exit.
set -euo pipefail
set +o history 2>/dev/null || true

die() { echo "copy.sh: $*" >&2; exit 2; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=operator-env.sh
. "$here/operator-env.sh"
operator_check copy.sh

psql_app() { psql "$APP_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 "$@"; }
psql_auth() { psql "$AUTH_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 "$@"; }

expected="$(psql_app -At -f "$here/01-count-app.sql")"
[[ "$expected" =~ ^[0-9]+$ ]] || die "could not count the rows to copy"
echo "copy.sh: copying $expected non-system user(s) (app → auth)"
psql_app -f "$here/01-export-app.sql" | psql_auth -v expected_rows="$expected" -f "$here/02-import-auth.sql"

echo "copy.sh: auditing"
app_audit="$(psql_app -f "$here/03-audit-app.sql")"
auth_audit="$(psql_auth -f "$here/03-audit-auth.sql")"
echo "-- app"
echo "$app_audit"
echo "-- auth"
echo "$auth_audit"
if [ "$app_audit" != "$auth_audit" ]; then
  echo "copy.sh: AUDIT MISMATCH — do NOT run the app window migration; empty the auth database and start again from the 0000 baseline" >&2
  diff <(echo "$app_audit") <(echo "$auth_audit") >&2 || true
  exit 1
fi
echo "copy.sh: audit OK"
