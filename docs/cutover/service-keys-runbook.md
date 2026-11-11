# Service keys runbook (spec 329)

How the operator issues, hands off, rotates, changes and revokes a service's API key, applies
the migration they depend on, and answers the alerts the WhatsApp token exchange raises. The
design and its reasons are in `codev/specs/329-apps-auth-service-api-keys-bet.md`. The
`ansari-mcp` key (#314) has its own section,
[The `ansari-mcp` key](#the-ansari-mcp-key-314): its issuance, handoff, limits and alerts differ;
the script, revocation, the key log and secret scanning are shared.

A **service** (the WhatsApp service, or `ansari-mcp`, #314) is one auth user with no
credential, under `@noreply.askansari.ai`, found by its `{provider_id: 'service', account_id:
<name>}` account row. Its **keys** are rows in `auth.apikey`, created through the
`@better-auth/api-key` plugin in process. The plugin's HTTP surface is blocked, so
`apps/auth/scripts/service-keys.ts` is the only way to create, list, rotate, change or revoke a
key. A key is never a session.

## The script

Run it in the **auth service's Railway shell** (it needs apps/auth's full env and refuses to
start without it), from `apps/auth/`:

```bash
./node_modules/.bin/tsx scripts/service-keys.ts <command> <service> [flags]
```

| Command | Does |
|---|---|
| `create-service <service>` | Creates the service user and its `service` account row, in one transaction. Refuses a second one. |
| `create-key <service> --rate-max <n> --rate-window <seconds> --daily <n> [--name <text>] [--client-id <text>]` | Issues a key whose prefix names the environment (`ansari_<service>_<ENVIRONMENT>_`). Prints the raw key **once**. |
| `list <service>` | Lists the service's keys: id, name, enabled, limits, budget left, last request. Never a key or a hash. |
| `rotate <service>` (the `create-key` flags) | Issues a second live key beside the current one(s). Prints the new raw key once. |
| `update-limits <service> --key <key id> --rate-max <n> --rate-window <seconds> --daily <n>` | Changes one key's limits in place. |
| `revoke <service> --key <key id>` | Sets `enabled = false`. Keeps the row. |

Every write is two steps, as in `grant-admin.ts`: run it without `--confirm` to see the service
user and what would happen (nothing is written, exit 2), then again with `--confirm <the id it
showed>`: the service user's id for `create-key` and `rotate`, the **key's** id for
`update-limits` and `revoke` (so a confirm copied from another key's show step writes nothing),
and the service name for `create-service`, which has no user yet. `--name` and `--client-id` take
1 to 64 letters, digits, spaces, dots, underscores and hyphens; a value that looks like a key is
refused, since both are printed by `list` and sent to Sentry. Without `SENTRY_DSN` every write
prints the key-log banner and exits 3 (no record is attempted). The script
prints the database as `hostname:port` only, and under it `ENVIRONMENT`, which the script reads
from its process env (the auth service's own variable, so the Railway shell has it) and refuses
to run without (#314 Amendment 3). A new key's prefix carries it: `ansari_wa_production_`,
`ansari_mcp_staging_`, …, and each environment's routes refuse a key labelled for another, so
check the two lines agree before `--confirm`. Limits have no defaults and are checked against the
bounds in `packages/auth/src/limits.ts`; there is no expiry option and no budget without a
daily refill (a budget that does not refill deletes the key the first time it runs out).

Every write also sends one Sentry event (action, service, user id, key id, name; never key
material). If that event cannot be sent, the write stands, the script prints a banner of `!!`
lines and exits 3: record the action in the [key log](#key-log) at once.

## Issuance

1. The migration is applied (see [Applying `0001`](#applying-0001-staging-before-the-merge)) and the
   auth service is deployed with it.
2. `create-service whatsapp`, then `create-service whatsapp --confirm whatsapp`.
3. `create-key whatsapp --rate-max 60 --rate-window 60 --daily 3000 --name <purpose and date>
   --client-id <the consumer's identifier>`, read the shown user, then repeat with
   `--confirm <user id>`. These are the initial values (`WHATSAPP_KEY_INITIAL`); see
   [Limits](#limits).
4. Hand the key off (next section) before you do anything else in the shell.

## The handoff

The raw key exists in exactly one place after creation: the terminal you created it in. Paste it
**straight into the consumer's Railway variable** (the WhatsApp service's key variable), and
nowhere else: not a chat, a ticket, a document, a password manager note, a commit or a shell
history file. Then clear the terminal. If the key was ever pasted anywhere else, treat it as
leaked: rotate and revoke (below).

## Rotation

Rotation is overlap, not replacement:

1. `rotate <service>` with the same limit flags as the current key (see `list`), confirmed by id.
2. Hand the new key off into the consumer's variable, and let the consumer redeploy.
3. Watch the consumer's exchanges succeed (`list` shows the new key's last request; the
   old key's stops moving).
4. `revoke <service> --key <old key id>`, confirmed by id.

**While two keys are live, the service's ceiling doubles**: budgets and rate limits are per key,
not per service. Keep the overlap short (minutes, not days), and never leave a rotation half
done.

Revoking a key does not end tokens it already obtained: a minted JWT stays valid until it
expires (≤ 15 minutes). To cut a user off at once, ban them (their sessions are deleted).

### Scheduled rotation

Production keys have no expiry, so nothing else forces a rotation. **Every key is rotated every
6 months**, owned by the operator: rotate, switch the consumer, revoke the old key, as above, and
note it in the key log. Rotate at once, off schedule, whenever a key may have been seen by anyone
or anything other than the consumer's variable.

## Revocation and pruning

`revoke` sets `enabled = false` and keeps the row, so the key's history stays. A revoked key is
refused at the exchange with the same 401 as an unknown one. There is no un-revoke: issue a new
key.

Pruning: none expected. Production keys have no expiry, so no expired rows accumulate, and
revoked rows are kept as the record. If an expired row ever appears (a key created outside the
script), revoke it, and record why in the key log.

## Limits

| Value | Initial | Meaning |
|---|---|---|
| `--rate-max` / `--rate-window` | 60 per 60 s | Bounds a leaked key or a looping consumer within a minute. |
| `--daily` | 3,000 | The daily budget, refilled every 24 h. Hundreds of conversations at one exchange per 15-minute token, with headroom. |
| `WHATSAPP_EXCHANGE_PER_USER` | 6 per 15 min, per user | In `limits.ts`; a looping client for one user gets 429 at once. Not per key. |

These values are **judgement, not measurement** (owner decision 3): the legacy service's
traffic was not available to size them. The alerts sit at one third of the key's caps, so a
real surge is seen well before anything is refused. To change a key's values, use
`update-limits` (no code change, no deploy), or rotate with new values and revoke the old key.
The script's accepted bounds (`WHATSAPP_KEY_BOUNDS`, inclusive) are wide on purpose, so a
raise never needs a code change; a per-user limit change does (`limits.ts`):

| Flag | Accepted |
|---|---|
| `--rate-max` | 1 to 100,000 |
| `--rate-window` | 1 second to 24 hours (1 to 86,400 seconds) |
| `--daily` | 1 to 10,000,000 |

A value outside them is refused with nothing written.

## Applying `0001`: staging, before the merge

`packages/auth/drizzle/0001_api_key.sql` creates `auth.apikey` and adds
`unique (provider_id, account_id)` to `auth.account`. No phone number is stored anywhere.

The migration ships **before** the code that uses it: apps/auth refuses to start when
`auth.apikey` or the constraint is missing, so a deploy that runs ahead of the migration fails
its healthcheck instead of serving. `develop` deploys to staging, where `0000` is already
applied, so **on staging the apply precedes the merge**: until `0001` is applied there, the
merged apps/auth refuses to start on staging.

The apply discipline and the scope of the duplicate check, as the main architect set them
(2026-10-28):

> Apply the whole auth journal in `_journal.json` order, one `psql -X -v ON_ERROR_STOP=1
> --single-transaction` per file. The duplicate pre-check is needed only where data already
> exists (staging now).

On staging, in order:

1. **The duplicate check.** The constraint fails to apply if `auth.account` already holds a
   duplicate pair. Run this against the staging auth database and expect zero rows:

   ```sql
   select provider_id, account_id, count(*) as n
   from auth.account
   group by provider_id, account_id
   having count(*) > 1;
   ```

   Any row: **stop**. Do not apply the migration; report the count (never the ids or account
   ids in a chat) to the security architect.
2. **The apply.** Adding the constraint takes an **ACCESS EXCLUSIVE lock on `auth.account`**,
   a table every sign-in reads, while it builds the unique index. Apply `0001` in a quiet window
   (the lowest-traffic hour), with `psql -X -v ON_ERROR_STOP=1 --single-transaction` naming the
   auth database, as `RELEASE.md` describes.
3. **The verification** below, then the merge.

**Production** is not this runbook's: at the production cutover, the full auth journal as it
stands then (`0000`, `0001` and any later migration) is applied in order before the promoted code
deploys, owned by [`better-auth-cutover.md`](better-auth-cutover.md). The auth database is empty
when the journal is applied there, so the constraint cannot fail at apply; the copy then runs
against the final schema in its single transaction, where a duplicate aborts cleanly.

Verify (both must be `t`):

```sql
select to_regclass('auth.apikey') is not null as apikey,
       exists (select 1 from pg_catalog.pg_constraint c
                 join pg_catalog.pg_class r on r.oid = c.conrelid
                 join pg_catalog.pg_namespace n on n.oid = r.relnamespace
                where n.nspname = 'auth' and r.relname = 'account'
                  and c.conname = 'account_provider_id_account_id_unique' and c.contype = 'u'
                  and array(select a.attname::text
                              from unnest(c.conkey) with ordinality k(attnum, ord)
                              join pg_catalog.pg_attribute a
                                on a.attrelid = c.conrelid and a.attnum = k.attnum
                             order by k.ord) = array['provider_id', 'account_id']
             ) as constraint_present;
```

Both must be `t`. The constraint check is the boot check's own query (`hasAuthUniqueConstraint`):
it binds the name to `auth.account`, a unique constraint, and the columns in order, so a
same-named constraint elsewhere cannot answer `t`.

## Alerts

Every exchange alert is one Sentry event with key ids, counts, thresholds and windows only
(never a key, a BSUID, a phone number or a user id); each fires at most once per window
(`EXCHANGE_ALERT_WINDOW`, 5 minutes) and refuses nothing. A per-key alert carries `keyId`, the
id `list` prints, so match it there. The other kinds mark the **first** occurrence (or the
threshold crossing) in their window and carry no count: see Sentry's event volume, or the server
log, for how many followed.

| `kind` | Means | Do |
|---|---|---|
| `key-window-volume` | One key made `WHATSAPP_EXCHANGE_KEY_ALERT` (20) exchanges inside its 60 s window: a third of its cap. | Check the consumer for a loop or a cache that is not caching. Expected only on a real surge. |
| `key-daily-volume` | One key made `WHATSAPP_EXCHANGE_DAILY_ALERT` (1,000) exchanges since its daily refill. | Compare with conversation volume. A surge you trust: raise with `update-limits`. Otherwise treat the key as leaked. |
| `key-refused` (`USAGE_EXCEEDED` / `RATE_LIMITED`) | The key hit its budget or window; the consumer is getting 401. | Users are affected now. Confirm the traffic is real, then `update-limits`; if not, rotate and revoke. |
| `unauthorized-volume` | 401s reached `EXCHANGE_UNAUTHORIZED_ALERT` (20) in a window. | Outside a rotation a healthy consumer sees none: a revoked or wrong key in the consumer's variable, or someone guessing. Check the consumer's variable against `list`. |
| `ineligible-user` | A user behind a `whatsapp` account row may not get a token (500 to the consumer). | The [eligibility repair](#eligibility-repair). |
| `service-user-unresolvable` | The WhatsApp service user is missing or not unique: every exchange is a 500. | `list whatsapp`; if it reports no or several service users, report to the security architect before changing anything. |

Every key refusal at the exchange (missing, unknown, revoked, expired, budget, window, wrong
permission) gives the consumer the same 401; the alerts above are how the operator tells them
apart.

## Eligibility repair

A WhatsApp user gets a token only if: its **only** account row is its `whatsapp` row; its
address is its own `whatsapp-<id>@noreply.askansari.ai`; `registered_via = 'whatsapp'`; and its
role is exactly `user` (anything else, `admin`, `user,admin` or an unknown role, is refused). A violation is a 500 for every message from that user, never a token, and
it stays so until repaired.

1. Find the user id: the auth service's log line
   `whatsapp exchange: ineligible user refused (repair per the service-keys runbook)` carries
   `{userId, reason}` (the Sentry event carries counts only). `reason` is one of `accounts`,
   `address`, `registered_via` or `role`.
2. Inspect, in the auth database:

   ```sql
   select id, email, registered_via, role, banned from auth.users where id = '<user id>';
   select provider_id, created_at from auth.account where user_id = '<user id>';
   ```

3. Repair the one thing `reason` names: `accounts`, delete the stray (non-`whatsapp`) account
   row; `role`, set the role back to `user` with `grant-admin.ts --revoke <email>`; `address` or `registered_via`, correct it. If you cannot tell how the
   row came to be, delete the user (`delete from auth.users where id = '<user id>'`; its sessions
   and accounts cascade): the next message recreates them as a new user. Their app data in
   apps/api stays under the old id, so prefer a targeted repair.
4. Record the repair in the key log (user id, reason, action).

## Key log

Where the operator records a key action the script could not record in Sentry (the `!!`
banner, exit 3), and every scheduled rotation and eligibility repair. Add one row by PR to this
file. Ids are not secrets; never write a key, a hash, a BSUID or a phone number here.

| Date (UTC) | Action | Service | User id | Key id | Name / note |
|---|---|---|---|---|---|

## Secret scanning

Each key prefix has a GitHub custom secret-scanning pattern, so a key committed to any
repository in the organisation is flagged. Registering them is an **owner action**: GitHub
organisation **Settings → Code security → Secret scanning → Custom patterns → New pattern**, one
per prefix, with exactly these patterns (the `.source` of `SECRET_SCANNING_PATTERNS` in
`packages/auth/src/service-users.ts`, which tests pin against real keys and near misses):

| Service | Pattern |
|---|---|
| `whatsapp` | `ansari_wa_(?:(?:development\|staging\|production)_)?[A-Za-z]{64}` |
| `ansari-mcp` | `ansari_mcp_(?:(?:development\|staging\|production)_)?[A-Za-z]{64}` |

These replace the patterns registered before #314 (`ansari_wa_[A-Za-z]{64}` and
`ansari_mcp_[A-Za-z]{64}`), which miss an environment-labelled key: edit each pattern in place.
The environment segment is optional while unlabelled keys are live (next paragraph).

When one fires: **revoke the key at once** (`list`, then `revoke`), rotate so the consumer keeps
working, check the alerts and the key's last request for use you cannot explain, and record it in
the key log. Then remove the key from the repository's history; revoking first matters more.

**The prefix change of 2026-10-30.** Keys were first issued as `wa_` followed by 64 letters, and
are now `ansari_wa_` (and `ansari_mcp_`). A `wa_` key still verifies during the compatibility window below, because a key is checked by
the hash of the whole key, so nothing breaks; but replace it: `rotate whatsapp` (prints an
`ansari_wa_` key once), switch the consumer's variable to it, then `revoke` the old key. Keep the
old organisation pattern (`wa_[A-Za-z]{64}`, the `.source` of `LEGACY_SCANNING_PATTERNS.whatsapp`
in `service-users.ts`) registered beside the new ones until the last `wa_` key is revoked, then
remove it.

**Environment labels (#314 Amendments 2 and 3, owner 2026-11-12).** Keys are now issued as
`ansari_<service>_<ENVIRONMENT>_` followed by 64 letters, where `ENVIRONMENT` is the issuing auth
service's (`development`, `staging` or `production`). Both routes (the WhatsApp exchange and the
MCP verify route) serve only a key whose stored prefix names their own service and their own
`ENVIRONMENT`; any other prefix (another environment's, another service's, a hand-made one) is
their ordinary refusal (401 / `{"valid":false}`). The only exception is the compatibility window
below.

**Existing keys are unchanged.** A key's string is fixed when it is created, the plugin matches
its hash, and `apikey.prefix` is written then and never rewritten. Adding the environment segment
re-issues nothing: the staging `ansari_wa_` keys keep their format and keep verifying under the
compatibility window.

**Rotate legacy keys (the compatibility window).** An unlabelled key (`ansari_wa_`, `ansari_mcp_`,
or WhatsApp's pre-rename `wa_`, followed directly by 64 letters; `list` shows its `prefix`) is
still accepted while `LEGACY_UNLABELLED_KEYS` is `true` (`LEGACY_PREFIXES` in
`service-users.ts`). Replace it, never reissue it in place: `rotate <service> …` in
that environment's auth shell (a labelled key), hand it off to the consumer's variable, then
`revoke` the old one. Staging has at least one (the
WhatsApp smoke key). When `list whatsapp` and `list ansari-mcp` show no live unlabelled key on any
database, retire the legacy form in one change: set `LEGACY_UNLABELLED_KEYS` to `false` in
`packages/auth/src/service-users.ts` (the routes then refuse the bare prefix, and the script and
the patterns stop accepting it), deploy, and re-register both patterns with the new `.source`
(`ansari_wa_(?:development|staging|production)_[A-Za-z]{64}`, likewise for `ansari_mcp_`). The
follow-up issue that closes the window is opened with this change's enforcement step.

## The `ansari-mcp` key (#314)

`POST /api/v2/mcp-complete` on apps/api takes an `ansari-mcp` key as `Authorization: Bearer
<key>` and asks apps/auth whether it is good at `POST /api/service/verify-key` on every request.
A missing or refused key is 401 `{"error":"Unauthorized"}`; apps/auth unreachable or slower than
apps/api's client timeout (3 s) is 503 `{"error":"Authentication service unavailable"}`, with
nothing persisted and no Gemini call. The design is in
`codev/specs/314-protect-v2-mcp-complete-with-b.md`. The [script](#the-script),
[revocation](#revocation-and-pruning), the [key log](#key-log) and
[secret scanning](#secret-scanning) are the same as for WhatsApp; what differs is below.

### Issuance

**One key per MCP deployment** that calls a deployed apps/api, so each can be rotated or
revoked alone and its traffic is attributed to it:

| Deployment | Who sets its variable | `--client-id` | Created in |
|---|---|---|---|
| `mcp.ansari.chat` | the owner (owner-operated, outside this repository) | the owner's choice of `ansari-mcp*` id | the production auth shell (`ansari_mcp_production_`) |
| `mcp-staging.askansari.ai` (apps/mcp on Railway, see `RELEASE.md`) | the operator, as a Railway service variable | `ansari-mcp-staging` (its `ANSARI_CLIENT`) | the staging auth shell (`ansari_mcp_staging_`) |
| each apps/mcp Worker environment in use (apps/mcp's `wrangler.jsonc`) | the operator, as a Worker secret | its `ANSARI_CLIENT`: `ansari-mcp-dev`, `ansari-mcp-beta` or `ansari-mcp-production` | the auth shell of the environment whose apps/api that Worker calls |

1. apps/auth is deployed with the verify route (it ships with this change; there is no new
   migration: `auth.apikey` is spec 329's `0001`).
2. Once: `create-service ansari-mcp`, then `create-service ansari-mcp --confirm ansari-mcp`.
3. Per deployment, in the auth shell of the environment it calls: `create-key ansari-mcp
   --rate-max 120 --rate-window 60 --daily 5000 --name <deployment and date> --client-id <its id>`, read the shown user, then repeat with
   `--confirm <user id>`. These are the initial values (`MCP_KEY_INITIAL`); see
   [Limits](#limits-1).
4. Hand the key off (next section) before you do anything else in the shell.

`--client-id` is **required** for `ansari-mcp` and must be `ansari-mcp`, or `ansari-mcp-` and a
suffix of lowercase letters, digits, dots, underscores and hyphens, 64 characters at most;
anything else is refused with nothing written. The client id is thread attribution; the
prefix's environment is key identification: they answer different questions and are set apart.
It is what apps/api stores as the thread's `client`: a conflicting `X-Ansari-Client` header is ignored (Sentry warning
`mcp-complete client mismatch`).

**Staging order.** `mcp-staging.askansari.ai` sends no key today. Its key is created and set
**before** apps/api on staging deploys #314: apps/api defaults to `enforce`, so a staging deploy
without the key, or without `MCP_COMPLETE_KEY_MODE=log-only`, refuses every staging MCP call.

### The handoff

apps/mcp sends `ANSARI_API_AUTHORIZATION` **verbatim** as the `Authorization` header, so the
value is the whole header: `Bearer ansari_mcp_<environment>_<64 letters>`, the word `Bearer`,
one space, then the key. A key from another environment's auth shell is refused (401). A bare key is no bearer: apps/api answers 401 (verdict `missing` in log-only).

- **Worker:** from `apps/mcp/`, `wrangler secret put ANSARI_API_AUTHORIZATION --env <env>`, and
  paste the value at its prompt, straight from the shell you created the key in. Never put it on
  the command line, in `wrangler.jsonc` or in a `.dev.vars.<env>` file.
- **Railway (`mcp-staging`):** paste the value **straight into the mcp service's
  `ANSARI_API_AUTHORIZATION` variable**, then let it redeploy.
- **`mcp.ansari.chat`:** the owner sets their own upstream Authorization variable to the same
  form.

The rule of [The handoff](#the-handoff) holds: no chat, ticket, document or history file. Then
clear the terminal.

### Rollout: log-only, then enforce

`MCP_COMPLETE_KEY_MODE` on apps/api: `enforce` (the default, and what an absent variable means)
or `log-only`. Any other value stops apps/api at boot.

1. Issue and hand off every deployment's key (above). Today's route ignores the header, so this
   is safe at any time.
2. Deploy apps/api with `MCP_COMPLETE_KEY_MODE=log-only`. It verifies every request, records the
   verdict, and always serves, even with apps/auth down.
3. Watch the verdicts for one week: the log line `[ai-skill] mcp-complete key verdict`
   (`{verdict, keyId}`) and the Sentry tag `mcp_key_verdict`, one of `valid`, `missing` (no
   bearer), `refused` (`valid: false`) or `unverified` (apps/auth gave no usable answer; also the
   Sentry warning `mcp-complete key unverified (log-only)`). Expect no `missing` or `refused`
   from the MCP servers.
4. Remove the variable, which enforces.
5. Open the follow-up issue due one week after the enforce date: remove log-only mode,
   `MCP_COMPLETE_KEY_MODE` and its `turbo.json` entry, so a transition switch does not outlive
   the transition as a way to turn auth off.

In `enforce`, an apps/auth outage is a 503 for every MCP call (log line
`[ai-skill] mcp-complete key verify unavailable`), never a 200 without a key.

### Limits

| Value | Initial | Meaning |
|---|---|---|
| `--rate-max` / `--rate-window` | 120 per 60 s | Per key, across all of that deployment's users together: the burst ceiling for its MCP traffic. |
| `--daily` | 5,000 | The daily Gemini ceiling for the deployment, refilled every 24 h. |
| apps/api per-IP cap | 120 per minute, per client IP | `RATE_LIMIT_PER_MINUTE` in `apps/api/src/app/api/v2/mcp-complete/route.ts`; a second layer, unchanged. |

Every `mcp-complete` call is one verify, and each verify spends one unit of the key's budget and
one slot of its window. A key at its cap answers `valid: false`, so its callers get 401. Like
WhatsApp's, these values are **judgement, not measurement**, pending the owner's
`threads.client` numbers; change them with `update-limits`. The accepted ranges
(`MCP_KEY_BOUNDS` in `packages/auth/src/limits.ts`) equal WhatsApp's. The total ceiling is the
sum over live keys.

### Alerts

Every verify alert is one Sentry event `auth: MCP key verify alert: <kind>`, tagged
`alert: mcp-verify-<kind>`, with key ids, counts, thresholds and windows only, on the terms of
the WhatsApp [Alerts](#alerts): at most once per 5-minute window, refusing nothing.

| `kind` | Means | Do |
|---|---|---|
| `key-window-volume` | One key made `MCP_VERIFY_KEY_ALERT` (40) verifies inside its 60 s window: a third of its cap. At most once per key every 5 minutes. | Check that deployment for a loop. Expected only on a real surge. |
| `key-daily-volume` | One key made `MCP_VERIFY_DAILY_ALERT` (1,666) verifies since its daily refill. | Compare with the deployment's traffic. A surge you trust: `update-limits`. Otherwise treat the key as leaked. |
| `key-refused` (`USAGE_EXCEEDED` / `RATE_LIMITED`) | The key hit its budget or window; its callers are getting 401. | Users are affected now. Confirm the traffic is real, then `update-limits`; if not, rotate and revoke. |
| `unauthorized-volume` | `valid: false` answers reached 20 in a window. | Outside a rotation a healthy MCP server sees none: a revoked key, a WhatsApp key, or someone guessing. Check each deployment's variable against `list ansari-mcp`. (A variable without `Bearer ` never reaches this route: apps/api records it as verdict `missing`.) |
| `service-user-unresolvable` | The `ansari-mcp` service user is missing or not unique: every verify is a 500, so every MCP call is 503 (enforce). | `list ansari-mcp`; if it reports no or several service users, report to the security architect before changing anything. |
| `client-id-invalid` | The plugin accepted a key whose `client_id` is missing or not `ansari-mcp*` (a key made outside the script); its caller got `valid: false`. The event names its `keyId`. | Revoke that key and issue a proper one with the script. Record how it came to exist in the key log. |

### Rotation

As [Rotation](#rotation), per deployment:

1. `rotate ansari-mcp` with the same limit flags and **the same `--client-id`** as the current
   key (see `list`), confirmed by id.
2. Hand the new key off into that deployment's variable (`wrangler secret put … --env <env>`, the
   Railway variable, or the owner's), and redeploy it.
3. `list ansari-mcp`: the new key's last request moves, the old key's stops.
4. `revoke ansari-mcp --key <old key id>`, confirmed by id.

**While two keys are live, the deployment's ceiling doubles.** Keep the overlap to minutes.

### Plugin upgrade check

The verify route calls `verifyApiKey` in process; the plugin's own `POST /api-key/verify` must
never be routed (its docs advertise one; 1.7.7, 1.7.20 and 1.8.0-beta.7 do not route it).
Before any `@better-auth/api-key` bump, run apps/auth's tests: `apps/auth/tests/blocked-paths.test.ts`
fails if `verifyApiKey` gains an HTTP path or the plugin's routed endpoints change, and asserts
that `/api/auth/api-key/verify` (any case, trailing slash) is refused. A failure there blocks the
bump until the blocked paths are re-checked by the security architect. Also re-read the plugin's
changelog for verify's refusal codes and its expiry behaviour (it deletes an expired key on
presentation, so expiry is never used on a key whose history matters).
