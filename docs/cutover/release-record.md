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

**Reversing it.** Only if the auth schema is dropped **and not re-applied** (a drop not followed by
the runbook's "Empty the production auth database: drop and re-apply", i.e. by an explicit owner
decision): add a dated "reverted" entry here, put the two lines above in backticks so they no
longer match, and set `AUTH_DEPLOYED_THROUGH` back to `null` in that test. A production abort or
rollback drops and re-applies in one transaction: the record then stays true and gets a dated
entry. (Scoped 2026-11-21; this paragraph first said any drop, a step 5 or 9 abort included.)

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
deployment**. ~~The runbook does not expect this: step 1's Railway bullet expects "no domain yet"
and "no active deployment", and step 9's check expects `404` or `502` (deploy guide step 7: never
`200`).~~ [Superseded 2026-11-21: the runbook now has a production branch for each (step 1: a live
deployment and the domain attached; step 9: skip the attach, expect `200`).]

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
  production (no schema); now it can. ~~The WhatsApp and `ansari-mcp` keys are issued after the copy
  and before step 10's promotion ([`service-keys-runbook.md`](service-keys-runbook.md)).~~
  [Superseded 2026-11-21, see the owner decisions below: no keys in the window.]

Not established: whether the domain is reachable from outside the owner's network~~, and which
branch the `auth` service deploys from~~. [Superseded 2026-11-21: it deploys from `develop`, with
auto-deploy on (owner's statement); see the owner decisions below.]

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
- **Remedy if it does not:** ~~the runbook's own. Empty the auth database
  (`DROP SCHEMA auth CASCADE`) and re-run from step 5, where after a drop the `for` loop is run as
  printed (step 5's note). Then reverse the apply record above.~~ [Superseded 2026-11-21.] The
  runbook's "Empty the production auth database: drop and re-apply", then step 5 as check only.
  The apply record stays true.

## 2026-11-21: owner decisions (backend-only release; relayed by the security architect)

- **No service keys in the window.** No `create-service` and no `create-key` runs in the window.
  The `ansari-mcp` and WhatsApp keys are issued **after the window closes**, by
  [`service-keys-runbook.md`](service-keys-runbook.md), and never before step 6's
  `copy.sh: audit OK`. This supersedes the earlier line, in the deviation entry above, on issuing
  the keys between the copy and the promotion. That earlier line is struck through there, as
  history.
- **WhatsApp is out of this window** (#336 open).
- **The rehearsal precondition is waived for this window** (owner, 2026-11-21). The owner states
  the staging rehearsal was run end to end, and waives the written evidence, the security
  architect's verdicts and the same-commit requirement. Consequence: `rehearsal.md`'s result rows
  are blank and the staging edge verdict was never recorded, so the edge properties are first
  measured live at runbook steps 11 and 12, where the security architect decides whether the
  window goes on. Legacy web against the new `apps/api` has not been run; runbook step 12a is
  not available in production (owner, 2026-11-21, below), so steps 13 and 14 are the first time,
  alongside real users.
- **`MCP_COMPLETE_KEY_MODE=log-only` on `backend`** is already set (owner's statement, not
  verified from the repo). With no key issued, it is the only thing keeping `mcp.ansari.chat` and
  the agent skill served after step 10, so the runbook's step 1 refuses to start without it.
- **Production `auth` deploys from `develop`, with auto-deploy on** (owner's statement). The
  promotion to `main` starts no `auth` deployment. The window checks, before the promotion, that
  `auth`'s code equals the promoted commit's on its build paths (runbook step 9). Step 16 switches
  `auth`'s source branch to `main`.
- **On a production rollback, `auth` is untouched.** It stays on the deployment it had all along,
  with `auth.askansari.ai` attached and auto-deploy off for the rollback's duration
  ([`rollback.md`](rollback.md), step 3 item 4 and step 5).
- **The production auth database is never left without its schema.** Every drop runs in one
  transaction with the re-apply of the whole journal (the runbook's "Empty the production auth database:
  drop and re-apply"), so the apply record above stays true. Staging drops only.

## 2026-11-21: owner decision: legacy web goes offline by its maintenance flag (relayed by the security architect)

- **In production, legacy web is taken offline with the build-time `MAINTENANCE_MODE` variable on
  the legacy web service** (PR #418), **instead of detaching the web domain.** This reverses the
  owner's earlier decision of the same day: "web domain detached at step 3, re-attached at 13".
  Runbook step 3 sets it `true`, step 13 sets it `false`; [`rollback.md`](rollback.md) steps 1 and
  4 do the same. The web domain stays attached. It is a service variable of the legacy web
  service, never a shared variable: `backend`'s flag goes off at step 15, web's at step 13.
- **Staging is unchanged:** its web service is `apps/frontend`, which has no switch (#419), so it
  still detaches and re-attaches its domain.
- **Accepted residual:** a tab loaded before step 3's maintenance build went live, and not
  reloaded, keeps running the build it loaded against whichever `apps/api` is serving (runbook
  step 3, residual). The detach had the same residual: it stops new loads and reloads, not an
  open tab's calls to the api's own origin.
- **During the window, reset links and shared links on web land on the maintenance screen** (every
  route shows it and makes no api request).
- **Step 12a is skipped in production:** with the flag on, the legacy web service's Railway domain
  serves the maintenance build too. Legacy web against the new `apps/api` is first exercised at
  steps 13 and 14, alongside real users, a combination never run before (owner-accepted).
- **To record before the window (runbook step 1):** the legacy web service's current deployment ID
  and commit; that the commit carries PR #418's switch; that `MAINTENANCE_MODE` is absent or
  `false` there, as a service variable; that its `EXPO_PUBLIC_API_V2_URL` is an absolute api
  origin; and step 3's OFF check output (`web-flag-OFF`) with `web_flag`'s raw line.
