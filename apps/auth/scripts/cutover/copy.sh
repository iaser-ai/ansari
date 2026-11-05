#!/usr/bin/env bash
# The cutover copy (docs/cutover/better-auth-cutover.md, step 6): app database
# → auth database, then the cross-database audit.
#
# Run on the owner's machine, through Railway's Tailscale forwarder to the
# databases' private hosts (spec 300 amendment H-8), from the promoted commit's clean
# checkout; operator-env.sh refuses anything else. APP_DATABASE_URL and
# AUTH_DATABASE_URL are entered for this session only (`read -rs`): never set
# on a service, never written to a file. This script writes no file either:
# 01's rows go through a pipe into 02's session, whose import table is TEMP, so
# the emails and hashes pass through this machine's memory and nowhere else.
#
# Prints counts and checksums only. Exits non-zero on any failure or audit
# difference; the runbook's next step (the app window migration) runs only
# after a clean exit.
#
# `--dry-run` runs the same copy, guards and audits, and commits nothing: 02's
# transaction ends in ROLLBACK after printing the auth-side audit from inside
# it. Against an auth database with no schema yet (the window before step 5),
# the WHOLE auth journal, in _journal.json order (auth-journal.mjs), is applied
# inside that transaction too, so the dry run proves the copy against the
# schema production will have, and the database is left as found; the script
# checks that it was. The journal SQL reaches psql through a file descriptor,
# so this still writes no file. The rows still stream through
# this machine, so every operator-environment check still applies.
#
# Usage: copy.sh [--dry-run] [--allow-local]
set -euo pipefail
set +o history 2>/dev/null || true

die() { echo "copy.sh: $*" >&2; exit 2; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=operator-env.sh
. "$here/operator-env.sh"
dry_run=0
args=()
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=1 ;;
    *) args+=("$arg") ;;
  esac
done
operator_check copy.sh ${args[@]+"${args[@]}"}

psql_app() { psql "$APP_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 "$@"; }
psql_auth() { psql "$AUTH_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 "$@"; }

expected="$(psql_app -At -f "$here/01-count-app.sql")"
[[ "$expected" =~ ^[0-9]+$ ]] || die "could not count the rows to copy"

if [ "$dry_run" = 1 ]; then
  echo "copy.sh: DRY RUN: the copy runs in one transaction and is rolled back; nothing is committed" >&2
  # The auth database as found: with the baseline (auth.users exists) or with no
  # schema at all (before step 5). Anything in between is the guards' to refuse.
  baseline_vars=()
  no_schema="$(psql_auth -At -c "select to_regclass('auth.users') is null")"
  if [ "$no_schema" = "t" ]; then
    echo "copy.sh: DRY RUN: the auth database has no schema; the whole auth journal (_journal.json order) is applied inside the transaction and rolled back with it" >&2
    # Read the journal once here so an unreadable one stops the run before any pipe.
    node "$here/auth-journal.mjs" files >/dev/null || die "the auth journal could not be read"
    exec 9< <(node "$here/auth-journal.mjs" sql)
    baseline_vars=(-v dry_run_baseline=/dev/fd/9)
  fi
  echo "copy.sh: dry run: copying $expected non-system user(s) (app → auth)"
  auth_audit="$(psql_app -f "$here/01-export-app.sql" \
    | psql_auth -v expected_rows="$expected" -v dry_run=1 ${baseline_vars[@]+"${baseline_vars[@]}"} -f "$here/02-import-auth.sql")"
  if [ "${#baseline_vars[@]}" -gt 0 ]; then
    exec 9<&-
    left="$(psql_auth -At -c "select count(*) from information_schema.schemata where schema_name = 'auth'")"
  else
    left="$(psql_auth -At -c "select (select count(*) from auth.users) + (select count(*) from auth.account)")"
  fi
  [ "$left" = "0" ] || die "DRY RUN LEFT CHANGES in the auth database (expected 0, found $left); stop and investigate"
  echo "copy.sh: dry run: rolled back; the auth database is as it was"
  echo "copy.sh: auditing"
  app_audit="$(psql_app -f "$here/03-audit-app.sql")"
else
  echo "copy.sh: copying $expected non-system user(s) (app → auth)"
  psql_app -f "$here/01-export-app.sql" | psql_auth -v expected_rows="$expected" -f "$here/02-import-auth.sql"
  echo "copy.sh: auditing"
  app_audit="$(psql_app -f "$here/03-audit-app.sql")"
  auth_audit="$(psql_auth -f "$here/03-audit-auth.sql")"
fi

echo "-- app"
echo "$app_audit"
echo "-- auth"
echo "$auth_audit"
if [ "$app_audit" != "$auth_audit" ]; then
  if [ "$dry_run" = 1 ]; then
    echo "copy.sh: DRY RUN AUDIT MISMATCH — the real copy would fail its audit here; nothing was committed" >&2
  else
    echo "copy.sh: AUDIT MISMATCH — do NOT run the app window migration; empty the auth database and start again from the auth journal (step 5)" >&2
  fi
  diff <(echo "$app_audit") <(echo "$auth_audit") >&2 || true
  exit 1
fi
if [ "$dry_run" = 1 ]; then
  echo "copy.sh: dry run audit OK (nothing committed)"
else
  echo "copy.sh: audit OK"
fi
