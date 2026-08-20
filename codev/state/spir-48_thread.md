# spir-48 — Standardise to apps/ + packages/ monorepo layout, introduce Turborepo

## 2026-08-20 — Specify phase, survey

Started strict-mode SPIR on issue #48. No spec on disk at start, so this is a
fresh spec (not a refinement of an architect-authored one). The issue body has
no `Baked Decisions` heading, but it does carry an explicit `## Constraints`
section — I am treating those as architect-fixed and copying them verbatim into
the spec's Constraints.

### Repo survey findings

Confirmed the issue's list of path consumers, and found several it does **not**
mention. Full inventory now lives in the spec; the ones that matter most:

- **`frontend/Dockerfile.web` + `frontend/railway.toml` + `frontend/Caddyfile`** —
  the issue names only the backend Dockerfile. The frontend has the exact same
  root-context/hardcoded-path shape (`COPY frontend/package.json frontend/`,
  `COPY --from=builder /repo/frontend/dist`, `dockerfilePath = "frontend/Dockerfile.web"`).
  Missing these would break the frontend web deploy silently.
- **`.github/dependabot.yml`** — `directory: "/backend"`. Not in the issue's list.
  There are also **9 open dependabot PRs** against `dependabot/npm_and_yarn/backend/*`
  that will all conflict with the move. Coordination question for the architect.
- **Railway dashboard config-file-path** is an *out-of-repo* setting pointing at
  `backend/railway.toml` / `frontend/railway.toml`. Moving those files breaks deploy
  until a human updates Railway. Cannot be fixed by this PR — must be a release note.
- **`release-doc.test.ts` is bidirectionally coupled** to RELEASE.md: it asserts the
  doc *contains* the literal strings `backend/railway.toml`,
  `backend/drizzle/0000_baseline.sql`, `backend/sentry.server.config.ts`. So doc and
  test must change together, in both directions. It also asserts every `pnpm <script>`
  named in RELEASE.md exists in **backend's** package.json — which becomes wrong the
  moment the doc starts quoting root-level turbo scripts.
- **`RELEASE.md:69`** has `(cd .. && pnpm install) && pnpm build` — run from
  `backend/`. After the move that `cd ..` lands in `apps/`, not the root.
- **Docker + workspace packages**: `apps/backend/Dockerfile` does
  `pnpm install --frozen-lockfile --filter ansari-backend` after copying only the
  root manifests + backend's package.json. Once backend devDepends on
  `@ansari/tsconfig` etc. via `workspace:*`, that install fails unless the
  Dockerfile also copies `packages/*/package.json`. Not mentioned in the issue.
- **Frontend has no `dev` and no `build` script** (`start` / `build:web`). The
  acceptance criterion "`pnpm dev` starts both apps" therefore needs a new
  frontend `dev` script, and `build` needs a decision about what frontend build means.
- **eslint/tsconfig overlap is genuinely thin.** Backend = Next flat config +
  FlatCompat + a bespoke `no-restricted-properties` env guard; frontend =
  `eslint-config-expo/flat` in CJS. They share almost nothing but ignore globs.
  I flagged the hollow-package risk in the spec rather than pretending otherwise.
- `backend/tests/eslint-env-guard.test.ts` lints through the *real* backend config,
  so it doubles as the regression net proving the eslint extraction didn't defang
  the config-bypass guard. Useful — called out in Test Scenarios.

Next: write spec, signal SPEC_DRAFTED, let porch run the 3-way consultation.

## 2026-08-20 — Architect scope decision + spec review iteration 1

**Architect decision received:** land as ONE PR — directory move + Turborepo together,
not staged across two PRs. Rationale: a staged split would leave `turbo.json` briefly
encoding a layout that is about to change.

My Approach 2 was already commits-within-one-PR, so no change of direction — but the
spec did not say so unambiguously, and one of my listed approaches (defer Turbo to a
follow-up) was exactly the two-PR staging now excluded. Recorded the decision verbatim
in Constraints, reframed the whole Solution Approaches axis as *commit granularity
inside one PR*, and marked two orderings explicitly RULED OUT (turbo-first, and
defer-turbo-to-a-follow-up) so planning cannot re-propose them. Noted that
move-then-turbo already satisfies the architect's rationale directly: `turbo.json`
does not exist until the tree is already in its final layout.

### Consultation results (iteration 1)

- **gemini: APPROVE** (HIGH confidence), no key issues.
- **codex: REQUEST_CHANGES** (HIGH confidence), 5 issues — all legitimate, all fixed.
- **claude: still running** at time of writing.

Codex's catches worth recording:

1. **Factual error, mine.** I wrote "61 test files"; the real number is 66. My
   `ls backend/tests/*.test.ts` glob silently missed the `api/`, `lib/`, and
   `migration/` subdirectories. Fixed — and rewritten to be *baseline-relative*
   (compare test-name sets against `develop`, not counts), since a raw count cannot
   distinguish a renamed test from one that stopped being collected. Good reminder that
   a non-recursive glob is a silent undercount.
2. **Real internal contradiction.** Approach 2 promised green-at-every-commit while the
   risk table advised moving and editing in separate commits — a move-only commit
   cannot be green, since every path consumer breaks. Resolved in favour of
   move+path-fix as one indivisible commit, and corrected the underlying premise: git
   records no rename, it *infers* one at diff time from content similarity, so
   move+edit in one commit preserves blame fine for edits this small. The old
   mitigation was cargo-culted.
3. **Vague criteria made testable.** "Whatever the apps genuinely share" was not a
   testable bar for config extraction. Now: eslint violation-sets identical before/after
   (machine-readable formatter, diffed), and `tsc --showConfig` fully-resolved options
   unchanged or every diff individually justified.
4. **CI task matrix pinned explicitly** rather than "exercises both apps". Note this
   surfaced that **frontend `build` in CI is a genuinely new check** — it does not run
   today — which is required if `pnpm build` is to actually mean "both apps".
5. **Critical open questions promoted to decided defaults** so planning is not blocked,
   each with reasoning plus an explicit "if overridden, here's what changes" note. They
   stay visible as builder calls the architect can cheaply override at spec-approval,
   rather than being silently absorbed into Constraints.

Next: fold in claude's review when it lands, then commit and reach spec-approval gate.

## 2026-08-20 — Layout deviation: apps/backend -> apps/api

Human raised a forward-looking objection I had not considered: `apps/auth` is planned
(auth extracted out of the backend). Asked whether `apps/backend` still makes sense.

It does not. **"backend" is a TIER name; "auth" is a DOMAIN name** — different axes.
Once both exist, `apps/backend` carries no information, because auth is backend code
too. (It is already slightly wrong today: the backend ships a React admin UI at
`src/app/admin/analytics/page.tsx`.)

Grounded the recommendation by measuring the actual split surface rather than guessing:
auth would take 7 of 20 routes (`users/{login,logout,me,refresh_token,register}` +
`request_password_reset` + `reset_password`) plus all 8 files of `lib/auth/`. What
remains is the product engine — threads, chat completions, facilitator, tools, admin
stats, feedback, share, preferences. `apps/api` names that accurately and pairs with
`apps/auth` on one axis.

**Decision (human): `backend/` → `apps/api`, package `ansari-backend` → `ansari-api`.
Frontend unchanged** — one client, no announced sibling, so renaming it is churn
without a driver (and `apps/mobile` would be wrong: it ships web via Caddy).

The decisive argument was cost asymmetry, not naming taste: every path consumer a
rename touches is *already* being rewritten by this PR, so renaming now is near-free,
while renaming later costs a second full sweep **plus a second Railway dashboard
coordination** — the one High/High out-of-repo risk in this spec. And `apps/api` is a
good name even if the auth split never happens, so it is not a speculative bet.

This **supersedes issue #48's baked target layout**, which says `apps/backend`
verbatim. I did not apply it silently — notified the architect via `afx send`
(delivered to `main`) with the rationale and an explicit offer to revert.

Note for whoever plans this: **the rename is strictly a rename.** No route, module, or
boundary moves. Extracting `apps/auth` is explicitly out of scope; this spec only makes
the layout it lands into coherent. Added a risk row for a missed `--filter` call site
silently no-opping, since the package rename touches every filter in CI and both
Dockerfiles.

Also baked the shared-package naming that was left implicit: **`@ansari/*` scoped**
(`@ansari/eslint-config`, `@ansari/tsconfig`, `@ansari/types`) while the apps stay flat
and unscoped. Decided default, cheap to override at the gate.

Still waiting on the claude consultation (gemini APPROVE, codex REQUEST_CHANGES already
folded in).

## 2026-08-20 — Rename confirmed; two scope additions from the architect

Rename **confirmed by the human**: `apps/api` / `ansari-api`, frontend unchanged. The
architect is updating issue #48's target layout so the issue and this spec agree — so
the deviation is now reconciled at the source, not carried as a standing exception.

### Addition 1 — dependabot.yml gets fixed properly, not repointed

The architect independently confirmed what I had logged: `.github/dependabot.yml` is
**already stale before this PR touches it**. It declares `directory: "/backend"` under a
comment asserting "`backend/package-lock.json` is the single lockfile (there is
deliberately no root `package.json`)" — both false since the pnpm migration.

Now in scope: correct directories covering `apps/*` **and** `packages/*`, and delete the
false comment outright. Recorded it as a Current-State fact too, since "already wrong
independent of this change" is exactly the kind of context that gets lost and then
re-litigated during review.

This resolves my Open Question 6 in the opposite direction from my recommendation — I
had proposed fixing the path here and proposing the coverage expansion separately. The
architect chose to expand now. Fine, and cheaper in one pass.

**One correction I fed back rather than transcribing blindly:** the architect wrote
"pnpm ecosystem". Dependabot has **no `pnpm` value** for `package-ecosystem` — pnpm is
handled *by* the `npm` ecosystem. Writing `package-ecosystem: "pnpm"` would be an invalid
config. Recorded in Constraints that the `npm` key stays and is correct, so the plan
cannot mis-transcribe the instruction into a broken file. Left the per-package-directory
vs glob-`directories:` mechanism to the plan, since that is a HOW detail that needs
verifying against actual Dependabot behaviour for pnpm workspaces.

### Addition 2 — acceptance criteria must cover BOTH Dockerfiles and BOTH railway.toml

Both Dockerfiles were already covered. **Both `railway.toml` were not** — they were only
in Test Scenarios, not Success Criteria. Promoted them, and while doing so made the
assertion sharper than "the paths are updated":

> a `watchPatterns` glob that matches nothing **fails silently** — it does not error, it
> just stops triggering deploys.

So the criterion demands asserting the globs against the real tree rather than eyeballing
them. Same failure mode as the doc-consistency tests: the dangerous outcome here is not a
loud break, it is a config that looks right and quietly stops working. Also added
`apps/frontend/Caddyfile` (copied by path in the serve stage) since it travels with the
frontend image.

Added a risk row for the expected burst of Dependabot PRs against newly-watched
`apps/frontend` and `packages/*`, so it is not mistaken for misconfiguration.

Claude consultation still has not landed (gemini APPROVE, codex REQUEST_CHANGES folded
in). Proceeding to the spec gate as directed rather than holding for it.

## 2026-08-20 — Claude consultation (iteration 1): REQUEST_CHANGES, all folded in

Landed after ~20 min. Verdict REQUEST_CHANGES, HIGH confidence — and it earned it. It
verified claims against the actual repo rather than reading the spec on its own terms,
which is why it found something both gemini (APPROVE) and codex missed.

**The real catch: an internal contradiction between a baked constraint and an acceptance
criterion.** The constraint says model `gen:types` as a Turbo dependency "not a shell
`&&`". But `apps/frontend/Dockerfile.web` invokes `build:web` *directly* after
`pnpm install --frozen-lockfile --filter ansari-frontend`. I verified the consequence:
the root `package.json` has **no** dependencies or devDependencies today, so once `turbo`
is added there, a `--filter`-scoped install will not have it — nothing in that image can
traverse the task graph. Delete the `&&` and `expo export` runs with no
`uniwind-types.d.ts`, breaking the `docker build -f apps/frontend/Dockerfile.web .`
criterion.

Resolution written into Constraints, and it turns on reading the constraint's *letter*:
it names **`typecheck`**, not `build:web`. So `typecheck` drops its `&&` and gains a real
`dependsOn` edge (constraint satisfied), `build` gains the edge too, and **`build:web`
keeps its internal chain** so the container path still works without Turbo. The
redundancy is deliberate and documented as such — `gen:types` is idempotent and the Turbo
path makes the second call a cache hit — so a later reader does not "clean it up" and
silently re-break the image. Also flagged that CI's frontend typecheck step carries a
comment explicitly relying on the `&&`, which must be updated rather than invalidated.

**Second catch worth recording: `test:coverage` was unmodelled.** CI runs
`test:coverage`, not `test`. I had listed it in the CI matrix but never modelled it as a
Turbo task — so "CI runs through Turborepo" was unsatisfiable as written. Now requires a
`test:coverage` task with `outputs: ["coverage/**"]`.

**Third: `gen:types` must declare `uniwind-types.d.ts` as an output.** Subtle and it
interacts with the FULL TURBO criterion — the file is gitignored, so on a warm cache
Turbo skips `gen:types`, and if it is not a declared output there is nothing to restore.
Green cold, broken warm. Added a criterion to verify by deleting it with the cache warm.

**Fourth: my Docker mitigation was half a fix.** I had said copy `packages/*/package.json`.
Necessary, not sufficient — if an app's tsconfig extends a shared base, `next build` needs
the package *contents*, so `COPY packages packages` too. The half-fix yields an install
that succeeds and a build that fails later, which is the worst shape.

**Fifth: `.github/PULL_REQUEST_TEMPLATE.md` is an unenumerated path consumer** (lines 16
and 26: run checks "from `backend/`", "`backend/.env.ci`"). Verified and added. That is
now the *second* consumer my own inventory missed after the frontend trio — the
"no stale path survives" scan is doing real work as a backstop.

**A correction to my own reasoning, which I took rather than defended.** I had framed the
two doc-consistency tests as at risk of *silently passing while asserting nothing*. Claude
pointed out that both `readFileSync` their target at module load, so a stale `'..'`
throws ENOENT and takes the suite down **loudly**. I checked: correct. The realistic risk
is a builder seeing the loud failure and patching the path just far enough to go green
without confirming it points at the true repo root. Rewrote the Test Scenarios
calibration to say exactly that, and kept the negative check as belt-and-braces rather
than as the sole net. Over-claiming a risk misdirects review attention as surely as
under-claiming it.

Two items claude raised were **already fixed** before its review landed: the 61-vs-66
test count (codex caught it too; now baseline-relative against `develop`) and the stale
dependabot comment (architect scope addition). It reviewed a snapshot from before those
commits.

Structure: claude independently confirmed the spec matches the *delivered* SPIR template
from `@cluesmith/codev` v3.3.1, and that the longer 21-heading shape in
`codev/specs/4-*.md` is a superseded template, not a miss.

Next: commit, then `porch next` — expecting the spec-approval gate.

## 2026-08-20 — SPEC APPROVED; all open questions closed

Human approved at the `spec-approval` gate. Ran
`porch approve 48 spec-approval --a-human-explicitly-approved-this`.

**All three of my decided defaults confirmed without override:** thin shared config with
the env guard staying in the api app (human agreed the guard's locality beats maximal
sharing); `packages/types` as placeholder with no consumer; frontend `build` aliasing
`build:web`. On the third, the architect supplied a better argument than mine: `expo
export` **already runs in `Dockerfile.web` at deploy time**, so adding it to CI moves an
existing failure mode earlier rather than inventing a new one. Worth remembering — I had
framed it as "new cost, worth paying"; the truer framing is "existing cost, paid earlier".

Architect calls on the non-blocking items, all folded in and marked resolved: two-job CI
split with `turbo run --filter` (my recommendation); no `.turbo` caching in this PR; keep
the root convenience aliases with `backend` → `api`; write `packages/README.md`.

**Item 7 promoted to a HARD success criterion**, at the architect's explicit direction —
`pnpm dev` multiplexing Expo under Turbo must be *run and verified*, not inferred from
processes starting. Both apps confirmed up, and the Expo TUI confirmed still responsive to
`i`/`a`/`w`/`r`. The reasoning is sound and worth internalising: turbo multiplexes child
stdio, and an Expo TUI that has lost keypress handling **still looks like a healthy
running process**. Degraded interactivity is an acceptable outcome; *undocumented*
degradation is not — it must land in CONTRIBUTING.md as prose. "Folklore is not
acceptable."

Spec now has **no open questions**. Nothing is left for the plan to re-litigate.

Two of my findings were confirmed as errors in the architect's own issue text: the
`Dockerfile.web` catch was a flaw in the baked constraint they wrote, and my correction
that the doc tests fail loudly rather than silently was right — the issue body had that
wrong. They asked me to keep flagging contradictory baked decisions. Noting it here so
the disposition survives a context refresh: **raising contradictions is wanted, not
tolerated.**

Next: plan phase.

## 2026-08-20 — Plan drafted (6 phases)

Wrote `codev/plans/48-standardise-to-apps-packages-m.md`. Structure follows the approved
Approach 2 — ordered commits in ONE PR.

Phases: (1) move + full path-consumer rewrite, (2) Turborepo task graph + root scripts,
(3) shared tsconfig, (4) shared eslint-config, (5) types package + packages README,
(6) repo-wide acceptance sweep + fresh-clone walkthrough.

Decisions worth recording:

- **Phase 1 is deliberately large and indivisible.** A move-only commit cannot be green,
  and `release-doc.test.ts` asserts on RELEASE.md's *contents*, so the doc must move with
  the code. I state that explicitly in the plan so a reviewer does not read the size as
  sloppiness and try to split it.
- **Docs are touched twice on purpose** — Phase 1 for paths (while per-app `--filter`
  scripts still exist), Phase 2 for the root turbo scripts. Doing it once would leave one
  commit describing a repo that does not exist.
- **Split the shared packages one-per-phase** (3/4/5) rather than one lumped phase. They
  are the only phases containing design judgement rather than mechanical rewriting, so
  isolating them lets a reviewer see them as such. Each has a behaviour-preservation test
  rather than a "looks fine" check.
- **Phase 3 carries the Docker `COPY packages packages` fix**, because it is the first
  phase to introduce a `workspace:` dep. Ordering matters here — putting it later would
  leave Phase 3's own Docker acceptance failing.
- **Phase 6 exists** because the highest-value criteria (no stale path, both images, both
  railway globs, fresh-clone walkthrough) are inherently cross-cutting and cannot be
  evaluated before everything lands.

Two implementation details I surfaced while planning that were not in the spec:

1. **`apps/frontend/eslint.config.js` must become `.mjs`.** The frontend package has no
   `"type": "module"`, so the current CJS file cannot `require()` an ESM shared config.
   Added the rename to Phase 4 plus a check that ESLint still resolves it — a silently
   unresolved config reports zero violations, which looks exactly like passing.
2. **`apps/frontend/tsconfig.json` needs an `extends` ARRAY** (`["expo/tsconfig.base",
   "@ansari/tsconfig/base.json"]`) since it already extends the Expo base. Order matters;
   the plan says verify the resolved output rather than assume it.

Also carried the `build:web` `&&` resolution into the plan as an explicit "do not simplify
this" note plus a `package.json` comment, because the failure mode is a future reader
"finishing" the constraint and silently breaking the frontend image.

Next: `porch done`, which triggers the 3-way plan consultation.

## 2026-08-20 — Plan review iteration 1: gemini APPROVE, codex REQUEST_CHANGES

Codex returned 7 issues, all legitimate, all fixed. Gemini APPROVE, no issues. Claude
still running.

**The one that mattered: I introduced a regression in my own Phase 1.** I wrote "repoint
all five scripts at `--filter ansari-api`". Verified against the tree: root `lint` and
`typecheck` are `pnpm -r` **today** — repo-wide. Repointing them at a single filter would
have silently narrowed repo-wide checks to one app, in the very phase whose entire purpose
is to change paths and nothing else. Phase 1 now spells out per-script scope preservation
and says why, and there is a risk row plus a verification step for it.

Sharp irony worth recording: the spec's opening complaint is that root scripts lie about
their scope. My plan would have made one lie harder.

Other six:

2. **CI would never have linted the shared packages.** Two-job split filtered by app
   excludes `packages/*`. Fixed with dependency-closure filters (`--filter <app>...`,
   note the trailing dots) so Phases 3–4 packages are covered. But `@ansari/types` has
   **no consumer by design**, so a closure filter can never reach it — Phase 5 now adds
   explicit coverage, verified from the CI job log rather than the workflow file.
3. **`@ansari/types` was underspecified.** Naming `lint`/`typecheck` scripts does not make
   them run: under pnpm's strict layout nothing is hoisted, so the package needs its own
   `typescript` (via `catalog:` so it cannot drift from the pinned ~6.0.3), `eslint`, and
   an eslint config file. Otherwise both scripts fail "command not found" on first CI run.
   Also noted the inverse for `packages/tsconfig`: it ships only JSON and deliberately has
   **no** scripts — so nobody adds empty ones to make it "appear" in task output.
4. **`@ansari/eslint-config` needs `"type": "module"` and an explicit `exports` map.**
   Under pnpm an undeclared subpath fails to resolve, and ESLint's failure mode for an
   unresolved config is to report **nothing** — indistinguishable from passing. Same
   silent-green shape as the other traps in this project.
5. **Settled the dependabot mechanism instead of deferring it.** Decided: a single
   `directory: "/"` entry, because there is exactly one lockfile and the npm ecosystem
   resolves the pnpm workspace from it — and critically it also covers the **root
   package.json, which is where turbo lives**. Per-app-only entries would leave Turborepo
   unwatched. Kept a documented fallback to explicit per-directory entries with a
   verification step, since I could not confirm the workspace-resolution behaviour offline.
6. **RELEASE.md scoping decided rather than left implicit.** `release-doc.test.ts` asserts
   every `pnpm <script>` in the doc exists in `apps/api/package.json`. Phase 2 rewrites
   docs to root turbo scripts — but RELEASE.md is a runbook executed *from the api app*,
   so converting it would make the assertion semantically wrong even where it still passes
   by coincidence of overlapping script names. Decision: RELEASE.md stays app-scoped, and
   the test gains a comment stating that assumption explicitly.
7. **Phase 6 now compares against `develop`, not just adjacent phases.** Adjacent-phase
   diffs can each be clean while drift accumulates across Phases 3–5. Only the end-to-end
   comparison satisfies the spec's behaviour-preservation criterion.

## 2026-08-20 — Claude plan review: the CI-breaking env omission

Claude REQUEST_CHANGES. **Most serious finding of the project so far**, and it verified the
whole chain against the tree rather than reasoning from the plan's own text:

`turbo.json` declared **no `env` at all**. `apps/api/lib/config.ts` `getEnv()` does
`envSchema.safeParse(process.env)`; the schema hard-requires DATABASE_URL, JWT_SECRET,
KALEMAT_API_KEY, USUL_API_TOKEN. CI injects `.env.ci` via `>> "$GITHUB_ENV"` — as **process
env**, not a `.env` file Next would load. Turbo 2.x defaults to **strict env mode**, where
task children see only declared vars. So Phase 2 moving CI onto `turbo run` would have
filtered them out and failed the Zod parse — breaking Phase 2's own "CI green" criterion.

I verified each link myself before accepting. All confirmed.

Fixed with per-task `env` **derived from the Zod schema, not hand-guessed**, `.env.ci` in
`inputs`, and — the part that matters — an acceptance check that supplies the values **as
process env**, reproducing CI's mechanism. Running the same tasks via `pnpm --filter` would
pass regardless and prove nothing, which is exactly how this would have escaped.

Accepted separately (not folded in) the **cache-correctness** half: undeclared env is
excluded from the task hash, and `Dockerfile.web` bakes `EXPO_PUBLIC_*` into the bundle at
export time — so a cached frontend build restored under a different API URL ships wrong
config **while reporting a cache hit**. True regardless of what the strict-mode default is,
so it deserves its own fix and its own check.

Other findings, all accepted:

- **`interactive: true` exists on Turbo 2.x `dev` tasks** for stdin-needing tasks. My plan
  went straight to "document the Expo TUI caveat" — pre-accepting a workaround without
  trying the mechanism built to prevent the problem. Fair hit on the plan's posture.
- **`.dockerignore` needs `**/.turbo`**, not `.turbo` — that file uses `**/.next` style, and
  a bare entry matches only the repo root, leaving `apps/*/.turbo` in both build contexts.
  Root `.gitignore` keeps the bare form, which is correct since git matches at any depth.
- **Two live path consumers I missed**: `scripts/grant-admin.ts:8` ("Usage (from backend/)"
  — a *live production runbook* instruction) and `codev/resources/arch.md:11`. The second is
  the important one: arch.md is a **living** governance doc, not one of the historical
  records the spec exempts. Phase 6's exclusion list now names `codev/resources/**` as
  explicitly NOT exempt, inline where the sweep is defined — an exclusion reading "codev/"
  would have waved the real drift straight through.
- Both `railway.toml` **header comments** name the dashboard config path — the exact string
  an operator pastes into Railway.
- `packages/tsconfig` `exports` must omit or include `./base.json`, or the extends chain
  silently breaks.
- Enumerate intentional test-title renames in the PR, since the baseline is a name set.

RELEASE.md scoping was already fixed from codex's round — claude reviewed a pre-fix
snapshot. Both reviewers found it independently and both agreed app-scoped is right.

**Pattern across this whole project worth naming:** nearly every serious defect found has
the same shape — *it looks like passing*. Unresolved eslint config reports nothing. Warm
cache skips codegen with nothing to restore. Cached build ships wrong baked env. Filter that
matches no package. watchPatterns glob that matches nothing. Undercounted test glob. That is
the failure mode this codebase's tooling produces, and it is why so many acceptance criteria
here are phrased as "assert against the tree" rather than "confirm it passes".

## 2026-08-20 — PLAN APPROVED; corrections applied; starting Phase 1

Human approved. Ran `porch approve 48 plan-approval --a-human-explicitly-approved-this`.

**A correction I got wrong and the architect caught.** I wrote that `lib/config.ts`
Zod-parses `process.env` **at import**. It does not. `config` is a **getter object**
(`config.ts:~104`) whose accessors call a memoized `getEnv()` (`config.ts:~77`). Verified.
The turbo `env` fix is unchanged, but the lazy shape makes the failure **more** insidious,
not less: it surfaces only on code paths that actually touch `config`, so one task can pass
while a later one fails on the same missing var. Plan's mechanism sentence rewritten so the
next reader does not hunt for an import-time parse that isn't there.

**Architect promoted the cache-hash half to headline**, and sharpened it in a way I had
missed: my criterion said "change a value → task re-runs". That is **not sufficient** — a
criterion asserting only that a cache hit occurs would *pass on the broken behaviour*,
because the broken build hits cache too. Now: record the task hash (`--dry=json`), change a
declared value, and assert the **hash itself differs**. That is the only check that
separates working from broken here.

Also: `grant-admin.ts:9` still says `npx tsx` — npm-era wording the pnpm migration missed
(self-hosting.md already uses `pnpm exec tsx`). Added, plus a note that
`release-doc.test.ts`'s npm-drift regex matches `npm run|ci|install|test` and therefore does
**not** catch `npx`, so this class of drift is unguarded.

### A near-miss in my own process, worth recording

While applying these edits I discovered that an **earlier python block had silently failed**
— it died on a shell quoting error (`unmatched "`), so the env acceptance criteria and risk
rows I believed I had committed were never in the file. I only caught it because a later
`grep` for my own text returned nothing.

What made it dangerous: right after that failure I ran a validation that printed
plausible-looking counts for *other* strings, and I read that as confirmation. It was
confirmation of the edits that had landed, not the ones that hadn't.

This is the **exact pattern this project keeps producing** — it looked like passing. I have
been writing acceptance criteria against that failure mode all week and then walked into it
myself. Practical rule for the implement phase: after every batch edit, grep for the text I
believe I just wrote, and never treat an adjacent green signal as evidence for a different
change.

### Standing instruction from the architect for implement

Confirmed my read: nearly every serious defect here has the shape **it looks like passing**.
Where a criterion can be satisfied by something that merely reports success, rewrite it to
assert against the tree. Do not report a phase complete on a green run I have not confirmed
was actually exercising the thing.

Report at dev-approval, or sooner if something needs a human call.

## 2026-08-20 — PHASE 1 COMPLETE (commit 9122d40)

Move + full path-consumer rewrite, one atomic commit, 198 files. Every acceptance
criterion verified — including both Docker images, which I initially reported as
UNVERIFIED rather than assumed (daemon was down; the user started it).

### Verified
- Suite vs `develop` baseline: 623 passed / 3 pending / 0 failed, **identical**.
  Test-name set diff = exactly ONE entry, the intentional rename the plan predicted
  (`...exist in backend/package.json` → `...exist in apps/api/package.json`).
- **Both negative checks fired correctly.** Renaming `apps/api/railway.toml` made
  release-doc fail with the exact right message; removing an error phrase from
  `startup-checks.ts` made self-hosting-docs fail. Both files restored, diff empty.
- Root `lint` and `typecheck` both report `Scope: 2 of 3 workspace projects` — the
  repo-wide scope I nearly regressed is intact.
- `next build` green with `.env.ci`.
- `git log --follow` walks through the rename into pre-move history on both apps.
- **Both Docker images build from the repo root**, and I confirmed they *exercised* the
  work rather than trivially succeeding: api ran `--filter ansari-api` (the renamed
  package), sourced `apps/api/.env.ci`, and compiled routes; frontend ran `gen:types`
  (uniwind artifacts) then `expo export`, and the Caddy stage copied
  `/repo/apps/frontend/dist`.
- Static: every Dockerfile COPY source exists; both railway `dockerfilePath` targets
  exist; every `watchPatterns` glob matches real paths (none silently matches nothing).

### The rename bit back, and the doc test caught it

`release-doc.test.ts` extracts endpoints with `/\/api\/[...]/`. Naming the app `api`
means `apps/api/railway.toml` now **contains the substring `/api/`** — so it was
extracted as an endpoint `/api/railway` and failed against a route that does not exist.
A direct consequence of the rename decision, invisible until the suite ran.

Fixed with a `(?<!apps)` lookbehind plus a comment explaining the collision so nobody
deletes it later. Worth noting this is the *good* failure mode for once: loud, immediate,
and precisely located. The doc test earned its keep.

### A contract I deliberately did NOT rename

`apps/api/src/app/api/health/route.ts` returns `service: 'ansari-backend'`. The stale-path
scan flagged it, but it is a **public API response contract** that spec 3 pins explicitly
("frontend and runbooks key on it") — not a path. Renaming it would be a behaviour change,
which this phase forbids. Left as-is; `RELEASE.md` and `docs/self-hosting.md` document that
same value and are also correct unchanged.

### Process note

The Bash tool caps foreground commands at 10 minutes; the first `docker build` attempt was
killed at that ceiling (exit 143) and was NOT failing. Re-ran both in background. Worth
remembering for Phase 3, which touches both Dockerfiles again.

Next: Phase 2 — Turborepo task graph and root scripts, incl. the `env` declarations that
would otherwise have broken CI, and the hard `pnpm dev` / Expo TUI verification.
