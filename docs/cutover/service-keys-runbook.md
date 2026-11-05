# Service keys runbook (spec 329)

How the operator issues, hands off, rotates, changes and revokes a service's API key, applies
the migration they depend on, and answers the alerts the WhatsApp token exchange raises. The
design and its reasons are in `codev/specs/329-apps-auth-service-api-keys-bet.md`.

A **service** (the WhatsApp service; later `ansari-mcp`, #314) is one auth user with no
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
| `create-key <service> --rate-max <n> --rate-window <seconds> --daily <n> [--name <text>] [--client-id <text>]` | Issues a key. Prints the raw key **once**. |
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
prints the database as `hostname:port` only. Limits have no defaults and are checked against the
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
| `whatsapp` | `ansari_wa_[A-Za-z]{64}` |
| `ansari-mcp` | `ansari_mcp_[A-Za-z]{64}` |

When one fires: **revoke the key at once** (`list`, then `revoke`), rotate so the consumer keeps
working, check the alerts and the key's last request for use you cannot explain, and record it in
the key log. Then remove the key from the repository's history; revoking first matters more.

**The prefix change of 2026-10-30.** Keys were first issued as `wa_` followed by 64 letters, and
are now `ansari_wa_` (and `ansari_mcp_`). A `wa_` key still verifies, because a key is checked by
the hash of the whole key, so nothing breaks; but replace it: `rotate whatsapp` (prints an
`ansari_wa_` key once), switch the consumer's variable to it, then `revoke` the old key. Keep the
old organisation pattern (`wa_` followed by 64 letters) registered beside the new ones until the
last `wa_` key is revoked, then remove it.
