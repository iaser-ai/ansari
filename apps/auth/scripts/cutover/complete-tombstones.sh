#!/usr/bin/env bash
# Completes deletions whose auth-side step did not finish (an apps/auth failure
# during DELETE /v2/users/me): lists the pending tombstones in the app
# database (04a), deletes those users directly in the auth database (04b; the
# cascade removes their sessions and accounts), and marks them done (04c).
# It never calls the delete endpoint. Ids only. Runs where copy.sh runs: the
# owner's machine over the Tailscale route, checked by operator-env.sh.
set -euo pipefail
set +o history 2>/dev/null || true

die() { echo "complete-tombstones.sh: $*" >&2; exit 2; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=operator-env.sh
. "$here/operator-env.sh"
operator_check complete-tombstones.sh
ids="$(psql "$APP_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -f "$here/04-tombstones-pending-app.sql")"
echo "complete-tombstones.sh: pending $ids"
[ "$ids" != "{}" ] || { echo "complete-tombstones.sh: nothing pending"; exit 0; }
psql "$AUTH_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -v ids="$ids" -f "$here/04-tombstones-delete-auth.sql"
psql "$APP_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -v ids="$ids" -f "$here/04-tombstones-mark-app.sql"
echo "complete-tombstones.sh: done"
