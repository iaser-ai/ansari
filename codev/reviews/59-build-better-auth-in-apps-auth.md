# PIR Review: Build Better Auth in `apps/auth` + `packages/auth` (additive only)

Fixes #59

## Summary

Stands up [Better Auth](https://better-auth.com) as a new, self-contained, runnable
service — `apps/auth` (a standalone Express service) backed by `packages/auth`
(`@ansari/auth`: the Better Auth config, Drizzle schema, db client, and env contract).
It is **purely additive**: nothing under `apps/api/` changes, the four Better Auth tables
(`user`/`session`/`account`/`verification`) are all new, and the routes live in a separate
process. Whether the end state keeps two services or folds auth into `apps/api` is #60's
call — this PR does not foreclose either.

## Files Changed

Code + wiring (vs `develop` merge-base):

- `packages/auth/src/schema.ts` (+104) — the 4 new tables + relations (no env dependency)
- `packages/auth/src/env.ts` (+50) — lazy, memoized zod env contract (mirrors `apps/api/lib/config.ts`)
- `packages/auth/src/db.ts` (+21) — node-postgres Drizzle client
- `packages/auth/src/index.ts` (+51) — `createAuth(db?)` factory (Better Auth config)
- `packages/auth/drizzle/0000_better_auth_init.sql` (+53) — the generated migration (the deliverable)
- `packages/auth/drizzle/meta/*` (+387) — drizzle snapshot/journal
- `packages/auth/tests/auth.integration.test.ts` (+111) — pglite integration test (4 tests)
- `packages/auth/{package.json,tsconfig.json,eslint.config.mjs,drizzle.config.ts,.env.example,.gitignore}`
- `apps/auth/src/index.ts` (+64) — Express service: `toNodeHandler(auth)` at `/api/auth/*`, `/`, `/api/me`
- `apps/auth/{package.json,tsconfig.json,tsdown.config.ts,eslint.config.mjs,.env.example,.env.ci,.gitignore}`
- `turbo.json` (+26/−1) — `globalEnv` +3, `globalDependencies` +`packages/auth/src/**`
- `.github/workflows/ci.yml` (+50) — new `auth (lint, typecheck, test, build)` job
- `pnpm-lock.yaml` — new subtrees for better-auth/express/kysely (no existing-package version bumps)

Package count: **5 → 7** (`ansari-auth`, `@ansari/auth` added). `pnpm-workspace.yaml` unchanged.

## Commits

- `81b3685` [PIR #59] Add @ansari/auth: Better Auth config, schema, db client, migration, integration test
- `21173e1` [PIR #59] Add apps/auth: standalone Express service mounting Better Auth
- `3d00241` [PIR #59] Wire auth into workspace: turbo globalEnv/globalDependencies, CI auth job, lockfile
- `f8cbd9a` [PIR #59] Use placeholder-not-a-real-* convention in apps/auth/.env.ci; update thread

## Test Results

- `pnpm lint`: ✓ (5 tasks; the `apps/api` warnings are pre-existing, 0 errors)
- `pnpm typecheck`: ✓ (6 tasks)
- `pnpm build`: ✓ (4 tasks — api, frontend×2, auth)
- `pnpm test`: ✓ — the existing suite is **623 passed / 3 pre-existing skips, UNCHANGED**, plus the 4 new `@ansari/auth` integration tests
- **Manual / real-DB verification** (human-approved at the dev-approval gate): see the e2e evidence below

### End-to-end evidence — real Postgres 16 (Docker), reviewed migration applied

Booted the actual `apps/auth` service against a real Postgres (not the test's pglite), applied
the generated migration via `drizzle-kit migrate` (created exactly the 4 tables), then drove the
real HTTP path with `curl` + `psql` row counts:

| Step | Request | Result | DB |
|---|---|---|---|
| Sign-up | `POST /api/auth/sign-up/email` | `200`, returns user | `user` 0→1, `session` 0→1 (auto-session) |
| Sign-in | `POST /api/auth/sign-in/email` | `200`, `Set-Cookie: better-auth.session_token=…` | `session` →2 |
| Authed | `GET /api/me` (with cookie) | `200`, resolves session + user | — |
| Unauthed | `GET /api/me` (no cookie) | `401` | — |
| Sign-out | `POST /api/auth/sign-out` (with `Origin`) | `200 {"success":true}` | session row removed |
| Post-signout | `GET /api/me` (same cookie) | `401` | — |

Note: `curl` sign-out *without* an `Origin` header returns `403 MISSING_OR_NULL_ORIGIN` — Better
Auth's CSRF guard, not a bug (browsers always send `Origin`). The pglite integration test also
proves sign-out invalidation at the API level independently.

## The migration (highest-consequence artifact — inline for review)

Generated via `drizzle-kit generate` against `packages/auth`'s own scoped `drizzle.config.ts`
(schema `./src/schema.ts`, out `./drizzle`), which sees **only** the four new tables — it is
structurally incapable of emitting `ALTER`/`DROP` against `apps/api`'s tables. **Never `db:push`.**

```sql
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");
```

The two `ALTER TABLE … ADD CONSTRAINT` statements add foreign keys **on the new `account`/`session`
tables, referencing the new `user` table** — all three are created in this same migration. A
negative-tested scan for `ALTER`/`DROP` against existing tables
(`users`/`tokens`/`threads`/`messages`/`feedback`/`shares`/`preferences`) returns **0 hits** (the
scan was proven to catch a known-bad `users` line and to not false-positive on the singular `user`).

## Architecture Updates

Routed to **COLD** `codev/resources/arch.md` (this is current-state reference detail that #60 may
revise, not a hard invariant worth a slot in the capped HOT tier):

- Added a note under **Authentication & Authorization** describing the second, additive auth stack
  (Better Auth in `apps/auth` + `packages/auth`, its four new tables, its separate env contract),
  and the deliberate boundary from `apps/api`'s JWT auth.
- **Refined** the *"Shared packages in the cache hash"* entry with the mechanism this PR verified:
  the `workspace:*` → `globalDependencies` rule bites specifically for tasks whose `dependsOn` has
  **no `^`-prefixed entry**; a task with `^build` (etc.) already traverses internal-dependency
  package hashes and busts on their edits without a `globalDependencies` line.

The HOT `arch-critical.md` fact stays as prescriptive guidance ("list shared packages in
`globalDependencies`") — it is never *wrong* to list one, so the simplification remains safe; the
precise per-task mechanism belongs in cold.

## Lessons Learned Updates

Routed to **COLD** `codev/resources/lessons-learned.md`, under *Monorepo migration & verification
discipline* — a concrete refinement of "verify in both directions": the `globalDependencies`
necessity is **per-task**, gated by whether the task's `dependsOn` carries a `^` prefix. Test each
task you care about, not the package as a whole.

## Things to Look At During PR Review

- **`turbo.json` `globalDependencies` — the load-bearing find.** `apps/auth#typecheck` and `#lint`
  declare no `^`-prefixed dependency, so Turborepo never walks `apps/auth`'s internal deps when
  hashing them — an edit to `@ansari/auth` would otherwise replay a stale pass at an identical hash
  (the `arch-critical.md` `workspace:*` cache-hash fact, hitting a case not previously flagged).
  `#build` is already safe via its `^build`. I tested **both directions per task**; the comment in
  `turbo.json` states exactly this. Please sanity-check that reasoning.
- **Import-time side effects.** `@ansari/auth` exports a `createAuth(db?)` *factory* rather than a
  module-level `auth` singleton, so importing the library opens no DB connection / triggers no env
  validation; `apps/auth` constructs the instance at its entrypoint. (Deviates from the scaffold's
  `export const auth = createAuth()` on purpose — for testability.)
- **CSRF on state-changing routes.** `/api/auth/sign-out` requires an `Origin` header; verified with
  a browser-like request. Worth knowing when wiring `apps/frontend` later (#60 scope).
- **`.env.ci`** uses the `placeholder-not-a-real-*` convention from `apps/api/.env.ci` (gitleaks-safe).
- **`.gitleaks.toml` allowlist.** The integration test sets a deliberately fake
  `BETTER_AUTH_SECRET` on `process.env` (to satisfy `createAuth()`'s zod `min(32)` check); its
  length trips gitleaks' `generic-api-key` rule. Added one allowlist regex for that exact literal,
  with justification, following the existing test-fixture precedent (`wrong-secret-key-…`). Verified
  with `gitleaks detect` over full history → `no leaks found`. (History-scanned + `--merge` preserves
  commits, so allowlisting the literal — not just editing the line — is what actually clears it.)

## 3-way consultation outcome (single advisory pass)

All three reviewers returned **APPROVE / HIGH confidence** (gemini, codex, claude). No blocking
findings. Claude raised four non-blocking nits (two of them doc-accuracy issues that this repo's
own "fix docs everywhere" lesson mandates); I addressed all four proactively before the pr gate:

1. **`/api/me` leaked the raw session token.** `res.json(sessionData)` echoed `session.token` — the
   httpOnly cookie value — into a JS-readable body. Fixed: the route now returns
   `{ user, session: { expiresAt } }`. Re-verified against real Postgres: `200`, no `token` in body.
   (`apps/auth/src/index.ts`)
2. **Stale `ci.yml` frontend-job comment.** It claimed `@ansari/types` was "the only package under
   `packages/` that defines lint/typecheck" and "3 packages in scope, 2 tasks". `packages/auth` now
   defines both → corrected to "4 packages in scope, 4 tasks", noting auth's test/build live in the
   dedicated `auth` job.
3. **Dead CORS fallback.** `process.env.CORS_ORIGIN ?? 'http://localhost:3100'` was unreachable
   (`createAuth()` already hard-fails via `getEnv()` if it's missing). Now reads `getEnv().CORS_ORIGIN`
   — one source of truth.
4. **`globalDependencies` is global.** Added a line to the `turbo.json` comment noting the accepted
   trade-off (an auth-src edit invalidates every task's cache repo-wide, same as `globalEnv`).

Claude also independently reproduced the `globalDependencies` both-directions hash result and
confirmed the lockfile is clean (the `apps/api` drizzle-orm key gained only a `(kysely@0.29.5)` peer
suffix — same version 0.45.2). Full verdicts in `codev/projects/59-build-better-auth-in-apps-auth/`.

## Architect REQUEST_CHANGES — resolution (iter 2)

The architect's integration review (independently confirming two of codex's findings) returned
REQUEST_CHANGES with three items. All three fixed and re-verified from a **clean environment**:

**Blocker 1 — `pnpm dev` broke for a fresh contributor.** `apps/auth`'s `dev` script ran under the
root `turbo run dev`, and `createAuth()`→`getEnv()` **throws** when the auth vars are absent —
which they are for anyone following `CONTRIBUTING.md` (it only sets `apps/api` env). My original
"`pnpm dev` still starts the existing apps" check passed only because my shell already had those
vars — the project's signature failure shape (a check that passed because the tester's environment
wasn't clean). **Reproduced** it first: `node apps/auth/dist/index.mjs` with the vars unset →
`Environment validation failed`. **Fix:** `apps/auth` is now excluded from the default dev graph —
root `dev` is `turbo run dev --ui=tui --filter=!ansari-auth`, with `pnpm auth <script>` and
`pnpm dev:auth` shortcuts for running it deliberately (it needs a Postgres + migration + secrets, a
deliberate setup step, so it does not belong in the zero-config loop). `getEnv()`'s error now names
the missing vars and points at `.env.example`. **Re-verified from a shell with all three vars UNSET:**
the `pnpm dev` graph schedules `ansari-api#dev` + `ansari-frontend#dev` and **not** `ansari-auth#dev`.
Rationale for this approach over "boot inert / 503": auth genuinely can't run without external infra,
so keeping fail-fast intact (loud, clear error when you *do* run auth) while removing it from the
shared dev loop is cleaner than a perpetually-inert service cluttering the dev TUI.

**Blocker 2 — wrong Expo scheme.** `packages/auth/src/index.ts` trusted `ansari://`, but
`apps/frontend/app.json` declares `"scheme": "askansari"` — native requests carrying
`expo-origin: askansari://…` would fail origin validation in production. **Fixed** to `askansari://`.
**Coverage** (`tests/auth.http.test.ts`): asserts the resolved `auth.options.trustedOrigins` contains
`askansari://` and **not** `ansari://` — negative-tested (reverting the scheme fails the test).
Honesty note: I probed better-auth 1.6.27 and it does **not** emit a discriminating 4xx for an
untrusted *custom scheme* in process (sign-in/out with `askbad://` still return 200), so an
HTTP-level "expect 403" test would have no teeth; the config-level assertion is the deterministic
guard. The HTTP tests still exercise the real `auth.handler` path with `Origin` headers.

**Finding 3 — Secure cookie over an http trusted origin.** `defaultCookieAttributes` hardcoded
`secure: true, sameSite: 'none'`, which contradicts the `http://localhost:8081` trusted origin: a
browser silently discards a `Secure` cookie over plain HTTP, so local web login fails with no error.
**Fixed:** cookie attributes now track the transport — `secure` iff `BETTER_AUTH_URL` is https, and
`sameSite` is `'none'` only when secure (the cookie spec requires Secure with SameSite=None), else
`'lax'`. Commented with the reason. **Coverage:** HTTP-level tests assert a non-Secure/SameSite=Lax
cookie over an http baseURL and a Secure/SameSite=None cookie over an https baseURL — both
negative-tested (reverting to the hardcoded values fails the http case).

New test count: `@ansari/auth` now has **8** tests (4 API-level integration + 4 HTTP-level). Full
suite still green; `apps/api` 623 pass / 3 pre-existing skips, unchanged.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder `pir-59` → **Review Diff**
- **Run dev**: VSCode sidebar → **Run Dev**, or `afx dev pir-59`
- **Full path against real Postgres**:
  1. `docker run -d -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=ansari_auth_dev -p 55432:5432 postgres:16`
  2. `cp packages/auth/.env.example packages/auth/.env` and point `DATABASE_URL` at `:55432`
  3. `pnpm --filter @ansari/auth db:migrate` (creates the 4 tables)
  4. `cp apps/auth/.env.example apps/auth/.env` (same DB URL), then `pnpm dev:auth` (or `pnpm auth dev`)
     — `apps/auth` is intentionally NOT part of `pnpm dev`; run it explicitly
  5. `curl` the sign-up → sign-in → `/api/me` → sign-out path (send `-H "Origin: http://localhost:3100"` on POSTs)
- **Automated**: `pnpm --filter @ansari/auth test` (pglite, no Docker needed)

## Notes for #60 (do not act on here)

- **`user` vs `users`.** Better Auth's table is literally named `user` — a SQL reserved word (hence
  the quoting everywhere) — and it now sits one character away from `apps/api`'s `users` table. This
  is a readability hazard when #60 consolidates schemas, and should be a deliberate decision there
  rather than an inherited default.
- **CI check not yet enforced.** The new `auth (lint, typecheck, test, build)` job runs but is **not**
  in `develop`'s required-checks list (admin-only to edit), so it can fail while PRs merge anyway.
  Making it required is tracked as an admin step in #50. A comment above the job in `ci.yml` says so.
- **Two db layers.** `@ansari/auth` reads the same `DATABASE_URL` as `apps/api` but shares no Drizzle
  code — folded db+env into `packages/auth` deliberately so #60 can relocate/merge the auth stack
  wholesale rather than untangle a competing `packages/db`.
