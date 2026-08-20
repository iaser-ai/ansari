# Plan 48 — Rebuttals, Plan iteration 1

| Reviewer | Verdict | Disposition |
|---|---|---|
| gemini | APPROVE | No issues raised. |
| codex | REQUEST_CHANGES | 7 points — **all accepted and fixed.** |
| claude | REQUEST_CHANGES | 5 issues + 2 smaller — **all accepted and fixed**, 1 already fixed before the review landed. |

Nothing rejected. One finding (claude #1) would have broken CI at Phase 2, and one
(codex #1) was a regression I had written into my own plan.

---

## codex

### 1. Phase 2 does not preserve root-script semantics — `lint`/`typecheck` must stay repo-wide
**Accepted — my regression, fixed.** Verified against the tree: root `lint` and `typecheck`
are `pnpm -r` **today**. My Phase 1 said "repoint all five scripts at `--filter ansari-api`",
which would have silently narrowed repo-wide checks to a single app — inside the one phase
whose entire purpose is to change paths and nothing else.

Phase 1 now specifies scope per script (`dev`/`test`/`build` → `--filter ansari-api`;
`lint`/`typecheck` → **stay `pnpm -r`**) and says why. Added a risk row and a verification
step confirming both apps appear in the output.

The irony is worth stating: the spec's opening complaint is that root scripts lie about their
scope. My plan would have made one of those lies harder to spot.

### 2. CI stays app-filtered; no phase adds shared-package `lint`/`typecheck`
**Accepted — fixed.** The two-job split filtered by app excludes `packages/*` entirely, so the
spec's required CI matrix was nominally claimed and never satisfied. CI now uses
**dependency-closure filters** (`--filter <app>...`, note the trailing dots) so Phases 3–4
packages are covered.

`@ansari/types` has **no consumer by design**, so a closure filter can never reach it — Phase 5
adds explicit coverage, verified **from the CI job log**, not from reading the workflow file.

### 3. Phase 5 underspecifies `@ansari/types`
**Accepted — fixed.** Naming `lint`/`typecheck` scripts does not make them run: under pnpm's
strict layout nothing is hoisted, so the package needs its own `devDependencies` —
`typescript` (via `catalog:`, so it cannot drift from the pinned `~6.0.3`), `eslint`, and
`@ansari/eslint-config` — plus its own `eslint.config.mjs`. Otherwise both scripts fail
"command not found" the first time CI runs them.

Documented the inverse for `packages/tsconfig`: it ships only JSON and deliberately has **no**
scripts, so nobody adds empty ones to make it "appear" in task output.

### 4. Phase 4's ESM design is incomplete
**Accepted — fixed.** `@ansari/eslint-config` now requires `"type": "module"` (or `.mjs`) and
an explicit `exports` map defining the imported subpath, plus `eslint` in its own dev/peer
dependencies. Noted the failure mode: under pnpm an undeclared subpath fails to resolve, and
**ESLint's response to an unresolved config is to report nothing** — indistinguishable from a
clean lint.

### 5. Dependabot mechanism deferred; root `package.json` coverage for Turborepo unaddressed
**Accepted — settled in the plan rather than deferred.** Decided: a **single `directory: "/"`
entry**, because there is exactly one lockfile and the npm ecosystem resolves the pnpm
workspace from it. The point I had missed is the one codex named — a root entry also covers the
**root `package.json`, which is where `turbo` lives**; per-app entries would leave Turborepo
unwatched.

Kept an explicit fallback to per-directory entries plus a verification step, since pnpm
workspace resolution behaviour could not be confirmed offline. Which was used, and why, gets
recorded in the PR description.

### 6. Phase 2 rewrites RELEASE.md but does not update `release-doc.test.ts`
**Accepted — fixed by deciding the scoping explicitly.** `release-doc.test.ts` asserts every
`pnpm <script>` named in RELEASE.md exists in `apps/api/package.json`. RELEASE.md is a runbook
executed *from the api app*, so rewriting it to root `turbo` commands would make that assertion
semantically wrong even where it still passed by coincidence of overlapping script names.

Decision now written into Phase 2: **RELEASE.md stays app-scoped**, and the test gains a
comment stating that assumption explicitly rather than leaving it implicit. (Claude
independently raised the same point — see claude #5.)

### 7. Final behaviour-preservation should compare `develop` vs. the assembled branch
**Accepted — fixed.** Adjacent-phase diffs can each be clean while drift accumulates across
Phases 3–5. Phase 6 now re-runs both the ESLint violation-set diff and the `tsc --showConfig`
diff against **`develop`**, comparing the assembled branch tip.

---

## claude

### 1. `turbo.json` declares no `env` — this breaks CI's api build
**Accepted. The most serious finding in this round, and it would have failed Phase 2's own
"CI green" criterion.** Verified every link in the chain:

- `apps/api/lib/config.ts` — `getEnv()` calls `envSchema.safeParse(process.env)`.
- The Zod schema's hard-required vars: `DATABASE_URL`, `JWT_SECRET`, `KALEMAT_API_KEY`,
  `USUL_API_TOKEN` (plus optional ones `.env.ci` supplies).
- CI injects them via `>> "$GITHUB_ENV"` — as **process env**, not as a `.env` file Next would
  load itself.
- Turborepo 2.x defaults to **strict env mode**: task children see only declared vars.

So moving CI onto `turbo run ... --filter ansari-api` with no `env` declared filters those out
and the Zod parse throws.

Fixed: per-task `env` declarations **derived from the Zod schema rather than hand-guessed**,
`apps/api/.env.ci` added to the api `build`/`test:coverage` `inputs`, and an acceptance check
that runs the api tasks with values supplied **as process env** — reproducing CI's injection
mechanism, since running them via `pnpm --filter` would pass regardless and prove nothing.

Also accepted the **independent cache-correctness** point: undeclared env is excluded from the
task hash, and `Dockerfile.web` bakes `EXPO_PUBLIC_*` into the bundle at export time, so a
cached frontend `build` restored under a different `EXPO_PUBLIC_API_V2_URL` would ship wrong
configuration **while reporting a cache hit**. Added a "change a declared value → task re-runs"
acceptance check. This holds whether or not strict mode is the active default, which is why it
is fixed as its own concern rather than folded into the first.

### 2. Phase 2 pre-accepts Expo TUI degradation without trying `interactive: true`
**Accepted — fixed, and a fair criticism of the plan's posture.** Turborepo 2.x has an
`interactive: true` task option for exactly this. The plan had gone straight to "document the
caveat", which pre-accepts a workaround without using the mechanism built to prevent the
problem. `dev` now sets `interactive: true`, and documenting the caveat is explicitly the
**fallback**, not the first stop.

### 3. `.dockerignore` needs `**/.turbo`, not `.turbo`
**Accepted — fixed.** That file uses `**/.next`, `**/dist`, `**/coverage`; a bare `.turbo`
matches only the repo root and would leave `apps/api/.turbo` and `apps/frontend/.turbo` in both
build contexts. Root `.gitignore` keeps the bare entry, which is correct — git matches at any
depth.

### 4. Two live path consumers missing; `codev/resources/**` must not be exempt
**Accepted — both verified and fixed.**
- `apps/api/scripts/grant-admin.ts:8` — `Usage (from backend/):`. This is the instruction an
  operator follows during the admin-bootstrap step of a release, so a stale path here
  misdirects a **live production runbook**.
- `codev/resources/arch.md:11` — references `backend/lib/auth/` and `backend/lib/db/users.ts`.
  A **living** governance doc, not one of the historical records the spec exempts.

Phase 6's exclusion list now names `codev/resources/**` as explicitly **not** exempt, stated
inline where the sweep is defined — an exclusion that read "`codev/`" would wave the real drift
straight through.

Also accepted: **both `railway.toml` header comments** name the dashboard config-file path
("point the service's config file path at `backend/railway.toml`"). That exact string is what an
operator pastes into Railway, making it the most consequential comment in either file.

### 5. RELEASE.md's script coupling decided by omission
**Accepted — already fixed** before this review landed, in response to codex #6. Claude reviewed
a pre-fix snapshot. Both reviewers independently identified it and both reached the same
conclusion I did (app-scoped is correct); the fix was making it explicit rather than incidental,
which is what the spec asked for.

### 6. `packages/tsconfig/package.json` must omit `exports` or export `./base.json`
**Accepted — fixed.** TypeScript resolves `extends: "@ansari/tsconfig/base.json"` through node
resolution, so an `exports` map lacking that entry silently breaks the extends chain.

### 7. Enumerate intentional test-title renames
**Accepted — fixed.** Phase 1 legitimately renames at least one title (`'only references package
scripts that exist in backend/package.json'` → `apps/api/...`). Since the baseline is a
test-*name* set, a rename appears as one removal plus one addition; the plan now requires these
be listed up front in the PR, or the diff invites exactly the hand-waving the baseline exists to
prevent.
