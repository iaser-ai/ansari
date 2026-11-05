# Cutover scripts (spec 300)

The operator SQL and shell for the Better Auth cutover window. The order, the
checks and the abort actions are in the runbook,
[`docs/cutover/better-auth-cutover.md`](../../../../docs/cutover/better-auth-cutover.md);
rollback is in [`docs/cutover/rollback.md`](../../../../docs/cutover/rollback.md). This
file says what each piece is.

**Where they run (spec 300 amendment H-8).** On **the owner's machine**, over the owner's
Railway's Tailscale forwarder (a service on the owner's tailnet that relays a port to each
database's private host; the runbook's operator environment). The auth image carries no Postgres client. `copy.sh` and
`complete-tombstones.sh` source `operator-env.sh`, which refuses, before any database call:
- a missing, empty or identical `APP_DATABASE_URL` / `AUTH_DATABASE_URL`;
- a `CUTOVER_ENV` that is not `production` or `staging` (set at runbook step 1, read back aloud);
- a host that is not that environment's forwarder, `<project>-$CUTOVER_ENV-tailscale-forwarder`
  (optionally `-<n>` and `.<tailnet>.ts.net`), or two URLs naming different hosts (one forwarder
  serves the app database on 5432 and the auth database on 5433): Railway's public TCP proxy
  (`*.proxy.rlwy.net`), `<name>.railway.internal` (it resolves only inside Railway), IPs, the
  other environment's forwarder and every other host are refused;
- a `psql` that is not major 18;
- stdout that is not a terminal.

It warns when a URL carries no `sslmode=require`; the runbook records whether TLS is offered on
the path. `rehearsal-anomalies.ts` makes the same host check, and also needs
`CUTOVER_ENV=staging` and staging's forwarder (`<project>-staging-tailscale-forwarder`).
`--allow-local` needs no `CUTOVER_ENV`.

**Local end-to-end testing only: `--allow-local`.** `copy.sh --allow-local` and
`complete-tombstones.sh --allow-local` replace the host check with a stricter one: **both** hosts
must be loopback (`localhost`, `127.0.0.1`, `::1`). Loopback is not the same as local: an SSH
tunnel or port-forward on loopback (`railway connect`, `ssh -L`, a Tailscale forward) would make
`localhost` reach a Railway database, so **never run `--allow-local` while any tunnel or
port-forward to a Railway database is open**. It is for throwaway local clusters. Every other
check still runs (psql 18, a terminal), and the run prints `LOCAL TEST RUN` on stderr. Any other argument
is refused. Never pass it in the window.

Both URLs are entered with `read -rs` for the session only: never set on a Railway service,
never added to `turbo.json`, never written to a file. The copy's rows pass through this
machine's memory in a pipe and nowhere else. The source scans exclude this directory by path,
because it is the one place both databases are named.

**Dry run: `copy.sh --dry-run`.** The same copy, guards and audits, with nothing committed:
`02`'s transaction ends in `ROLLBACK` after printing the auth-side audit from inside it (another
session cannot see uncommitted rows). If the auth database has no schema yet (staging and
production before runbook step 5), the **whole auth journal**, in `_journal.json` order
(`auth-journal.mjs sql`: every migration, then an assertion that each one is present), is applied
inside the same transaction and rolled back with it, so the dry run proves the copy against the
schema production will have, and step 1's empty-database check still holds afterwards. The SQL
reaches `psql` through a file descriptor `copy.sh` holds open, so no file is written. The script then
checks that the auth database is as it was (no `auth` schema, or zero users and accounts) and
ends with `copy.sh: dry run audit OK (nothing committed)`. Every operator-environment check still
runs, because every email and hash still streams through this machine. So a dry run against
staging or production is never casual: it runs only under the full operator checks and runbook
step 1's hygiene checklist, in the same session discipline as the real copy. It combines with
`--allow-local`, in either order. Its timing is a fair preview of step 6's.

**What they print.** Ids, counts and md5 checksums. Never a password hash. The preflight
also prints the legacy admins' addresses, because the owner approves that list by address.

| File | Database | Writes | What it does |
|---|---|---|---|
| `00-preflight-app.sql` | app | no | Case audit and collision groups over all rows (ids only), rows with no hash, hash formats (prefix, length and count; never a hash) and rows not bcrypt `$2a$`/`$2b$` of length 60 (must be zero), NULL timestamps (must be zero), guest count, legacy admin inventory, system accounts, rows to copy, baselines B-1 and B-4 |
| `01-export-app.sql` | app | no | `\copy (…non-system users, email normalized…) TO pstdout`. **Never run by hand:** `copy.sh` pipes it into `02`, so its rows (emails and hashes) never reach a terminal or a file |
| `01-count-app.sql` | app | no | The number of rows `01` exports (its filter); `copy.sh` passes it to `02` as `expected_rows` |
| `02-import-auth.sql` | auth | yes, one transaction (none under `--dry-run`) | A `TEMP` import table filled from `pstdin`; guards (empty `auth.users` and `auth.account`, non-empty import, exactly `expected_rows` rows (from `01-count-app.sql`, passed by `copy.sh`), no normalized-email collision, normalized emails, every row has a hash, every hash is bcrypt `$2a$`/`$2b$` of length 60, no NULL timestamp, no system-domain address); the `auth.users` and credential `auth.account` inserts; `COMMIT`. Under `copy.sh --dry-run` (`-v dry_run=1`): the auth audit from inside the transaction, then `ROLLBACK`; with `-v dry_run_baseline=1` it first applies `packages/auth/drizzle/0000` inside that transaction |
| `03-audit-app.sql`, `03-audit-auth.sql` | app, auth | no | The same `key\|value` lines on each side: rows, id checksum, email checksum, hash checksum, credential count, system-domain rows |
| `03-audit-auth-query.sql` | auth | no | The auth-side audit query, included by `03-audit-auth.sql` (in a read-only transaction) and by `02` under `--dry-run`. Never run on its own |
| `operator-env.sh` | none | no | Sourced by `copy.sh` and `complete-tombstones.sh`: the operator-environment check above |
| `auth-journal.mjs` | none (prints SQL) | no | The auth journal in `_journal.json` order: `files` (runbook step 5 applies each with its own `psql --single-transaction`), `check` (SQL printing `<tag>\|t` per migration from the objects its SQL creates, failing on any missing) and `sql` (every file, then that check as an assertion: `copy.sh --dry-run`'s baseline). A statement kind it cannot check is refused. |
| `copy.sh` | both | via `02` (nothing with `--dry-run`) | Refuses anything `operator-env.sh` refuses. Runs `01 \| 02`, then both audits, prints them, and exits non-zero on any difference. `--dry-run`: see above |
| `05-audit-admins-auth.sql` | auth | no | The admin set after `grant-admin.ts` (runbook step 8). It must equal the approved list |
| `04-tombstones-pending-app.sql` | app | no | The ids of deletions whose `apps/auth` step did not finish, as one array literal |
| `04-tombstones-delete-auth.sql` | auth | yes | `DELETE FROM auth.users WHERE id = ANY(:'ids')`; the cascade removes their sessions and accounts. Never calls the endpoint |
| `04-tombstones-mark-app.sql` | app | yes | Marks those tombstones complete |
| `complete-tombstones.sh` | both | via `04b`, `04c` | Same guards as `copy.sh`; runs `04a → 04b → 04c` |
| `rollback-remove-post-cutover-users.sql` | app | only with `-v confirm=yes` | Counts, then (confirmed) deletes the users created at or after `-v cutover_at`. Rollback runbook step 2 |
| `rehearsal-anomalies.ts` | app (staging only) | via `psql` | **Phase 13 rehearsal, never production.** Refuses without `CUTOVER_ENV=staging`, an app host that is not staging's forwarder, a dirty or unpromoted checkout, or a terminal on stdout (it must be piped into `psql`). Prints SQL for `psql --single-transaction`: `seed` (eight rows: a case-collision pair, a non-bcrypt hash, a NULL `updated_at`, a mixed-case `$2a$`, a `$2b$`, a legacy admin, a guest; password from `REHEARSAL_PASSWORD`, never printed), `resolve-collision`, `resolve-hash`, `resolve-null`, `remove` (rehearsal ids only). See [`docs/cutover/rehearsal.md`](../../../../docs/cutover/rehearsal.md) |

Every `psql` invocation uses `-X -v ON_ERROR_STOP=1`. The scripts that write open their
own transaction (`BEGIN … COMMIT`), so they are run **without** `--single-transaction`:
`02` must create its `TEMP` table and read the pipe outside the transaction it then opens.

**Re-running.** The copy refuses a non-empty `auth.users` or `auth.account`. A second
attempt starts by emptying the auth database and re-applying the whole auth journal
(runbook step 5, `auth-journal.mjs`). The credential backfill is also safe to re-run on its own: `auth.account`'s
unique `(user_id, provider_id)` turns a second credential for a user into a no-op
(`ON CONFLICT … DO NOTHING`).

**Tested by** `apps/auth/tests/cutover/copy.test.ts`. It runs these files unmodified
against two pglite databases, through a harness for the psql subset they use
(`tests/cutover/psql.ts`). The real `psql` pipe and `copy.sh` run in the phase 13
rehearsal.
