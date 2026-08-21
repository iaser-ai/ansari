# Architecture

<!-- STARTER: replace the "_No architecture documented yet._" line below with your
project's architecture as it emerges (usually during a review phase). Delete this
comment once the file has real content. -->

This document evolves as the project grows. Update it during the review phase of any work that introduces or changes architectural patterns.

## Authentication & Authorization

JWT auth over Postgres (Drizzle), in `apps/api/lib/auth/` and `apps/api/lib/db/users.ts`. Established by spec 4 (auth hardening).

**Tokens.** HS256 JWTs carrying `{ user_id, type, session_version }`. Three types: `access` (~2h), `refresh` (~90d), `reset` (~1h). Stored SHA-256-hashed in the `tokens` table. Secret + expiries come only from validated `config.auth` (Zod-checked, `min(32)` secret, positive-int expiries) — never `process.env` directly. `issueTokenPair(userId, sessionVersion, exec)` is the single generate-and-store site (login/register/refresh).

**Session version (uniform revocation).** `users.session_version` is embedded in every issued token and compared on validation (`authenticateRequest`, `validateRefreshToken`); a mismatch → 401. Password reset and logout each `bumpSessionVersion` (sql `+1`) inside their transaction, so all previously-issued tokens become stale at once. Callers capture the version at authorization time and pass it into issuance — issuance never re-reads it — so a reset racing a refresh cannot mint a currently-valid pair.

**Rotation & reuse.** Refresh rotation is transactional: re-confirm the token (`lookupRefreshToken`, inside the tx), `markTokenRotated`, then `issueTokenPair` — all on the tx `exec`. A rotated token stays valid for a 60s grace window (issue #34: concurrent refreshes both succeed); replayed after grace but before natural expiry it is detected as `reuse` (reject + log). `deleteExpiredTokens` deletes only past-natural-expiry rows (retains rotated-but-unexpired rows so reuse stays detectable); wired as a low-probability opportunistic sweep on token issuance (no cron).

**Admin & system identity.** Admin = the durable `users.is_admin` flag (`requireAdmin`), never an email match. `ADMIN_EMAILS` reserves those addresses at registration and asserts (production boot, build-phase-guarded) that each already exists as an admin. System endpoints (`v2/mcp-complete`, `v1/chat/completions`) resolve their identity via `users.system_key` (`getOrCreateSystemUser`), never email; the `@system.ansari.chat` domain is reserved at registration. Reserved-address registration returns the **same** 409 as an existing-account conflict, placed before the strength check (anti-oracle).

**Feedback IDOR.** `findMessageInOwnedThread(messageId, threadId, userId)` scopes through `messages ⋈ threads WHERE threads.user_id = caller`; nonexistent / foreign-owned / mismatched targets all return an identical 404.

**Second auth stack — Better Auth (spec 59, additive).** A separate, self-contained Better Auth stack lives in `packages/auth` (`@ansari/auth`: Better Auth config, its own Drizzle schema, node-postgres client, and a lazy zod env contract) and `apps/auth` (a standalone Express service mounting `toNodeHandler(auth)` at `/api/auth/*`). It shares the physical database (`DATABASE_URL`) with `apps/api` but only through **new** tables — `user`/`session`/`account`/`verification` (note: Better Auth's singular `user`, distinct from `apps/api`'s `users`) — and shares no Drizzle code. `@ansari/auth` exports a `createAuth(db?)` factory (no import-time singleton, so importing it opens no connection); `apps/auth` constructs the instance at its entrypoint. This is deliberately additive: it changes nothing about the JWT auth above. Whether the two stacks stay separate or consolidate is spec 60's decision; db+env were folded into `packages/auth` (rather than a separate `packages/db`) specifically so 60 can relocate or merge the whole stack as one unit.

**Deploy runbook (order matters).** `drizzle-kit generate` → review SQL (never `db:push`) → apply migration → run `scripts/grant-admin.ts <email>` for each configured admin (creates-or-promotes with a bcrypt password, revokes prior tokens) → deploy (prod boot asserts admin existence and fails fast otherwise). Inspect for a pre-registered reserved address before applying the conditional system-row backfill.

## Monorepo layout, build & deploy

The repo is a pnpm workspace of `apps/*` + `packages/*`, driven by Turborepo.

**Layout & task running.** Root tasks fan out through one cached Turborepo task graph; `pnpm dev` starts both apps. Target a single package with `pnpm api <script>` / `pnpm frontend <script>`, or by running from inside the app directory.

**Docker build context.** Both images build from the repo root, never from the app directory — the pnpm workspace needs the root lockfile and both images `COPY packages packages`. The Dockerfile invocation is always `-f apps/<app>/Dockerfile …` with `.` as the build context.

**Strict env mode.** Turborepo runs in strict env mode: a variable not declared in `turbo.json` is invisible to tasks and absent from the cache key. Adding an env var means adding it to `globalEnv`, derived by four methods — the Zod schema in `apps/api/lib/config.ts`, a static `process.env.X` grep, a dynamic `process.env[` grep followed to its call-site literals, and the documented surface (`docs/self-hosting.md`, `.env.example`) for variables consumed by dependencies. Each method catches variables the others miss.

**Shared packages in the cache hash.** A `workspace:*` dependency does not put a package's contents into a consumer's cache hash. Shared packages must also be listed in `globalDependencies`, or a warm cache replays stale results against changed shared config. **Refinement (spec 59):** this bites per-task, gated by the `^` prefix in `dependsOn`. A task with a `^`-prefixed dependency (e.g. `build`'s `^build`) *does* traverse its internal dependencies' package hashes and busts on their edits without a `globalDependencies` line; a task with only un-prefixed deps (this repo's `typecheck` → `["gen:types"]`, `lint` → none) does **not** traverse them and needs the `globalDependencies` entry. Verified per-task in both directions: `apps/auth#typecheck` needed `packages/auth/src/**` listed to bust on `@ansari/auth` edits, while `apps/auth#build` busted either way. Listing a shared package is never wrong, so the prescriptive rule stands; this explains why some tasks appear "already covered".

**Railway deployment.** Deploy configuration lives in the Railway dashboard, not in `apps/*/railway.toml` — the tomls are the reviewable git record only. Watch paths must include `packages/**`, since both images copy it.

**Health endpoint.** `/api/health` returns `service: 'ansari-backend'` — a pinned public contract (spec 3), unrelated to the `apps/api` directory name. It performs a live DB ping with a 2s cap, so a cold process can legitimately 503 on its first request.
