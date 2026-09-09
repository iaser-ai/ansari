# PIR Plan: Port the legacy ansari-backend → Postgres migration script into `apps/api/scripts`

Issue: #131

## Understanding

The tool that copies users, threads and messages out of the legacy Python/MongoDB
ansari-backend into this system's Postgres lives only in the archived private repo
`cluesmith/ansari-multisage` (`scripts/migrate-users.ts` + `scripts/lib/*`, ~1,100 lines,
plus 63 tests). It imports *that* repo's copy of the Drizzle schema, which froze at
migration `0003`. Since then this repo has landed:

| Migration | Adds |
|---|---|
| `0004_ancient_mongu` | `messages.raw_payload jsonb` |
| `0006_feedback_dedupe_upsert` | unique `(user_id, message_id, feedback_class)` on `feedback` |
| `0007_tool_calls_persistence` | `messages.tool_calls jsonb`, new table `tool_call_orphans` |
| `0008_model_provenance` | `messages.model_provider`, `messages.model_id` (and on orphans) |

(`0002` and `0003` — `registered_via`, `threads.client`, `messages.client`, `is_admin`,
`system_key`, `session_version` — post-date the old repo's schema copy too; the old script
never set any of them and got their defaults by accident.)

Every re-run of the old script therefore writes into a schema it was never checked against.
The ask is to move the toolchain here, beside the schema, wire it into CI, and make every
column decision explicit.

I verified the source by reading it in full at
`/Users/mwk/Development/cluesmith/ansari4/ansari-multisage/scripts/` and its
`codev/{specs,plans,reviews}/8-user-migration-from-ansari-bac.md`. Key behaviors to keep:

- CLI: `migrate` / `delete-readonly`; `--email`, `--dry-run`, `--from-file`, `--output`
  (default `tmp/migration-mapping.jsonl`); env check for `MONGO_URL`, `MONGO_DB_NAME`
  (only for `migrate` without `--from-file`) and `DATABASE_URL`; DB modules loaded by
  dynamic import *after* env validation so a missing var yields one clean line, not a
  pool-creation stack trace.
- Re-run semantics: an existing target user (matched by normalized email) is not
  re-created; their already-migrated legacy threads are deduplicated by `createdAt`
  against `threads WHERE source='legacy'`; a source user with no threads (or none with
  surviving messages) is skipped; migrated threads and messages carry `source='legacy'`.
- Content filter: allowlist `text` blocks, drop `tool_use`/`tool_result`/`document`
  silently, warn on unknown types, skip `role='tool'` messages, skip threads left empty.
- Per-user transaction: user + threads + messages commit or roll back together; the
  JSONL mapping file is appended only after commit.
- Newsletter: newly created accounts are subscribed via `createThrottledSubscriber(60)`
  (already present in this repo's `apps/api/lib/newsletter.ts`; no-op when
  `MARKETMAKER_URL` is unset).
- `delete-readonly`: deletes `source='legacy'` messages then threads (optionally scoped by
  `--email`), then deletes accounts that appear in the mapping file **and** have no
  remaining threads.

Two things in the old code do not fit this repo's rules and must change shape (not
behavior):

1. `apps/api/eslint.config.mjs` lints `scripts/**` and forbids `process.env.DATABASE_URL`
   outside `lib/config.ts` (issue #17 guard, backed by `tests/eslint-env-guard.test.ts`).
   `apps/api/lib/db/index.ts` also creates its pool from `config.database.url` at import,
   which Zod-validates the *whole* schema. So the script's "fail fast" check must go
   through `config`, and the Mongo vars must be declared in the Zod schema + `turbo.json`
   `globalEnv` (arch-critical rule).
2. The old `user-migrator` / `thread-migrator` / `delete-readonly` tests mocked the Drizzle
   chain. The issue (and `lessons-critical.md`) require pglite with the current DDL, so
   those three suites are rewritten rather than ported verbatim.

## Proposed Change

### 1. Code layout (`apps/api/scripts/`)

```
apps/api/scripts/migrate-users.ts            CLI entry (ported; env check via config)
apps/api/scripts/migration/types.ts          SourceUser / SourceThread / SourceMessage / option types
apps/api/scripts/migration/mongo-reader.ts   Extended-JSON parsing, normalization, dedup, file + Mongo readers
apps/api/scripts/migration/content-filter.ts text-block allowlist
apps/api/scripts/migration/mapping-writer.ts JSONL append/read (0600)
apps/api/scripts/migration/thread-migrator.ts thread + message inserts inside a tx
apps/api/scripts/migration/user-migrator.ts  existing-user detection, dedup, per-user tx
apps/api/scripts/migration/delete-readonly.ts rollback command
```

Imports follow `scripts/grant-admin.ts`: relative paths into `../lib/db/index`,
`../db/schema`, `../lib/config`, `../lib/newsletter`, `../lib/auth/reserved`. (Vitest's
`@/lib/db/index` mock still applies — both resolve to the same module, exactly as
`tests/grant-admin.test.ts` relies on today.)

The transaction parameter type becomes the repo's existing `Executor` from
`lib/db/index.ts` instead of the old `Parameters<Parameters<...>>` expression (the old
review listed that as tech debt).

### 2. Env surface

- `apps/api/lib/config.ts`: add `MONGO_URL: z.string().url().optional()` and
  `MONGO_DB_NAME: z.string().min(1).optional()` and a `config.legacyMongo` getter returning
  `{ url, dbName }`. Optional because the app never needs them; the script enforces
  presence itself.
- `scripts/migrate-users.ts` `validateEnv`: collect missing `MONGO_URL` / `MONGO_DB_NAME`
  from `config.legacyMongo` (only for `migrate` without `--from-file`); then touch
  `config.database.url` inside try/catch and print the Zod message on failure. Either
  path exits 1 before any DB module is imported. Net effect: the script now also
  requires `JWT_SECRET`, `KALEMAT_API_KEY`, `USUL_API_TOKEN` — unavoidable, because
  `lib/db/index.ts` already validates the full schema at import (grant-admin has the same
  property). Documented in the runbook.
- `mongo-reader.ts` `getDb()` reads `config.legacyMongo`, never `process.env`.
- `turbo.json` `globalEnv`: add `MONGO_URL`, `MONGO_DB_NAME` with a comment (derivation
  step 1: they are in the Zod schema).
- `apps/api/.env.example` (commented-out block) and `docs/self-hosting.md` "Optional /
  defaulted" table: document both as "only read by `scripts/migrate-users.ts`".

### 3. Column-by-column adaptation to the current schema

This is the substantive part. Each insert lists **every** column of the target table with
a one-line reason, so a future column addition is a visible omission in review, and a
pglite test (§5) asserts the full persisted row.

**`users`** (new accounts only — existing accounts are never updated):

| Column | Value | Why |
|---|---|---|
| `email` | normalized source email | matched on for idempotency |
| `password_hash` | source bcrypt hash verbatim | Python `$2b$`/`$2a$` verifies under Node bcrypt (existing `tests/migration/bcrypt-compat.test.ts`) |
| `first_name`, `last_name` | source | |
| `source` | source `source` ?? `'web'` | legacy enum web/android/ios/whatsapp/mcp is plain text here |
| `registered_via` | `NULL` | means "no X-Ansari-Client at register time" (spec 56); legacy accounts predate attribution |
| `is_admin` | `false` (column default) | NEVER derived from source data; admins are granted only by `scripts/grant-admin.ts` |
| `system_key` | `NULL` | legacy users are never system accounts; additionally any source email that `isReservedAddress()` rejects (system domain or `ADMIN_EMAILS`) is **skipped** with reason `reserved email`, mirroring registration |
| `session_version` | `0` (default) | fresh account, no sessions to invalidate |
| `created_at`, `updated_at` | source timestamps | preserved (dedup keys on thread `created_at`) |

**`threads`**:

| Column | Value | Why |
|---|---|---|
| `user_id`, `name` | mapped / source | |
| `source` | `'legacy'` | the read-only marker; also what dedup and `delete-readonly` key on |
| `client` | `NULL` | per-request X-Ansari-Client attribution does not exist in the source; NULL is the documented "absent" value, not `'invalid'` |
| `created_at`, `updated_at` | source timestamps | inserted directly, NOT via `createThread`/`createMessage` (those stamp `now()` / bump `updated_at`) |

**`messages`**:

| Column | Value | Why |
|---|---|---|
| `thread_id`, `role`, `content` | mapped / filtered text blocks | unchanged |
| `agent_name` | `NULL` | unchanged |
| `source` | `'legacy'` | |
| `client` | `NULL` | as for threads |
| `input_tokens`, `output_tokens`, `thinking_tokens`, `total_tokens` | `NULL` | source has no usage accounting; NULL is the schema's documented "persisted before token tracking" value |
| `raw_payload` | `NULL` | Gemini `Content` for turn-2+ replay; legacy answers were not produced by Gemini and legacy threads are read-only, so there is nothing to replay |
| `tool_calls` | `NULL` (never `[]`) | tool blocks are dropped by the content filter and NOT reconstructed as `ToolCallRecord`s — legacy `tool_result` blocks lack the required `status`/`duration_ms`; NULL is the "turn invoked no tools" value |
| `model_provider`, `model_id` | `NULL` | provenance is a runtime fact this system records per turn; the source does not carry it. NULL is the documented "historical rows" value |
| `created_at` | message `created_at` ?? thread `created_at` | unchanged |

**Not written**: `tool_call_orphans` (only failed live turns produce them), `feedback`,
`shares`, `preferences`, `tokens` — same scope as the original spec. `delete-readonly`
continues to rely on `ON DELETE CASCADE` for anything hanging off legacy threads/messages
(feedback, shares, orphans); a test proves the cascade.

### 4. Package wiring

- `apps/api/package.json`: `"migrate-users": "tsx scripts/migrate-users.ts"` under
  `scripts`; `mongodb` (`^7.x`, currently 7.6.0) under **devDependencies** — the script
  runs from a dev checkout via `tsx` (itself a devDependency); the Railway image never
  runs it. Added via `pnpm --filter ansari-api add -D mongodb` so the lockfile updates.
- `printUsage()` shows `pnpm migrate-users <command> [options]`.

### 5. Tests (`apps/api/tests/migration/`)

Pure-logic suites ported near-verbatim (import paths only):

- `mongo-reader.test.ts` (20: Extended JSON `$oid`/`$date`, native `ObjectId`, dedup,
  file reader, email normalization/filtering, embedded threads)
- `content-filter.test.ts` (13)
- `mapping-writer.test.ts` (5; temp dirs under `os.tmpdir()`)
- `bcrypt-compat.test.ts` — already here and byte-identical; untouched.

Rewritten against **pglite with the current DDL** (mocking `@/lib/db/index` via the
`vi.hoisted` pattern from `tests/grant-admin.test.ts`; DDL in a shared
`tests/migration/pglite.ts` covering `users`, `threads`, `messages` with all `0004`–`0008`
columns, `tool_call_orphans`, `feedback`):

- `thread-migrator.test.ts`: inserts inside a real `db.transaction`; empty-after-filter
  thread skipped; mixed threads; dry-run writes nothing; **full-row assertion** that every
  `messages`/`threads` column matches the §3 table (the guard against "left to chance").
- `user-migrator.test.ts`: new user via `--from-file` fixture (embedded threads, so no
  Mongo mock is needed); existing user gets only new threads; dedup by `createdAt`;
  no-threads skip; reserved-address skip; dry-run leaves zero rows; **atomicity** — a
  forced failure mid-thread-insert leaves no user row; **idempotency** — run the same
  fixture twice, assert `count(users|threads|messages)` unchanged and every result
  reports `skipped: 'no new threads'`.
- `delete-readonly.test.ts`: bulk and `--email`-scoped deletion; mapped user with no
  remaining threads deleted, user with a non-legacy thread preserved, unmapped user
  preserved; a `feedback` row on a legacy message disappears by cascade; non-legacy rows
  untouched.
- `migrate-users-cli.test.ts`: `parseArgs` and the missing-env computation extracted as
  pure exported functions — unknown flag rejected; `MONGO_*` required for `migrate`
  without `--from-file`, not required with it, never for `delete-readonly`.
- `tests/config.test.ts`: `MONGO_URL` rejects a non-URL, both optional when absent.
- `tests/release-doc.test.ts`: add `docs/legacy-migration.md` and
  `apps/api/scripts/migrate-users.ts` to the must-exist references. Its
  `pnpm <script>` regex currently ends in `\b`, so `pnpm migrate-users` would be read as
  script `migrate` and fail; change the terminator to `(?![\w:-])` (negative-tested in the
  same file with a virtual doc string).

Fixtures use the already gitleaks-allowlisted bcrypt hash or obviously fake
`$2b$12$not-a-real-hash…` strings, `@example.com` emails, and no hosts. I will run
`gitleaks detect` locally before pushing.

### 6. Runbook

New `docs/legacy-migration.md`: prerequisites (network path to Mongo, full API env because
`lib/db` validates it, `MONGO_URL`/`MONGO_DB_NAME`), the three-step ladder
**dry-run → single `--email` → bulk**, what the mapping file is and why it must be kept
(it is the only thing that lets `delete-readonly` remove accounts), the `--from-file`
export alternative, the newsletter side effect and how `MARKETMAKER_URL` gates it, re-run
behavior, and rollback via `delete-readonly`. `RELEASE.md` gains a short "Legacy user
migration" subsection under "Migration release (variant)" pointing to it, with the
prohibition that production runs are a separate human-operated step. `docs/self-hosting.md`
and `.env.example` get the two env rows.

## Files to Change

- `apps/api/scripts/migrate-users.ts` — new; CLI (port of the old entry, env check via `config`, exported `parseArgs`/`missingEnv` for tests).
- `apps/api/scripts/migration/{types,mongo-reader,content-filter,mapping-writer,thread-migrator,user-migrator,delete-readonly}.ts` — new; ports with the §3 column policy, `Executor` type, `isReservedAddress` skip.
- `apps/api/lib/config.ts` — add `MONGO_URL`, `MONGO_DB_NAME` (optional) and `config.legacyMongo`.
- `apps/api/package.json` — `migrate-users` script; `mongodb` devDependency; `pnpm-lock.yaml` updated by pnpm.
- `turbo.json:globalEnv` — `MONGO_URL`, `MONGO_DB_NAME` with derivation comment.
- `apps/api/.env.example` — commented `MONGO_URL` / `MONGO_DB_NAME` block.
- `docs/self-hosting.md` — two rows in "Optional / defaulted".
- `docs/legacy-migration.md` — new runbook.
- `RELEASE.md` — pointer subsection.
- `apps/api/tests/migration/{pglite,mongo-reader.test,content-filter.test,mapping-writer.test,thread-migrator.test,user-migrator.test,delete-readonly.test,migrate-users-cli.test}.ts` — new.
- `apps/api/tests/config.test.ts`, `apps/api/tests/release-doc.test.ts` — extended as in §5.
- `codev/state/pir-131_thread.md` — builder thread log.

## Risks & Alternatives Considered

- **Risk: the script now demands the full API env** (JWT, Kalemat, Usul) because
  `lib/db/index.ts` validates the whole schema at import. Mitigation: documented in the
  runbook; `.env.ci`-style placeholder values suffice for a migration shell since only
  `DATABASE_URL` is used. Alternative: a separate pool that bypasses `config` — rejected,
  it re-creates the config-bypass the #17 lint guard exists to prevent.
- **Risk: `scripts/**` is excluded from `pnpm typecheck`** (tsconfig), so a column-name typo
  in the insert would not fail `tsc`. Mitigation: the full-row pglite assertions catch
  wrong/missing columns at test time, and I will run `tsc` over the new files by hand
  during implementation and report the result. Alternative: add `scripts/**` to the
  typecheck include — out of scope here (it would pull `grant-admin.ts` in too); I'll
  note in the review whether it is clean so the architect can decide.
- **Risk: dedup by `created_at` millisecond equality** is inherited; a legacy thread whose
  timestamp was rewritten would be re-imported. Unchanged from the accepted design;
  called out in the runbook.
- **Risk: `mongodb` driver adds weight to `pnpm install`.** It is a devDependency and the
  Dockerfile installs with `--filter ansari-api` (dev deps included for the build stage)
  — a few MB, no native addon, no `onlyBuiltDependencies` entry needed.
- **Alternative: reconstruct `tool_calls` records from legacy `tool_use`/`tool_result`
  blocks.** Rejected: `ToolCallRecord` requires `status`/`duration_ms` the source lacks,
  and the reliability analytics that read `tool_calls` are about *this* system's tool
  loop. Legacy tool blocks stay dropped, as before.
- **Alternative: migrate `feedback`/`preferences`/`shares`.** Rejected: not in the original
  spec or this issue; would need its own column audit.
- **Alternative: reuse `createThread`/`createMessage`/`createUser` helpers.** Rejected:
  they stamp `now()` and bump `threads.updated_at`, which would destroy the source
  timestamps the dedup depends on. Direct inserts with an explicit `Executor`, same as the
  original.

## Test Plan

- **Unit/integration (CI):** from `apps/api/`,
  `env $(grep -v '^#' .env.ci | xargs) pnpm test -- tests/migration` and the full
  `pnpm test`; `pnpm lint` (scripts are in scope; the env guard must stay silent);
  `pnpm typecheck`; `gitleaks detect -c .gitleaks.toml` at the repo root.
- **Manual (reviewer, dev-approval gate):**
  1. `pnpm migrate-users` with no args → usage + exit 1.
  2. `MONGO_URL= pnpm migrate-users migrate` → one line naming the missing vars, exit 1,
     no DB connection attempted.
  3. `pnpm migrate-users migrate --from-file <fixture.json> --dry-run` against a local
     Postgres with migrations 0000–0008 applied → prints would-insert lines, zero rows
     written.
  4. Same without `--dry-run` → rows present with `source='legacy'`; then re-run → summary
     shows all users skipped ("no new threads"), row counts unchanged.
  5. `psql`: `SELECT client, tool_calls, model_provider, raw_payload FROM messages WHERE source='legacy'`
     → all NULL; `SELECT is_admin, system_key, registered_via FROM users` for a migrated
     account → `false`, NULL, NULL.
  6. `pnpm migrate-users delete-readonly --email <one>` then bulk → legacy rows gone,
     non-legacy rows intact, mapped account removed only when it had no other threads.
  7. Log in to the local API as a migrated user with their legacy password (bcrypt
     portability on the real login path).
- **Not run here:** any invocation against production Mongo or Postgres (explicitly out
  of scope; human-operated).
