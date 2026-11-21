# Production cutover: release record

The production window's release record ([`better-auth-cutover.md`](better-auth-cutover.md),
"Release record"). Entries are added as the work is done, newest last. Counts and checksums only:
no email, hash, id or URL is ever written here.

## 2026-11-21: auth journal applied ahead of the window (schema only)

Done by the owner, before the cutover window, against the **production auth database**, which was
empty (no schema, no tables) at the time.

- **What:** the whole auth journal, `packages/auth/drizzle/meta/_journal.json` in order, one file
  per `psql -X -v ON_ERROR_STOP=1 --single-transaction -f <file>`:
  `0000_auth_schema.sql`, then `0001_api_key.sql`.
- **From:** a `develop` checkout at `3951c806` or its first parent `2f11877e` (the architect's
  assumption; the owner has not confirmed which). `packages/auth/drizzle` is byte-identical in
  both and unchanged since `47b4dfc0` (`git diff --quiet 47b4dfc0 <commit> -- packages/auth/drizzle`
  exits `0` for each).
- **Check:** `node apps/auth/scripts/cutover/auth-journal.mjs check | psql "$AUTH_DATABASE_URL" -X -q -At -v ON_ERROR_STOP=1`
  printed exactly:

  ```
  0000_auth_schema|t
  0001_api_key|t
  ```

- **Emptiness, after the apply (2026-11-21):** the owner ran
  `select (select count(*) from auth.users) + (select count(*) from auth.account)`
  against the production auth database; it printed `0`.

The apply record (`packages/auth/tests/migration/auth-journal-parity.test.ts` reads these two lines
and requires `AUTH_DEPLOYED_THROUGH` to name one of them):

auth-journal-applied: 0000_auth_schema
auth-journal-applied: 0001_api_key

**Reversing it.** If the auth schema is later dropped (`DROP SCHEMA auth CASCADE`: a step 5 or 9
abort, or [`rollback.md`](rollback.md)), add a dated "reverted" entry here, put the two lines above
in backticks so they no longer match, and set `AUTH_DEPLOYED_THROUGH` back to `null` in that test.

**Only the schema was applied.** No users were copied: `auth.users` and `auth.account` hold no
rows. Everything else stays for the window, as the runbook orders it:

- step 5: run the journal **check** only, and apply any journal file it reports missing (one that
  landed after `0001_api_key`); the emptiness check is now
  `select (select count(*) from auth.users) + (select count(*) from auth.account)` = `0`;
- step 6: the user copy and its audits (`copy.sh`);
- step 7: the app window migrations `0009` to `0011` on the app database;
- step 8: the admin grants (`apps/auth/scripts/grant-admin.ts`);
- and every later step (the auth domain, the promotion, the deploys).

The snapshot of the auth database (step 4) is now of a database that holds the schema and no rows.

## 2026-11-21: deviation: the production auth domain is attached and serving

Measured by the architect from the owner's machine, after the journal apply:

| Probe | Before the apply | After the apply |
|---|---|---|
| `https://auth.askansari.ai/health` | 500 | 200 |
| `https://auth.askansari.ai/api/auth/jwks` | 500 | 200 |
| `https://auth.askansari.ai/api/account/me` | 500 | 401 |

So in production the auth domain is **attached** and the `auth` service has a **live
deployment**. The runbook does not expect this: step 1's Railway bullet expects "no domain yet"
and "no active deployment", and step 9's check expects `404` or `502` (deploy guide step 7: never
`200`).

Consequences:

- `auth.jwks` now holds a key pair encrypted under the `BETTER_AUTH_SECRET` set at that moment.
  Changing that secret later requires emptying `auth.jwks`.
- A sign-up on that domain before the window would make `copy.sh` refuse
  (`auth.users is not empty`). So the users-and-accounts count
  (`select (select count(*) from auth.users) + (select count(*) from auth.account)` = `0`) is
  re-run **immediately before step 6**.
- **No `create-service` or `create-key` in production before step 6's `copy.sh: audit OK`.**
  `apps/auth/scripts/service-keys.ts create-service` (through `createServiceUser` in
  `packages/auth/src/service-users.ts`) inserts one row into `auth.users` and one into
  `auth.account`, and `create-key` needs that service user. The first guards of
  `apps/auth/scripts/cutover/02-import-auth.sql` refuse a non-empty `auth.users`
  (`auth.users is not empty`) or `auth.account`. Before today the script could not run in
  production (no schema); now it can. The WhatsApp and `ansari-mcp` keys are issued after the copy
  and before step 10's promotion ([`service-keys-runbook.md`](service-keys-runbook.md)).

Not established: whether the domain is reachable from outside the owner's network, and which
branch the `auth` service deploys from.

## 2026-11-21: owner decisions

**The production `auth` service stays serving until the window** (owner, 2026-11-21, relayed by
the architect). It keeps its live deployment and its attached `auth.askansari.ai` domain.

- **So:** step 1's "no domain yet" and "no active deployment" do not hold in production. At
  step 9 (deploy guide step 7) the attach is skipped, and the probe before the promotion expects
  `/health` `200` from the deployment already there. The stop-on-`200` still applies to staging
  and to any environment without this decision.
- **Accepted risk:** a sign-up on that domain before the copy makes `copy.sh` refuse
  (`auth.users is not empty`).
- **Mitigation:** the users-and-accounts count
  (`select (select count(*) from auth.users) + (select count(*) from auth.account)`) is run
  immediately before step 6 and must print `0`.
- **Remedy if it does not:** the runbook's own. Empty the auth database
  (`DROP SCHEMA auth CASCADE`) and re-run from step 5, where after a drop the `for` loop is run as
  printed (step 5's note). Then reverse the apply record above.
