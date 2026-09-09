# PIR Plan: Port the legacy migration script into `apps/api/scripts/migrate-users/` (partial port)

Issue: #131 (body rewritten 2026-09-09 — this plan follows the rewritten framing)

## Understanding

The user/thread migration toolchain lives only in the archived private repo
`cluesmith/ansari-multisage` (`scripts/migrate-users.ts` + `scripts/lib/*`, ~1,100 lines,
plus tests). It imports that repo's own copy of the DB client and schema, frozen at
migration `0003`. The ask is to bring the code here so it lives beside the schema and is
covered by typecheck, lint and CI.

**Framing that governs every decision below:**

- **Partial port.** The result must typecheck, lint, and pass its pglite tests. It is
  *not* verified against the current schema and *not* for production. Columns with no
  obvious legacy source get a `// TODO(port):` marker, not a guess.
- **Hard constraint (architect + issue comment): the script is never executed** — not
  against prod, staging, `--dry-run`, or any real `DATABASE_URL`/`MONGO_URL`. The only
  execution is the vitest suite against pglite.
- **Next real use is different.** The tool's next job is importing from *this* repo's
  Postgres (`users`/`threads`/`messages`) into the Better Auth system (`apps/auth`,
  spec 59). So the **source side** (Mongo reader) is the part that becomes obsolete and
  the **target side** (writers) is the part that gets rewritten (`name` instead of
  first/last, scrypt vs bcrypt — spec 8 Q4 in the old repo). Module boundaries must make
  that split obvious.

I read the source in full. What must be preserved as written:

- CLI: `migrate` / `delete-readonly`; `--email`, `--dry-run`, `--from-file`, `--output`
  (default `tmp/migration-mapping.jsonl`); fail-fast env validation for `MONGO_URL`,
  `MONGO_DB_NAME` (only `migrate` without `--from-file`) and `DATABASE_URL`; DB modules
  loaded by dynamic import *after* validation.
- Re-run semantics: existing target user matched by normalized email is not re-created;
  their legacy threads are deduplicated by `createdAt` against
  `threads WHERE source='legacy'`; a user with no threads (or none with surviving
  messages) is skipped; migrated threads/messages carry `source='legacy'`.
- Content filter (text-block allowlist), per-user transaction, JSONL mapping file
  appended after commit, newsletter subscription of newly created accounts via
  `createThrottledSubscriber(60)` (this repo already has it in `lib/newsletter.ts`),
  `delete-readonly` deleting legacy messages → threads → mapped accounts with no
  remaining threads.

Repo constraints that change the *shape* (not the behavior) of the port:

1. `apps/api/eslint.config.mjs` lints `scripts/**` and forbids `process.env.DATABASE_URL`
   outside `lib/config.ts` (#17 guard, enforced by `tests/eslint-env-guard.test.ts`), and
   `lib/db/index.ts` builds its pool from `config.database.url` at import. So the
   `DATABASE_URL` fail-fast check must go through `config`; the Mongo vars stay on
   `process.env` (the issue says: do not add them to the Zod config).
2. `apps/api/tsconfig.json` excludes `scripts/**` from `pnpm typecheck`. The issue
   requires the port to typecheck, so that exclusion has to go. I probed this: with
   `scripts/**` included, `tsc --noEmit` on the current tree (i.e. `grant-admin.ts`)
   exits 0, so the change is safe.
3. Migrations `0004`–`0008` added columns the old code never saw:
   `messages.raw_payload`, `messages.tool_calls`, `messages.model_provider`,
   `messages.model_id`, table `tool_call_orphans`; and `0002`/`0003` added
   `users.registered_via`, `users.is_admin`, `users.system_key`, `users.session_version`,
   `threads.client`, `messages.client`. None has a legacy source.

## Proposed Change

### 1. Layout — boundaries first

```
apps/api/scripts/migrate-users/
  README.md                 status banner, module map, column inventory, test ledger
  index.ts                  CLI entry (ported migrate-users.ts) — header comment carries the banner
  types.ts                  SourceUser/SourceThread/SourceMessage — the SEAM between the halves
  mapping-writer.ts         SHARED: JSONL mapping append/read
  source/
    mongo-reader.ts         SOURCE-SIDE (obsolete next): Extended-JSON parsing, normalization, dedup, file + Mongo readers
    content-filter.ts       SOURCE-SIDE: legacy content → ContentBlock[] text allowlist
  target/
    user-migrator.ts        TARGET-SIDE (rewrite for Better Auth): existence check, dedup, per-user tx
    thread-migrator.ts      TARGET-SIDE: thread + message inserts within a tx
    delete-readonly.ts      TARGET-SIDE: rollback of source='legacy' rows
```

Every file opens with a one-line `SOURCE-SIDE` / `TARGET-SIDE` / `SHARED` tag and the
entry point + README carry the full banner: (a) partial port, not verified against the
current schema, not for prod; (b) next use is ansari-multisage → Better Auth; (c) which
modules are source-side vs target-side. `types.ts` is the contract a future
`source/postgres-reader.ts` must satisfy, so the target side stays untouched by the
source swap.

Imports follow `scripts/grant-admin.ts`: relative paths into `../../lib/db/index`,
`../../db/schema`, `../../lib/newsletter`. The transaction parameter uses the repo's
`Executor` type from `lib/db/index.ts` (the old repo listed its
`Parameters<Parameters<...>>` expression as tech debt).

### 2. Env validation

- `index.ts` `validateEnv`: `MONGO_URL` / `MONGO_DB_NAME` checked on `process.env` as
  before (only for `migrate` without `--from-file`); `DATABASE_URL` checked by touching
  `config.database.url` inside try/catch and printing the Zod message. Both exit 1 before
  any DB module is imported. Consequence, stated in the README: because `lib/db/index.ts`
  validates the whole Zod schema, the script also needs `JWT_SECRET`, `KALEMAT_API_KEY`,
  `USUL_API_TOKEN` present (same as `grant-admin.ts`).
- `source/mongo-reader.ts` keeps its `process.env.MONGO_URL` / `MONGO_DB_NAME` reads
  (not restricted by the lint guard; not in Zod, per the issue).
- `turbo.json` `globalEnv`: add `MONGO_URL`, `MONGO_DB_NAME` with a comment citing
  derivation step 2 (static `process.env.X` reads in `scripts/migrate-users/`).
- `docs/self-hosting.md` "Outside the config schema (direct `process.env` reads)" table:
  two rows, flagged as read only by the partial-port script. `apps/api/.env.example`: a
  commented block with the same flag. (Keeps the four-way env derivation consistent;
  no runbook is written — the tool is not for use.)

### 3. Schema adaptation — inventory, not guesses

Inserts keep the old field lists. Every column added since the old schema copy is
handled by **not** populating it, with a `// TODO(port):` at the insert site naming the
column, its current default, and why there is no legacy source. The README carries the
same inventory as a table:

| Table.column | Since | Current default | Port status |
|---|---|---|---|
| `users.registered_via` | 0002 | NULL | TODO(port) — no client attribution in source |
| `users.is_admin` | 0003 | `false` | TODO(port) — must never come from source data; leave default |
| `users.system_key` | 0003 | NULL | TODO(port) — legacy users are never system accounts; reserved-address skip not implemented |
| `users.session_version` | 0003 | `0` | TODO(port) — default is plausible for a fresh account; unverified |
| `threads.client` | 0002 | NULL | TODO(port) — no per-request client in source |
| `messages.client` | 0002 | NULL | TODO(port) |
| `messages.input/output/thinking/total_tokens` | pre-0003 in this repo | NULL | TODO(port) — no usage accounting in source |
| `messages.raw_payload` | 0004 | NULL | TODO(port) — Gemini replay payload; none for legacy |
| `messages.tool_calls` | 0007 | NULL | TODO(port) — tool blocks are filtered out, not converted to `ToolCallRecord` |
| `messages.model_provider`, `model_id` | 0008 | NULL | TODO(port) — provenance unknown for legacy turns |
| `tool_call_orphans` | 0007 | — | not written; TODO(port) note in `delete-readonly` (cascade covers it) |

The pglite tests assert what the port *does* write (`source='legacy'`, timestamps,
content) and that the TODO columns come back as their defaults — so a future change that
starts populating one shows up as a failing expectation to update, not a silent drift.

### 4. Package wiring

- `apps/api/package.json`: `"migrate-users": "tsx scripts/migrate-users/index.ts"`;
  `mongodb` `^7` (7.6.0 today) under **devDependencies** — runs from a dev checkout via
  `tsx` (also a devDependency); the Railway image never runs it. Added with
  `pnpm --filter ansari-api add -D mongodb` so `pnpm-lock.yaml` updates.
- `apps/api/tsconfig.json`: remove `"scripts/**"` from `exclude` so `pnpm typecheck`
  covers the port and `grant-admin.ts` (probed clean).
- `printUsage()` in `index.ts` shows `pnpm migrate-users <command> [options]` and repeats
  the not-for-prod banner.

### 5. Tests (`apps/api/tests/migration/`)

`bcrypt-compat.test.ts` already exists here, byte-identical to the old one — untouched.

Ported near-verbatim (pure logic; only import paths change):

- `mongo-reader.test.ts` (20 cases: `$oid`/`$date`/native `ObjectId`, dedup, file reader,
  normalization, embedded threads) — needs the `mongodb` dep for `ObjectId`.
- `content-filter.test.ts` (13 cases).
- `mapping-writer.test.ts` (5 cases; temp dirs under `os.tmpdir()`).

Rewritten against **pglite with the current DDL** — the old versions mocked the Drizzle
call chain and cannot exercise transactions (`lessons-critical.md`). Same case list, real
rows. DDL lives in a shared `tests/migration/pglite.ts` (users, threads, messages with
all `0004`–`0008` columns, `tool_call_orphans`, `feedback`), mocking `@/lib/db/index`
via the `vi.hoisted` pattern from `tests/grant-admin.test.ts`:

- `thread-migrator.test.ts` (5): insert with correct fields, skip-when-all-filtered,
  mappings, dry-run writes nothing, mixed threads. Plus the full-row assertion from §3.
- `user-migrator.test.ts` (4 ported + 2): new user via `--from-file` fixture (embedded
  threads — no Mongo mock needed); dedup-by-timestamp skip; existing user gets new
  threads only; dry-run. Added: atomicity (forced failure mid-thread leaves no user row)
  and a second identical run inserting zero rows.
- `delete-readonly.test.ts` (5): bulk, mapped-user delete, preserve-with-non-legacy,
  `--email` scope, scoped-user-not-found. Plus cascade of a `feedback` row.
- `migrate-users-cli.test.ts` (new, small): `parseArgs` and the missing-env computation
  exported as pure functions; asserts the `MONGO_*` rules per command and that
  `DATABASE_URL` absence is reported through `config`. Does **not** invoke `main()`.

Dropped: none planned. If any ported case cannot be made to pass without changing
behavior, it is listed under "Skipped tests" in the README with the reason, per the issue.

Fixtures: the already gitleaks-allowlisted bcrypt hash or obviously fake
`$2b$12$not-a-real-hash…` strings, `@example.com` emails, no hosts or DB names. I will
run `gitleaks detect -c .gitleaks.toml` locally before pushing.

### 6. Not done, on purpose

- No runbook, no `RELEASE.md` change: the tool is not for use in its current state.
- No reserved-address / admin-email skip, no `tool_calls` reconstruction, no
  feedback/shares/preferences migration: all are behavior changes; recorded as gaps in
  the README for the Better Auth rewrite.
- No execution of the script by me, in any mode.

## Files to Change

- `apps/api/scripts/migrate-users/README.md` — new; banner, module map, column inventory, test ledger, known gaps.
- `apps/api/scripts/migrate-users/index.ts` — new; ported CLI, banner header, `config`-routed `DATABASE_URL` check, exported `parseArgs`/`missingEnv`.
- `apps/api/scripts/migrate-users/types.ts`, `mapping-writer.ts` — new; ports.
- `apps/api/scripts/migrate-users/source/{mongo-reader,content-filter}.ts` — new; ports, `SOURCE-SIDE` tagged.
- `apps/api/scripts/migrate-users/target/{user-migrator,thread-migrator,delete-readonly}.ts` — new; ports, `TARGET-SIDE` tagged, `Executor` type, `TODO(port)` markers.
- `apps/api/package.json` — `migrate-users` script; `mongodb` devDependency; `pnpm-lock.yaml` via pnpm.
- `apps/api/tsconfig.json:29` — drop `"scripts/**"` from `exclude`.
- `turbo.json` `globalEnv` — `MONGO_URL`, `MONGO_DB_NAME` + comment.
- `docs/self-hosting.md` (direct-`process.env` table), `apps/api/.env.example` — two env rows, flagged.
- `apps/api/tests/migration/{pglite,mongo-reader.test,content-filter.test,mapping-writer.test,thread-migrator.test,user-migrator.test,delete-readonly.test,migrate-users-cli.test}.ts` — new.
- `codev/state/pir-131_thread.md` — builder thread log.

## Risks & Alternatives Considered

- **Risk: someone runs it anyway.** Mitigations: banner in README, entry-point header
  and `printUsage()`; no runbook; README says the Better Auth writer is the follow-up.
- **Risk: the script needs the full API env** (JWT, Kalemat, Usul) because `lib/db`
  validates the whole schema at import. Documented; `.env.ci`-style placeholders satisfy
  it. Alternative — a pool that bypasses `config` — rejected: it is exactly the bypass
  the #17 guard forbids.
- **Risk: un-excluding `scripts/**` from typecheck breaks on a future script.** That is
  the point; probed clean today.
- **Risk: rewriting DB-touching tests on pglite changes what is asserted.** Kept the old
  case names and expectations one-for-one, then added rows-level checks; anything that
  cannot be preserved is ledgered in the README, not dropped.
- **Alternative: keep the old flat `scripts/lib/` layout.** Rejected — the issue asks for
  boundaries that make the source/target split obvious for the Better Auth rewrite.
- **Alternative: add Mongo vars to Zod config.** Rejected by the issue.

## Test Plan

Only static checks and the pglite suite. **The script itself is never run.**

- From `apps/api/`: `pnpm lint` (scripts are in scope; the #17 env guard must stay
  silent), `pnpm typecheck` (now covering `scripts/**`),
  `env $(grep -v '^#' .env.ci | xargs) pnpm test` (full suite, including
  `tests/migration/*`).
- Repo root: `gitleaks detect -c .gitleaks.toml`.
- Reviewer at the dev-approval gate: read `scripts/migrate-users/README.md` and the
  `TODO(port)` sites; confirm the banner wording; confirm every old test case appears
  either in a ported suite or in the README ledger; run the three commands above.
