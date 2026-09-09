# `migrate-users` — legacy user/thread migration (PARTIAL PORT)

> ## ⚠️ Status: partial port. Not verified against the current schema. **Not for production use.**
>
> This directory is a port of `scripts/migrate-users.ts` + `scripts/lib/*` from the
> archived private repo `cluesmith/ansari-multisage` (frozen at cutover, 2026-08-01),
> done under issue #131 so the code lives beside the schema it writes to and is covered
> by `pnpm typecheck`, `pnpm lint` and the pglite test suite.
>
> **That is all the port establishes.** The original imported a copy of this schema
> frozen at migration `0003`; every column added since (`0002`–`0008`, table below) is
> marked `// TODO(port):` at its insert site and is **not** handled — not populated, not
> reasoned about beyond "left at the column default". Nobody should run this against a
> real `DATABASE_URL` or `MONGO_URL` on the strength of this port. During the port itself
> the script was never executed in any mode (hard constraint on #131); only the tests ran.

## What it was, and what it is for next

| | Source | Target |
|---|---|---|
| **Original job** | legacy ansari-backend (Python + MongoDB, `ansari.chat`) | this repo's Postgres (`users` / `threads` / `messages`) |
| **Next job** | this repo's Postgres (`users` / `threads` / `messages`) | the Better Auth system (`apps/auth`, spec 59) |

The next job flips the roles: the Mongo reader becomes obsolete and the Postgres
writers become the thing being rewritten (Better Auth has a single `name` instead of
`first_name`/`last_name`, hashes passwords with scrypt rather than bcrypt, and has its
own user table — see spec 8 Q4 in the old repo). The layout below is arranged so that
swap touches one side at a time.

## Module map

```
index.ts               CLI entry: arg parsing, env validation, orchestration, newsletter side effect
types.ts               THE SEAM — SourceUser / SourceThread / SourceMessage. A new reader must produce these.
mapping-writer.ts      SHARED — append-only JSONL of source-id → target-id (+ run summary)

source/                SOURCE-SIDE — obsolete at the next job; replace with a Postgres reader
  mongo-reader.ts      Extended-JSON parsing, normalization, email dedup, JSON-file + Mongo readers
  content-filter.ts    legacy content → ContentBlock[] (text allowlist; tool blocks dropped)

target/                TARGET-SIDE — rewritten at the next job for Better Auth
  user-migrator.ts     existing-account detection, thread dedup by created_at, per-user transaction
  thread-migrator.ts   thread + message inserts inside the transaction, source='legacy'
  delete-readonly.ts   rollback: legacy messages → threads → mapped accounts with no threads left
```

Imports are relative (`../../lib/db/index`, `../../db/schema`), the same convention as
`scripts/grant-admin.ts`; the transaction handle is the repo's `Executor` type.

## CLI surface (preserved)

```
pnpm migrate-users <command> [options]        # from apps/api/

Commands:  migrate | delete-readonly
Options:   --email <email>  --dry-run  --from-file <path>  --output <path>
           (default output: tmp/migration-mapping.jsonl)
```

Env validation fails fast, before any DB module is imported:

| Variable | Required when | Where read |
|---|---|---|
| `MONGO_URL`, `MONGO_DB_NAME` | `migrate` without `--from-file` | `process.env` in `source/mongo-reader.ts` — deliberately **not** in `lib/config.ts` (per #131); declared in `turbo.json` `globalEnv` so strict env mode passes them through |
| `DATABASE_URL` | `migrate`, `delete-readonly` | through `config.database.url` — the #17 eslint guard forbids a raw read outside `lib/config.ts` |

Because `lib/db/index.ts` validates the **whole** runtime Zod schema at import, the
script also needs `JWT_SECRET`, `KALEMAT_API_KEY` and `USUL_API_TOKEN` set (placeholders
are fine; `grant-admin.ts` has the same property).

## Re-run semantics (preserved as written)

- An existing target account (matched by trimmed, lowercased email) is never re-created
  or updated.
- Its already-migrated threads are deduplicated by `threads.created_at` (millisecond
  equality) against rows with `source='legacy'`; only new threads are inserted.
- A source user with no threads, or none that survive the content filter, is skipped
  as an account.
- Migrated threads and messages carry `source='legacy'`; `delete-readonly` keys on it.
- Each user is one transaction; the mapping file is appended only after commit.
- Newly created accounts are subscribed to the newsletter through
  `lib/newsletter.ts` `createThrottledSubscriber(60)` — a no-op when
  `MARKETMAKER_URL` is unset.

## Column inventory — what the port does NOT handle

Every column this schema has gained since the original's schema copy. All are left at
their defaults and flagged `TODO(port)` at the insert site.

| Table.column | Migration | Default today | Why there is no legacy source |
|---|---|---|---|
| `users.registered_via` | 0002 | NULL | X-Ansari-Client at register time; source has none |
| `users.is_admin` | 0003 | `false` | must never be derived from source data (admin only via `scripts/grant-admin.ts`) |
| `users.system_key` | 0003 | NULL | legacy users are never system accounts; **no reserved-address check** (see gaps) |
| `users.session_version` | 0003 | `0` | fresh account; plausible default, unverified |
| `threads.client` | 0002 | NULL | per-request client attribution; source has none |
| `messages.client` | 0002 | NULL | same |
| `messages.input_tokens` … `total_tokens` | (pre-port here) | NULL | no usage accounting in the source |
| `messages.raw_payload` | 0004 | NULL | Gemini replay payload; none for legacy turns |
| `messages.tool_calls` | 0007 | NULL | legacy `tool_use`/`tool_result` blocks are **dropped** by the content filter, not converted to `ToolCallRecord` (needs `status`/`duration_ms` the source lacks). NULL is the schema's "no tools" value — never `[]` |
| `messages.model_provider`, `model_id` | 0008 | NULL | provenance of legacy turns unknown |
| `tool_call_orphans` (table) | 0007 | — | never written; on rollback the thread cascade removes any rows |

The pglite tests assert that these columns come back at their defaults after a
migration, so a change that starts populating one is a failing test to update, not
silent drift.

## Tests — ledger against the original suite

Location: `apps/api/tests/migration/`. Run from `apps/api/`:
`env $(grep -v '^#' .env.ci | xargs) pnpm test -- tests/migration`.

| Original file (cases) | Status here |
|---|---|
| `bcrypt-compat.test.ts` (5) | already present, byte-identical; untouched |
| `mongo-reader.test.ts` (20) | ported verbatim (import paths only) |
| `content-filter.test.ts` (13) | ported verbatim |
| `mapping-writer.test.ts` (5) | ported verbatim |
| `thread-migrator.test.ts` (5) | **rewritten on pglite** with the current DDL (the original mocked the Drizzle call chain). Same five cases; plus a full-row assertion of the column inventory and the `created_at` fallback |
| `user-migrator.test.ts` (4) | **rewritten on pglite**. Same four cases (new user, dedup skip, existing user, dry-run); plus no-threads skip, atomicity (a failing thread insert leaves no user row), users-row defaults, and a second identical run inserting zero rows |
| `delete-readonly.test.ts` (5) | **rewritten on pglite**. Same five cases; plus a `feedback` row on a legacy message removed by cascade |
| `newsletter.test.ts` (6) | not part of the migration code; this repo's `tests/lib/newsletter.test.ts` covers `lib/newsletter.ts` |
| — | new: `migrate-users-cli.test.ts` — `parseArgs`, `missingMongoEnv`, `databaseConfigError`. Does **not** invoke `main()` |

Skipped or removed: **none.**

## Port changes (behavior-neutral, listed so nobody hunts for them)

- `delete-readonly` counts rows via `.returning({ id })` instead of the driver's
  `rowCount` (which pglite does not populate). Same rows, same counts, both drivers.
- The `ERROR … CAUSE` line no longer prints the driver's `message`/`detail` (they can
  embed row contents — email, hash); only `code` and `constraint`.
- A newsletter call that returns `skipped: true` (`MARKETMAKER_URL` unset) is printed as
  "skipped (not configured)" and not counted as subscribed. The original counted it.
- `parseArgs` throws `UsageError` instead of calling `process.exit` so it is testable;
  `main()` prints usage and exits 1 as before.
- `scripts/**` was removed from `apps/api/tsconfig.json` `exclude`, so `pnpm typecheck`
  covers this directory (and `grant-admin.ts`).

## Known gaps (for the Better Auth rewrite, not fixed here)

- No reserved-address check: registration refuses `ADMIN_EMAILS` and
  `@system.ansari.chat` addresses (`lib/auth/reserved.ts`); the migrator does not.
- `feedback`, `shares`, `preferences` are not migrated (never were).
- Dedup by `created_at` millisecond equality: a source thread whose timestamp was
  rewritten would be re-imported.
- Scoped `delete-readonly` deletes messages one thread at a time (original tech debt).
