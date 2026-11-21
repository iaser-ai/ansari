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
- **From:** the `develop` checkout at `3951c8068e82c735219d987497f8b7013ecd3536` (`3951c806`).
  `packages/auth/drizzle` is unchanged there since `47b4dfc0`.
- **Check:** `node apps/auth/scripts/cutover/auth-journal.mjs check | psql "$AUTH_DATABASE_URL" -X -q -At -v ON_ERROR_STOP=1`
  printed exactly:

  ```
  0000_auth_schema|t
  0001_api_key|t
  ```

auth-journal-applied: 0000_auth_schema
auth-journal-applied: 0001_api_key

- **Emptiness, after the apply (2026-11-21):** the owner ran
  `select (select count(*) from auth.users) + (select count(*) from auth.account)`
  against the production auth database; it printed `0`.

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
