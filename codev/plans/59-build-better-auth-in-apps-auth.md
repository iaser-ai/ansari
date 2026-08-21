# PIR Plan: Build Better Auth in `apps/auth` + `packages/auth` (additive only)

Issue: #59 — Build Better Auth in apps/auth + packages/auth, fully runnable (additive only)

## Understanding

Stand up [Better Auth](https://better-auth.com) as a **new, standalone, runnable service**
without touching how anyone authenticates today. The work adapts a Better-T-Stack scaffold at
`/Users/amrmohamed/repos/testing/ansari` — taking only its Better Auth wiring, leaving the demo
content (oRPC, AI SDK chat, shadcn, `web`/`native` apps) behind.

The claim "additive" holds because nothing collides:

| | Existing (`apps/api`) | Better Auth (new) |
|---|---|---|
| Tables | `users`, `tokens`, `threads`, `messages`, `feedback`, `shares`, `preferences` | `user`, `session`, `account`, `verification` — all new |
| Routes | `/api/v2/*`, `/api/health` | `/api/auth/*` in a **separate service** |
| Code | `apps/api/lib/auth/**` | `packages/auth`, `apps/auth` — new paths |

**Hard boundary (do not modify):** `apps/api/lib/auth/**`, `apps/api/db/schema/**`,
`apps/api/src/app/api/v2/users/**`, `scripts/grant-admin.ts`, any existing auth test. If a change
there looks necessary, **stop and report** — that is #60's scope. Proof obligation:
`git diff --stat develop...HEAD -- apps/api/` must be empty at the end.

### The decisive constraint: package count 5 → 7

The current workspace has **exactly 5 packages** (verified via `pnpm ls -r --depth -1`):
`@ansari/eslint-config`, `@ansari/tsconfig`, `@ansari/types`, `ansari-api`, `ansari-frontend`.
The acceptance bar says the count goes **5 → 7** — i.e. **add exactly two**. The issue title names
them: `apps/auth` + `packages/auth`.

That rules out transplanting the scaffold's three packages (`packages/db`, `packages/env`,
`packages/auth`) as-is, which would give 5 → 9. Instead the db schema/client and the env contract
are **folded into `packages/auth`**, and `apps/auth` is the runnable service. This directly answers
design decisions #1 and #2 below.

## Proposed Change

Two new workspace members, self-contained, importing nothing from `apps/api`.

### `packages/auth` — the Better Auth library (the "brain")

Owns the whole Better Auth configuration, its Drizzle schema, its db client, its env contract, and
its migration tooling. Files:

- `src/schema.ts` — the four new tables (`user`, `session`, `account`, `verification`) + relations,
  adapted verbatim from the scaffold's `packages/db/src/schema/auth.ts` (correct Better Auth shape).
- `src/env.ts` — a small **zod**-validated env module (see decision #2). Validates
  `DATABASE_URL`, `BETTER_AUTH_SECRET` (min 32), `BETTER_AUTH_URL` (url), `CORS_ORIGIN` (url),
  `NODE_ENV`. Fail-fast on first use, mirroring `apps/api/lib/config.ts`.
- `src/db.ts` — `createDb()` → `drizzle(env.DATABASE_URL, { schema })` over `node-postgres`.
- `src/index.ts` — `createAuth()` returning `betterAuth({ ... })`: drizzle adapter (`provider: "pg"`),
  `emailAndPassword.enabled`, `trustedOrigins: [env.CORS_ORIGIN, "ansari://", "exp://",
  "http://localhost:8081"]`, `expo()` plugin (decision #4), `secret`/`baseURL` from env, and the
  scaffold's `advanced.defaultCookieAttributes` (`sameSite:"none", secure, httpOnly`). Exports
  `auth` and the schema.
- `drizzle.config.ts` — schema `./src/schema.ts`, out `./drizzle`, dialect postgresql, url from env.
- `package.json` — `type: module`, exports raw `./src/*.ts` (bundled by the consumer, matching the
  scaffold), scripts `lint`/`typecheck`/`db:generate`/`db:migrate` (**no `db:push`**), deps pinned
  explicitly (no `catalog:` — see decision under "pnpm-workspace.yaml"). Uses `@ansari/tsconfig` +
  `@ansari/eslint-config` (our repo's shared config), **not** the scaffold's `@ansari/config`.
- `tsconfig.json`, `eslint.config.mjs` — mirror `packages/types` (the working precedent for a
  lint+typecheck-only package in this repo).
- `.env.example` — the four vars, documented, no real values.

### `apps/auth` — the runnable service (the "face")

A minimal Express service that mounts Better Auth and nothing else:

- `src/index.ts` — `express()`, `cors({ origin, credentials:true })`, then
  `app.all("/api/auth{/*path}", toNodeHandler(auth))` (from `better-auth/node`), a `GET /` health
  route, and a `GET /api/me` route that calls `auth.api.getSession({ headers })` to **prove an
  authenticated request works** end to end. Listens on a port (env `PORT`, default e.g. 3100 to
  avoid colliding with apps/api's dev port).
- `package.json` — `dev` (`tsx watch`), `build` (`tsdown`, `alwaysBundle: [/@ansari\/.*/]` so the
  raw-TS workspace deps are compiled in), `start`, `lint`, `typecheck`. Deps: `@ansari/auth`
  (workspace:*), `better-auth`, `express`, `cors`, pinned explicitly.
- `tsconfig.json` extends `@ansari/tsconfig/base.json`; `tsdown.config.ts`; `eslint.config.mjs`.
- `.env.example`.

### Root wiring (all outside the hard boundary)

- **`turbo.json` `globalEnv`** — add `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `CORS_ORIGIN`
  (decision #3). `DATABASE_URL`/`NODE_ENV`/`PORT` are already present. Strict env mode means an
  undeclared var is invisible to tasks **and absent from the cache key** (arch-critical).
- **`turbo.json` `globalDependencies`** — evaluate adding `packages/auth/src/**` so an edit to the
  auth library busts `apps/auth`'s cached typecheck/build (a `workspace:*` dep's file contents are
  **not** in the consumer's hash — arch-critical). Verify the hash moves in both directions before
  and after; only keep the entry if the negative test proves it's needed given how `apps/auth`
  consumes the raw `.ts` exports.
- **`pnpm-lock.yaml`** — will change (expected and correct). Review the diff for unexpected
  transitive bumps to existing packages; the goal is only new subtrees for better-auth + express.
- **`pnpm-workspace.yaml`** — **unchanged** (`apps/*` + `packages/*` already match).
- **`.github/workflows/ci.yml`** — see the CI risk below; likely add coverage so `apps/auth` +
  `packages/auth` are actually lint/typecheck/built in CI (they fall outside both existing job
  filters). This file is **not** in the hard boundary, so editing it is allowed.

### Design decisions (flagged, per the issue)

1. **Where the Drizzle schema/client live → inside `packages/auth`, not a separate `packages/db`.**
   Driven by the 5 → 7 constraint (a separate db package makes it 5 → 8+) and by additivity: a
   second parallel db *package* reading the same `DATABASE_URL` would create a competing db layer
   and pre-empt #60's consolidation call. Keeping schema+client private to `packages/auth` makes the
   whole auth stack one self-contained unit that #60 can move or merge wholesale. The auth schema
   still shares the physical database with `apps/api` (same `DATABASE_URL`), but only via **new
   tables** — no shared Drizzle code, no shared schema module.
2. **Env handling → a self-contained zod module in `packages/auth`, not `@t3-oss/env-core`.**
   `apps/api` validates env with a zod schema (`lib/config.ts`); matching that keeps the repo
   consistent and avoids adding `@t3-oss/env-core` (which, since the workspace catalog can't grow —
   see below — would have to be pinned anyway). The env is consumed inside `packages/auth`
   (`createAuth`/`createDb`), so the contract lives there; `apps/auth` just imports the configured
   `auth`. `apps/api` is not refactored.
3. **New env vars added to `turbo.json` `globalEnv`** — `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`,
   `CORS_ORIGIN`. Non-negotiable under strict env mode.
4. **`trustedOrigins` + `expo()` plugin kept** — `ansari://`, `exp://`, `http://localhost:8081` and
   the `@better-auth/expo` plugin, directly relevant to `apps/frontend` (Expo). Carried over verbatim.
5. **No `catalog:` references / `pnpm-workspace.yaml` stays unchanged → pin versions explicitly.**
   The scaffold references `catalog:` for `better-auth`, `zod`, `dotenv`, `@better-auth/expo`, but
   our workspace catalog only pins `typescript`/`eslint`/`typescript-eslint`, and the acceptance bar
   forbids changing `pnpm-workspace.yaml`. So every new dep is pinned directly. To minimise
   transitive churn, align shared deps with `apps/api` where they overlap: `drizzle-orm ^0.45.2`,
   `drizzle-kit ^0.31.8`, `pg ^8.17.2`, `zod ^4.3.5`; `better-auth`/`@better-auth/expo` pinned to the
   scaffold's tested `1.6.27`.

## Files to Change

New:
- `packages/auth/package.json`, `tsconfig.json`, `eslint.config.mjs`, `.gitignore`, `.env.example`,
  `drizzle.config.ts`
- `packages/auth/src/schema.ts`, `src/env.ts`, `src/db.ts`, `src/index.ts`
- `packages/auth/drizzle/0000_*.sql` (generated migration — the artifact this issue delivers)
- `apps/auth/package.json`, `tsconfig.json`, `tsdown.config.ts`, `eslint.config.mjs`,
  `.gitignore`, `.env.example`
- `apps/auth/src/index.ts`

Modified (all outside the hard boundary):
- `turbo.json` — `globalEnv` (+3 vars); possibly `globalDependencies` (+`packages/auth/src/**`)
- `pnpm-lock.yaml` — regenerated by `pnpm install`
- `.github/workflows/ci.yml` — add CI coverage for the two new members (pending; see risk)

Explicitly **not** changed: anything under `apps/api/`, `scripts/grant-admin.ts`,
`pnpm-workspace.yaml`.

## Risks & Alternatives Considered

- **Risk — migration accidentally touching existing tables.** Mitigation: `packages/auth` has its
  own `drizzle.config.ts` scoped to its own `src/schema.ts` and its own `out` dir, so
  `drizzle-kit generate` can only see the four new tables. **Gate:** manually inspect the generated
  SQL; it must be `CREATE TABLE` only. A single `ALTER`/`DROP` against `users`/`tokens`/`threads`/
  `preferences`/`feedback`/`messages`/`shares` → stop and report. **Never `db:push`** (the
  scaffold's README says to; that instruction does not survive the import — arch-critical).
- **Risk — CI does not actually exercise the new code.** The `api` job filters `ansari-api...` and
  the `frontend` job filters `ansari-frontend...` + `./packages/*` (lint/typecheck only). `apps/auth`
  sits in **neither** closure, so "all three CI checks green" could be green while never building the
  new service — the exact "green run, no signal" failure arch/lessons warn about. Mitigation: add
  explicit CI coverage (an `auth` job, or extend an existing job's filter) that lint/typecheck/builds
  `apps/auth` + `packages/auth`, and give `packages/auth` `lint`/`typecheck` scripts so the frontend
  job's `./packages/*` filter picks it up too. **This is the main open design question for the
  reviewer** — options: (a) new dedicated `auth` job (keeps existing jobs untouched, symmetric with
  `api`); (b) extend filters. Leaning (a).
- **Risk — stale Turbo cache against changed shared auth code.** `apps/auth` consumes `packages/auth`
  via `workspace:*`, whose file contents are not in the consumer's hash. Mitigation + gate: add
  `packages/auth/src/**` to `globalDependencies` only after a negative test proves the hash moves on
  edit with it and does not without it (loud-over-quiet).
- **Risk — unexpected transitive dependency bumps.** better-auth pulls a dependency subtree.
  Mitigation: review `pnpm-lock.yaml` diff; pinning shared deps to `apps/api`'s versions keeps the
  blast radius to genuinely-new subtrees. If an existing package's resolved version moves, stop and
  report.
- **Risk — port / dev collision.** `apps/auth` default port set away from `apps/api`'s (e.g. 3100),
  overridable via `PORT`, so `pnpm dev` starting both is additive, not a conflict.
- **Alternative — mount Better Auth inside `apps/api` via `toNextJsHandler`** (a catch-all route).
  Rejected: it modifies the running API and breaches the additive boundary. A standalone service is
  what keeps this additive; #60 decides the end-state topology.
- **Alternative — reuse the scaffold's `@t3-oss/env-core` + separate `packages/env`/`packages/db`.**
  Rejected: violates 5 → 7 and adds deps/patterns inconsistent with `apps/api`.

## Test Plan

The bar is **"runnable end to end," not "it boots."** Report observed evidence (row counts, cookie
present, response codes), per lessons-critical: a service that boots while auth silently no-ops looks
identical to one that works.

**Setup (local):** run a local Postgres (Docker `postgres:16` or equivalent), point `DATABASE_URL`
at it, set `BETTER_AUTH_SECRET` (≥32 chars), `BETTER_AUTH_URL=http://localhost:3100`,
`CORS_ORIGIN=http://localhost:3100`. Apply the **generated** migration to that local DB
(`drizzle-kit migrate`) — applying to any shared DB is a human deploy step, not part of this issue.
Start `apps/auth`.

**Exercise the real path (curl, capturing the cookie jar):**
- Sign-up: `POST /api/auth/sign-up/email` `{name,email,password}` → expect 200 and **one new row in
  `user`** (`SELECT count(*) FROM "user"`).
- Sign-in: `POST /api/auth/sign-in/email` → expect 200, **one new row in `session`**, and a session
  cookie set on the response.
- Authenticated request: `GET /api/me` with the cookie → expect 200 and the signed-in user
  (proves `getSession` resolves the cookie).
- Sign-out: `POST /api/auth/sign-out` with the cookie → then `GET /api/me` again → expect
  unauthenticated (session invalidated; `session` row gone/expired).

Record actual response codes, the `Set-Cookie` header presence, and the before/after row counts in
the review — not "tests pass."

**Migration proof:**
- `drizzle-kit generate` diff is `CREATE TABLE` only; grep it for `ALTER`/`DROP` against existing
  tables → must be zero (report the grep result, negative-tested).

**Additive proof:**
- `git diff --stat develop...HEAD -- apps/api/` → empty.
- Existing auth tests pass untouched (`pnpm api test`).

**Workspace integration:**
- Package count before/after: `pnpm ls -r --depth -1` → **5 → 7** (show both).
- `pnpm lint`, `pnpm typecheck`, `pnpm build` (root, unfiltered) all pass **including** the new
  members. `pnpm build`/test load env the CI way (strict env).
- `pnpm test` — full existing suite still green, unchanged.
- `pnpm dev` still starts the existing apps.
- All three CI checks green (after the CI-coverage change above).
- `pnpm-lock.yaml` diff reviewed; `pnpm-workspace.yaml` unchanged.
