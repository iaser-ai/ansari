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
branch the `auth` service deploys from~~. [Superseded 2026-11-21: ~~it deploys from `develop`, with
auto-deploy on (owner's statement); see the owner decisions below.~~] [Corrected in the window,
2026-11-21: it deploys from **`main`**, with auto-deploy on (measured, then confirmed by the owner
in the dashboard); see "the production window, as run" below.]

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
- ~~**Production `auth` deploys from `develop`, with auto-deploy on** (owner's statement). The
  promotion to `main` starts no `auth` deployment.~~ [Corrected in the window, 2026-11-21: the
  owner's statement before the window; measured in it, production `auth` deploys from **`main`**,
  and step 10's push deployed it (Railway's "ansari-backend - auth-prod" status on `c314fa59`,
  pending 11:22:47Z, success 11:23:18Z), which the owner then confirmed in the dashboard.] The
  window checks, before the promotion, that `auth`'s code equals the promoted commit's on its
  build paths (runbook step 9), so the push deploys the code step 9 checked. ~~Step 16 switches
  `auth`'s source branch to `main`.~~ [Corrected: step 16 confirms the source is `main` and
  records the deployment.]
- **On a production rollback, `auth` stays where it is** (~~untouched. It stays on the deployment
  it had all along~~ [corrected 2026-11-21: from step 11 on that is the deployment step 10's push
  started, rollback state (b)]), with `auth.askansari.ai` attached and auto-deploy off for the
  rollback's duration ([`rollback.md`](rollback.md), step 3 item 4 and step 5).
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

## 2026-11-21: the production window, as run

The production cutover window ran on 2026-11-21. Production is live on the promoted commit.
Sources for each line are named. "Owner's statement" is what the owner reported. "Measured by
the security architect" is what the security architect measured from the owner's machine or
network. "Git" and "GitHub" are read from the repository and its API by the close-out builder.
**owner to fill** marks a value only the owner can see or hold; none of these is guessed.

### Commits

| What | Value | Source |
|---|---|---|
| Promoted commit | `c314fa5919e797d307a8daf132217c0b10765863` (merge of PR #421) | git |
| `main` before the push | `b1b6ddf0fa185c3da83db5c5e7f28478e1190431` (PR #418, the legacy web maintenance switch, merged to `main` 10:28:23Z); before that `27531c8f` (PR #384) | git, GitHub |
| Commits promoted | 1,484 (`git rev-list --count b1b6ddf0..c314fa59`); 0 `main`-only (`c314fa59..b1b6ddf0`) | measured before the push by the security architect; re-counted by the builder from git |
| `develop` during the day | `455415a0` (PR #417) → `ac4dca53` (PR #420, the merge-back of #418, merged 10:35:36Z) → `c314fa59` (PR #421, merged 11:07:24Z, mid-window, while the window was at step 6, on the owner's word) | git, GitHub |
| What those moves changed | `455415a0..ac4dca53`: `legacy/frontend-web` only (#418's switch). `ac4dca53..c314fa59`: `docs/`, `RELEASE.md`, `apps/api/tests/cutover-docs.test.ts`, `codev/state/`. Neither range changes a script, a migration, or `apps/auth`, `packages` or `apps/api` source | verified by the security architect and the main architect; re-read by the builder (`git diff --name-only`) |
| Operator checkout | Confirmed at `c314fa59`, clean, equal to `origin/develop`, before step 9 | security architect |
| Commit steps 5 to 8 ran from | **owner to fill** (one of `455415a0`, `ac4dca53`, `c314fa59`; identical on every script path) | owner |

### Deviations from the runbook

- The rehearsal precondition was waived (recorded above, "owner decisions (backend-only release)").
- Step 12a was skipped (recorded above: not available with legacy web's flag on).
- Web was taken offline by legacy web's `MAINTENANCE_MODE` flag, not by a domain detach (recorded
  above).
- PR #421 (docs only) merged to `develop` mid-window, at step 6, on the owner's word. The freeze
  allowed only the rehearsal's evidence PR. Nothing it changed is on a script path (Commits, above).
- The operator worked in the existing `develop` checkout, not a fresh clone detached at the
  recorded commit, as the runbook's operator environment says (owner's statement).
- Production `auth` deployed on the push to `main` (step 10). The runbook expected no `auth`
  deployment, on the owner's statement before the window that it deploys from `develop`.
  Corrected in the runbook (step 1, 10, 11, 16), the deploy guide and the rollback.
- Production `backend` did not auto-deploy after the push. The owner deployed it by hand (step 11).

### Step by step

| Step | Recorded | Source |
|---|---|---|
| 1 | Rollback targets (deployment IDs and commits of `backend`, legacy web and `auth`), deploy sources, the web flag's OFF check and raw line, `MCP_COMPLETE_KEY_MODE=log-only`: **owner to fill** | owner |
| 2 | Maintenance notice and alert silences: **owner to fill** | owner |
| 3 | Both flags on, measured before step 5: `app-check` `maintenance_mode` `true` on `api.askansari.ai` and `api-35.ansari.chat`; `web-flag-ON` on `ansari.chat` and `askansari.ai` (bundle line `MAINTENANCE_MODE:()=>t("true")`) | security architect |
| 3 | `cutover_at`: **owner to fill**. Session start: **owner to fill** | owner |
| 4 | Snapshot ids or PITR marks, app and auth databases: **owner to fill** | owner |
| 5 | `clean-tree`; `0000_auth_schema\|t`; `0001_api_key\|t`; users-and-accounts count `0`. **No journal file applied in the window**, so no `auth-journal-applied` line is added | owner's output, relayed to the security architect |
| 6 | Preflight problem counts `0` (owner's statement); users-and-accounts count `0` immediately before the copy | owner |
| 6, dry run | `copy.sh --dry-run`: rows `87825`, id_checksum `92b9083d907c7c15b577362599b46a32`, email_checksum `b8ac2bcbb446af459b0db18a255d045e`, hash_checksum `6ca8205aa6ce93bb075436158bd5347f`, credentials `87825`, system_domain_rows `0`; identical on both sides; `dry run audit OK (nothing committed)` | owner's output |
| 6, copy | Auth side: rows `87829`, id_checksum `ecad98407c9d0a5ba21ee309487a3849`, email_checksum `5ab544d25330b65fcc709e835f0c1801`, hash_checksum `02867f66829e19f24f2993d279ae1784`, credentials `87829`, system_domain_rows `0`; `copy.sh: audit OK`. The app block was relayed only from its credentials line down; `copy.sh` prints `audit OK` only when both blocks are equal (`apps/auth/scripts/cutover/copy.sh`). **87,829 users migrated** | owner's output |
| 6, note | The count rose by 4 between the dry run and the copy, minutes apart, with both flags on: legacy clients kept signing up under maintenance (runbook step 3, "Measured on 2026-11-21") | owner's output |
| 7 | `0009`: four `does not exist, skipping` notices and `DO` (no scaffold table existed); `0010`: `CREATE TABLE`; `0011`: `DO`. Checks: `t`, `YES`, `0` | owner's output |
| 8 | Admins granted (owner's statement). Number granted and the audit's line count: **owner to fill**. No address is written here | owner |
| 9 | `/health` `200`. The `auth` deployment unchanged and `auth-tree-matches`: owner's statement ("it's fine"). `<auth running commit>`: **owner to fill**. From outside: `/api/service/verify-key` `400` on an empty body, `/api/account/me` `401`, JWKS `200` | owner; security architect |
| 10 | Pushed at about 11:17Z (the CI run on `main` was created 11:17:58Z). `origin/main` == `c314fa59` | GitHub; security architect |
| 10 | The push printed `remote: Bypassed rule violations … - Changes must be made through a pull request.`: GitHub's notice of the admin bypass, read at the time as a rejection. It was not one (`origin/main` moved) | security architect |
| 10 | Session duration, steps 3 to 10: **owner to fill** | owner |
| 11 | Railway commit statuses on `c314fa59` (`gh api repos/iaser-ai/ansari/commits/c314fa59…/statuses`): CI on `main` ran 11:17:58Z to 11:22:54Z (its last job, `auth`, completed 11:22:53Z). At 11:22:47Z `auth-prod`, `mcp` and `whatsapp` went pending; `mcp` success 11:22:59Z, `whatsapp` 11:23:10Z, **`auth-prod` success 11:23:18Z ("auth.askansari.ai")**. **`api` (production `backend`) got no status** until the owner ran **Deploy latest commit** on it: pending 11:25:39Z, success 11:27:11Z ("api-35.ansari.chat"). Why `backend` did not auto-deploy is **not established** (the main architect is investigating) | GitHub |
| 11 | After the `auth` deploy (11:23Z): `/health` `200`, JWKS `1` key, `/internal/…` `404`, `/api/account/me` `401` | security architect |
| 11 | The new `apps/api` serving: `/api/v2/_diag/client-ip` `200` on both api domains from 11:27Z | security architect |
| 11 | New `backend` deployment ID: **owner to fill** | owner |
| 12 | Edge probes at about 11:28Z, IPv4, from the owner's network: overwrite **PASS** on `api.askansari.ai` (via Cloudflare and direct), `api-35.ansari.chat` (direct) and `auth.askansari.ai` (via Cloudflare). A client-supplied `CF-Connecting-IP` through Cloudflare is refused by Cloudflare (`403`, `error code: 1000`). Not measured: IPv6 (no IPv6 on that network), `auth.askansari.ai` direct, distinctness (needs a second network; owed by the owner). **The security architect decided the window goes on.** Details: [`edge-check.md`](edge-check.md), Observations | security architect |
| 12a | Skipped (production; above) | |
| — | Probes on the new api's compatibility layer, about 11:29Z: wrong password `401` "Invalid email or password"; a legacy-style refresh token in the JSON body `401` "Invalid or expired refresh token"; `users/me` with no token `401` | security architect |
| 13 | Web flag off: the legacy web rebuild ran 11:30:21Z to 11:30:47Z (GitHub status `frontend-legacy`, "askansari.ai"); measured 11:32:41Z: `web-flag-OFF` on `ansari.chat` and `askansari.ai`, bundle line `t("")` | GitHub; security architect |
| 13 | New web deployment ID and `web-sources-match`: **owner to fill** | owner |
| 14 | Smoke test passed (owner's statement) | owner |
| 15 | Maintenance off: the `backend` redeploy ran 11:33:17Z to 11:33:51Z (GitHub status `api`); measured 11:36:26Z: `app-check` `maintenance_mode` `false` on both api domains | GitHub; security architect |
| 15 | Released mobile build relaunched and signed in: **owner to fill** | owner |
| 16 | Production `auth`'s source branch is `main` (owner's statement). `auth` is in rollback state (b): on the deployment step 10's push started (pending 11:22:47Z, success 11:23:18Z). Its deployment ID: **owner to fill** | owner; GitHub |
| 16 | Alerts un-silenced; the hotspot distinctness probe; the Tailscale forwarder removed and its key revoked: **owner to fill** | owner |
| 16 | **Rollback deadline** (`cutover_at` + 24 hours): **owner to fill** | owner |

### After the window, the same day

- **Service keys** (by [`service-keys-runbook.md`](service-keys-runbook.md), from the production
  auth shell, after the copy): `whatsapp`, created, `AUTH_WHATSAPP_API_KEY` set, tested working;
  `ansari-mcp`, created and tested working (owner's statement). The GitHub statuses show `mcp`
  redeploying 11:42:59Z to 11:43:13Z and `whatsapp` 11:44:56Z to 11:45:25Z. Key ids and names:
  **owner to fill** (an id is not a secret; a key is never written here).
- **`MCP_COMPLETE_KEY_MODE` stays `log-only`** on `backend`. Enforcement comes after a week of
  verdicts, with #409.

### Open after the window

- Distinctness on every edge path, IPv6, and `auth.askansari.ai` direct to the Railway edge
  ([`edge-check.md`](edge-check.md)).
- Why production `backend` did not auto-deploy on the push (main architect).
- Every **owner to fill** row above.
- `RELEASE.md`'s sentences on `auth`'s source branch and on the auto-deploy after a promotion (the
  main architect's to reconcile).
