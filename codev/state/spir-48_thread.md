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

## 2026-08-20 — Phase 1 review: a merge-blocking operator action nobody had flagged

gemini APPROVE (2 minor) | codex REQUEST_CHANGES (2) | claude REQUEST_CHANGES (1 blocking
+ 2 minor). All accepted, one deliberately deferred with reasons.

### The blocking find — and it could have bitten this very PR

Renaming the CI job `backend:` → `api:` means the emitted check is now
`api (lint, typecheck, test, build)`. **Required status checks are matched by NAME.** If
`develop`'s branch protection still requires the old `backend (...)` name, that check can
never report again and **PRs sit unmergeable waiting on a job that no longer exists** —
this PR potentially being the first victim of its own change.

codex found the stale RELEASE.md string; claude found *why it matters*. I had updated the
CI job name without once thinking about branch protection consuming that name externally.

Tried to confirm enforcement: `branches/develop/protection` → 404, `rulesets` → `[]`.
The empty-but-readable rulesets suggests no protection is enforced, but a 404 is also what
insufficient token scope returns, so it is genuinely undetermined from here. Cost asymmetry
decides it — documenting is free, discovering at merge time is not.

Recorded as a **one-time operator action** in RELEASE.md itself (not just a review file),
sitting directly under the check list, stating that checks match by name and only repo
admin can fix it.

**Claude's structural point is the one to remember:** the stale-path grep *cannot* catch
this, because the scan pattern requires a trailing `/` and this is a check NAME, not a path.
My sweep was always going to report clean here. Same shape as everything else in this
project.

### My own verification was broken, and gemini caught the consequence

The architect had me fix `grant-admin.ts:9`'s header comment. gemini found line **118** —
the runtime `console.error` an operator actually sees — still printed
`Usage: npx tsx ...`. The comment is documentation; that line is output. Better catch.

Worse: **my own scan had reported "NONE — clean" on that exact file.** Reproduced it —
`grep -rnE '(^|[^p])\bnpm (run|ci|install|test)\b|\bnpx '` returns rc=1 on grant-admin.ts
while plain `grep -n 'npx'` matches line 118. The compound alternation silently failed.

So the check looked like it passed and was not checking. That is precisely the failure
mode I have been writing acceptance criteria against all project, arriving in my own
tooling. **Rule adopted: prefer several simple greps I have validated individually over one
clever compound regex.** A verification pattern is itself code and deserves a negative test
— I should confirm a scan catches a known-bad line before trusting it to report clean.

### Also fixed
- PR template's four `npm run *` lines → pnpm (two lines from edits this phase made).
- `docs/self-hosting.md:168` `npx` → `pnpm exec` (line 93 of the same doc already said
  `pnpm exec` — internal inconsistency).
- `next.config.ts:5` comment `npm run lint` → `pnpm lint`.

### Deferred deliberately
`eslint-env-guard.test.ts:55`'s test TITLE contains `npm run lint`. Not fixed: renaming it
perturbs the test-name baseline that Phase 1's central verification depends on, for
cosmetic gain. Pre-existing, not path-related, not operator-facing. Recorded, not skipped.

### Confirmed correct non-change
`/api/health`'s `service: 'ansari-backend'` stays — public contract pinned by spec 3.
Claude rightly notes the phase criterion is worded absolutely, so the carve-out goes in the
PR description or Phase 6's sweep will re-litigate it.

Suite after all fixes: 623 passed / 3 pending / 0 failed; name-set diff still exactly the
one intentional rename.

## 2026-08-20 — Phase 1 iteration 2: gemini APPROVE, codex REQUEST_CHANGES (3)

Codex found three, all real, all fixed. Claude still running.

**1. Lockfile drift — and this was a miss against my OWN plan.** My phase-1 commit carried
three dependency-graph changes unrelated to the move: `@babel/parser` 7.27.0 → 7.29.8 and
two added `deprecated:` lines on `@xmldom/xmldom`. These came from running plain
`pnpm install` (non-frozen) after changing the workspace globs — pnpm re-resolved and
quietly updated the graph.

My plan has a risk row that says, verbatim, *"Review the pnpm-lock.yaml diff for entries
unrelated to turbo and the new packages."* I wrote that mitigation and then did not perform
it. Reverted the three hunks; the lockfile now differs from pre-phase-1 by **exactly the
two importer renames** (`backend:` → `apps/api:`, `frontend:` → `apps/frontend:`) and
nothing else. Confirmed `pnpm install --frozen-lockfile` still succeeds, so the reverted
lockfile is genuinely consistent rather than merely smaller.

Lesson: in a relocation phase, `pnpm install` is not a neutral operation. Use
`--frozen-lockfile` where possible, and diff the lockfile before committing — a
dependency bump smuggled inside a "pure move" commit is invisible in review and impossible
to attribute later.

**2. `apps/api/.env.ci:4`** — comment documented local verification as
`env $(grep -v '^#' .env.ci | xargs) npm test`. npm-era, violates the pnpm-only constraint.
Now `pnpm test`. (Comments are stripped by the `grep -v '^#'` loader, so this is
documentation-only and cannot affect the env contract.)

**3. `RELEASE.md:15` — self-inflicted, and pleasingly ironic.** The operator-action note I
added *last round* to document the CI-check rename itself contained a literal top-level
`backend/` ("until the `backend/` → `apps/api/` move"), which the phase's own stale-path
scan flags. Reworded to "until the monorepo restructure renamed the CI job to `api`".

I introduced a stale-path violation inside the note warning about a stale-name violation.
Worth remembering: **prose written to describe a migration is itself subject to the
migration's scan.** Explaining an old path and using an old path look identical to grep.

Re-verified after all three: suite 623 passed / 3 pending / 0 failed; name-set diff still
exactly the one intentional rename; stale-path scan clean across all live files (remaining
hits are only in the exempt codev/{specs,plans,projects,state} records).

## 2026-08-20 — Merge blocker resolved a better way; my inference was wrong

**Architect correction, and I was wrong on the facts.** I concluded that an empty
`rulesets` array implied no protection enforced. Wrong: **classic branch protection and
rulesets are separate systems**, and the classic one is on. The 404 on
`/branches/develop/protection` was an *authorization* 404, not an absence — the account is
`admin:false` on the repo.

Verified directly on an endpoint non-admins CAN read:

```
repos/iaser-ai/ansari/branches/develop
  protected: true
  required checks: ["backend (lint, typecheck, test, build)", "gitleaks (secret scan)"]
```

So the blocker was **real, not hypothetical** — my rename would have made a required check
stop reporting and left this PR unmergeable. Note `frontend (lint, typecheck)` is *not*
required, only backend + gitleaks.

Lesson: "endpoint returned 404/empty" is not evidence of absence when the token may lack
scope. Find a field the current identity can actually read before inferring anything.

**My "no PR can fix this" framing was also wrong, and the human took the better option.**
A job's **ID** and its **emitted name** are independent:

```yaml
jobs:
  api:                                            # id renamed, internal only
    name: backend (lint, typecheck, test, build)  # emitted name UNCHANGED
```

Zero admin coordination, no unmergeable window. Applied, with a comment above `name:`
explaining why it is deliberately stale and warning that "fixing" it re-arms the blocker —
otherwise Phase 6 or a future contributor silently breaks merging. Rewrote the RELEASE.md
note from "required one-time action before merge" to "deferred follow-up", since this PR no
longer renames the check; leaving the old instruction would have told an operator to do
something now unnecessary and actively harmful if done alone.

Context I could not see: **10 open dependabot PRs all emit the `backend (...)` check**, so
a required-name swap had no safe ordering — it would have stranded either this PR or all
ten. Human decision: **leave them**; repointing dependabot.yml obsoletes them and they
re-open against the new path. Recorded in the plan as an explicit Phase 6 non-defect.

### I made the same mistake twice in ten minutes

Rewriting the RELEASE.md note, I again wrote a literal `backend/` ("moved `backend/` to
`apps/api/`") — the *exact* violation I had recorded a lesson about one commit earlier.
Fixed ("moved the backend app under `apps/api/`").

Then my verification scan for it was ALSO wrong — `grep "backend/\|frontend/"` matches
inside `apps/frontend/`, so it reported dozens of false hits and I nearly mis-read live
files as dirty.

**So: three scans on this project have now reported a wrong answer** — the compound-regex
one that reported clean on grant-admin.ts, the too-loose one just now, and an exclusion
filter (`^\./codev/`) that silently matched nothing because paths came back without the
`./` prefix.

Discipline adopted and written into Phase 6 as an acceptance criterion: **negative-test
every scan before trusting it** — prove it matches a known-bad line AND does not match a
known-good near-miss, then report hit counts (total / exempt / live) rather than asserting
"clean". Did exactly that for the final scan: validated 4 cases (MATCH, no-match, MATCH,
no-match), then reported 124 total hits, 124 under codev/, **0 live-file hits**.

A verification pattern is code. Untested code is not evidence.

Suite after all of this: 623 passed / 3 pending / 0 failed; name-set diff still exactly the
one intentional rename. CI YAML validated: ids api/frontend/gitleaks, emitted names match
develop's required checks exactly.

## 2026-08-20 — PHASE 1 APPROVED (iteration 2 closed)

**gemini APPROVE | codex REQUEST_CHANGES (3, all fixed) | claude APPROVE.** Phase 1 done.

Claude re-ran the verification itself rather than trusting the thread — suite, lint,
typecheck, both Docker images, git history, both negative checks, stale-path scan. It
specifically checked the four easiest misses: root-script scope not narrowed (at runtime,
not by reading package.json), the `(?<!apps)` lookbehind, the CI name freeze consistent
across ci.yml + RELEASE.md + plan, and the `ansari-backend` carve-out against spec 3's
actual wording.

### The wedged consultation — a process failure worth keeping

The first claude iter-2 run sat **2h39m without writing a single byte**. The other two
reviews from the same batch finished in ~4 minutes. Killed it (SIGTERM ignored — itself a
sign it was stuck, not working; SIGKILL on both PIDs worked) and relaunched. The relaunch
APPROVED in **5 minutes**.

**My liveness check was the problem.** I kept confirming "producer ALIVE" from a live PID
and reporting that as a satisfiable wait. A process producing nothing for 2.5 hours is a
hung process wearing a healthy costume. I had a known-good baseline sitting right there —
two sibling reviews that finished in 4 minutes — and never compared against it until asked.

Same shape as everything else here: **the check reported alive and looked like passing,
while not establishing the thing it existed to establish.**

Rule: liveness means *progress*, not existence. Check bytes-written and elapsed-vs-baseline
from the same batch, not just `pgrep`. A wait needs a deadline derived from evidence.

### Non-blocking notes folded in

1. **Dependabot coverage is the one criterion unverifiable from the repo.** Promoted to an
   explicit Phase 6 post-merge checkpoint with the per-directory fallback ready. A config
   that resolves nothing produces no error, just silence.
2. **Carve-outs written down** in `48-phase_1-PR-NOTES.md` rather than left in my head:
   the `ansari-backend` health-contract exception, the deliberately-stale CI check name,
   the ten dependabot PRs that must not be closed, and the two post-merge operator actions.
   Phase 6's criteria are worded absolutely, so these must be written or the sweep
   re-litigates them.
3. Cosmetic: PR template now consistently uses bare `pnpm <script>`.

### Phase 2 prep (done while the tree stayed frozen)

`turbo.json` drafted in scratchpad. The `env` list is **derived, not guessed**: 23 vars
parsed from the Zod schema + **7 read directly outside it** (FRONTEND_URL, MARKETMAKER_URL,
NEXT_RUNTIME, RAILWAY_ENVIRONMENT, RESEND_API_KEY, SENTRY_DSN, VITEST) + the frontend's 11
EXPO_PUBLIC_* (wildcard). Parsing only the schema would have shipped an env list missing
SENTRY_DSN and RESEND_API_KEY — builds succeed, and a changed DSN restores a stale cached
bundle. Exactly the poisoning case.

Turbo 2.10.11 is current: `"tasks"` (not `"pipeline"`), and `interactive: true` exists.

## 2026-08-20 — Phase 1 iteration 3: a doc bug that would run the WRONG APP

gemini APPROVE. **codex REQUEST_CHANGES — one genuine find**, and a good one.

The setup blocks in README.md and CONTRIBUTING.md `cd apps/api` and then present frontend
commands without ever returning to the repo root:

- **CONTRIBUTING.md** then said `cd apps/frontend` — from inside `apps/api` that resolves
  to `apps/api/apps/frontend`, which does not exist. **Fails loudly.**
- **README.md** was worse: it just said "# Frontend (from apps/frontend/)" with no `cd` at
  all, so `pnpm start` would run **the api's** `start` script (`next start`) while the
  reader believes they are starting Expo. **Fails silently, on the wrong app.**

Both shapes predate the move (it was `cd backend` → `cd frontend` before, equally broken),
but Phase 1 owns "docs a fresh clone can follow verbatim", so they are mine now.

Fixed by making each block explicitly root-relative and flagging the blocking dev server:
`# Backend — from the repo root` … `pnpm dev  # blocks: leave this running` …
`# Frontend — in a SECOND terminal, from the repo root`. The second-terminal note matters
independently: `pnpm dev` blocks, so a single-terminal reading was never runnable anyway.

**Verified by execution, not by reading**: simulated the sequence from the repo root
(`cd apps/api` OK, `cd apps/frontend` OK) and confirmed the old chained form
(`cd apps/api && cd apps/frontend`) genuinely fails. Demonstrating the bug and the fix beats
asserting either.

Left alone: CONTRIBUTING's Checks block uses `# inside apps/api/` location *comments*
rather than chained `cd`s, so it is unambiguous and correct as written.

Suite unchanged: 623 passed / 3 pending / 0 failed; name-set diff still the one intentional
rename. Claude iter-3 still running.

## 2026-08-20 — PHASE 2 COMPLETE (commit b330a9b)

Turborepo task graph in. `pnpm dev` starts **both** apps — the headline defect from the
issue ("`pnpm dev` is `--filter ansari-backend dev`, it starts the backend only") is fixed.

### The hard requirement earned its keep twice

The architect made `pnpm dev` a *run-it-for-real* criterion rather than an inferred one.
Running it found **two bugs that reading could not have**:

1. **`interactive: true` is REJECTED under `"ui": "stream"`.** `pnpm dev` failed outright —
   not degraded, dead. Turbo demands its Terminal UI for interactive tasks. Fixed by
   keeping `stream` as the default (CI logs stay linear and greppable) and passing
   `--ui=tui` only on the root `dev` script. Making TUI global would degrade every CI log
   for one task's benefit.
2. **The `dev` task had no `env`.** Strict mode starved it and the api died with
   "Environment validation failed". I had declared env on build/test/typecheck and simply
   forgotten `dev`.

That second one was my **second omission of the same kind**, so I fixed the *structure*,
not the instance: env is now `globalEnv`, declared once. Per-task lists are repetition,
and repetition is where omissions hide. Cost of declaring globally = slightly colder cache.
Cost of omitting one = a crash, or a cache key that ignores a value baked into the artifact.

### Evidence, not assertions

- Stripping `env` from `build` → the exact predicted `Environment validation failed`.
  That is what proves strict mode is real AND that my declarations are what prevent it.
  Without this negative test, "the build passes" would not distinguish the two.
- `SENTRY_DSN` change → build hash `cf5b5497` → `2cee03f4`. **SENTRY_DSN is one of the 7
  vars found OUTSIDE the Zod schema** — schema-only parsing would have left it undeclared.
- `EXPO_PUBLIC_API_V2_URL` prod vs staging → different frontend hashes. Closes the worst
  case in the spec: a bundle baked with the wrong API URL cannot be restored as a cache hit.
- `pnpm build` twice → **FULL TURBO**, 3 tasks, 10ms.
- Deleted `uniwind-types.d.ts` → regenerated via the graph edge. Deleted it again with the
  cache warm → restored from declared outputs. Green-cold/broken-warm closed.
- All 7 CI commands run locally; frontend `typecheck`/`build` show **2 tasks**, proving the
  `gen:types` edge fires.
- Emitted CI names verified against `develop`'s required list programmatically.

### pnpm dev verified end-to-end (human + me)

Human ran it after `cp .env.ci .env`: **both apps up, Expo keypresses (i/a/w/r) working.**
I then confirmed serving: `/` → 200, `/api/health` → 200, Expo `:8081` → 200, api process
rooted in `.builders/spir-48/apps/api/`.

So `interactive: true` genuinely preserves the TUI — CONTRIBUTING's claim is TRUE and needs
no caveat. Had it failed, that sentence would have been folklore.

**Bonus live confirmation:** the health response is
`{"status":"ok","service":"ansari-backend",...}` — the carve-out I deliberately did NOT
rename, working exactly as spec 3 pins it.

### A support question worth recording

Human hit `Environment validation failed` on first `pnpm dev`. I verified rather than
assumed: there is no `apps/api/.env` in a fresh worktree (gitignored), and I proved it was
not a turbo regression by running the OLD path (`pnpm --filter ansari-api dev`, what root
`pnpm dev` was before this spec, no turbo involved) — identical failure.

Same error *message* as the bug I fixed hours earlier, completely different cause: that one
was strict mode filtering vars that WERE present; this one is no env existing at all.
Identical symptoms, different mechanism — worth being slow about.

### Known cosmetic

Frontend CI job now runs `build` but its emitted name still reads `(lint, typecheck)`.
Name deliberately frozen per the human decision; lag documented in ci.yml rather than
silently renamed.

## 2026-08-20 — Phase 2 review: a hole in my "derived, not guessed" method

gemini APPROVE (after a timeout + relaunch — its first lane was skipped, non-blocking, but
I relaunched rather than accept a two-reviewer round). **codex REQUEST_CHANGES, one real
find.** claude still running.

**Codex found two env vars my derivation missed**: `FACILITATOR_REQUEST_BUDGET_MS` and
`FACILITATOR_SYNTHESIS_RESERVE_MS`.

Root cause is instructive. My method was "parse the Zod schema + grep `process.env.X`".
These are read at `lib/facilitator/agent.ts:38` as **`process.env[name]`** — a *dynamic*
index, with the names appearing only as string literals passed to `envBudgetMs(...)`. A
static `process.env.X` pattern **cannot** see that, by construction.

So I had been claiming "derived, not guessed" while using a derivation with a blind spot.
The claim was true of the method I ran and false of the property I implied.

Consequence, had it shipped: an operator setting `FACILITATOR_REQUEST_BUDGET_MS=60000`
would have it **silently stripped** by strict mode, reverting to the 120s default, and
excluded from the cache hash. No error. Same signature as everything else on this project.

**Swept for the general case rather than fixing the two instances.** Grepped
`process\.env\[` across apps/: exactly two sites — the test helper (which *writes* env, not
a read) and `envBudgetMs`, whose two callers are precisely what codex named. So the missing
set is complete at two, and I know that rather than hoping it.

**Proven in both directions** (not just "added them"):
- Declared → turbo lists both under `configured` and the build hash changes
  (`de7e59c6` → `a7647875`).
- Removed from globalEnv → `configured` shows **NONE**, i.e. silently dropped, exactly as
  codex described. That control is what makes the fix evidence rather than assertion.

**Fixed the instructions, not just the list.** turbo.json's re-derivation comment now
requires THREE steps and says why the third exists: Zod schema, `process\.env\.[A-Z]`
static grep, **and** `process\.env\[` dynamic grep followed to its call-site literals. The
next person to re-derive this list would otherwise repeat my exact mistake.

Re-verified after the change: 66 files / 623 passed / 3 skipped; `pnpm build` twice →
FULL TURBO (11ms).

## 2026-08-20 — Phase 3: shared tsconfig, behaviour provably unchanged

`@ansari/tsconfig` created; both apps extend it. Docker fix for `workspace:*` links
included (this is the first phase to introduce one).

### I corrected the plan's own design

The plan specified a base of strict / skipLibCheck / esModuleInterop / **isolatedModules** /
resolveJsonModule. Checking the resolved configs first showed that would have been wrong:
`apps/frontend` does **not** have `isolatedModules` (expo/tsconfig.base leaves it unset)
while `apps/api` sets it. Putting it in the shared base would have silently switched it on
for the frontend — a real behaviour change wearing a refactor's clothing, i.e. precisely
what this phase's criterion exists to catch.

Base is therefore the FOUR options both apps already had. `isolatedModules` stays in
`apps/api/tsconfig.json`. The reasoning is written into `packages/tsconfig/README.md` so
the base does not quietly accumulate one-app settings later: *this base holds settings the
apps genuinely agree on; anything one app needs and the other does not belongs in that app.*

### Verification took two passes, and the first would have misled

A plain textual diff of `tsc --showConfig` before/after showed differences on the api. Both
were artefacts, not changes:
1. **Key reordering** — options now arrive merged from the extended base.
2. **Stale `.next/types/*` entries** — the baseline was captured before builds I ran later.

So I re-captured the baseline under identical build state (restore original tsconfig from
git → showConfig → restore mine → showConfig) and compared `compilerOptions` as a SET:

```
before: 17 options | after: 17 options
only before: none | only after: none | changed: none
files / include / exclude: identical
```

Frontend was byte-identical on the first pass.

Worth noting: the naive diff *looked like* a behaviour change and would have sent review
down a dead end. The inverse of this project's usual failure — here the check cried wolf
rather than staying silent — but the remedy is the same: understand what the check actually
measures before believing its verdict.

### Docker fix verified through the whole chain

`COPY packages packages` added to BOTH Dockerfiles, before install, with a comment
explaining why `COPY packages/*/package.json` would be necessary but NOT sufficient (the
tsconfig `extends` needs contents, so the half-fix installs fine and fails at build).

api image: EXIT=0, and I confirmed it exercised the real path rather than trivially
succeeding — `COPY packages packages` → `pnpm install --frozen-lockfile --filter ansari-api`
(which can only succeed if the workspace link resolved) → `✓ Compiled successfully`.

### Lockfile purity (the Phase 1 trap, checked deliberately this time)

8 insertions, all of them the two `workspace:*` link entries plus `packages/tsconfig: {}`.
No unrelated dependency drift.

### turbo

3 packages discovered. `packages/tsconfig` contributes **no tasks** — it ships only JSON and
deliberately has no scripts; lint/typecheck counts are unchanged from Phase 2, which is the
evidence it is correctly skipped rather than silently failing.

### Consultation tooling is flaky, twice now

claude's phase-2 review wedged at 31:49, relaunched, wedged again at 23:43 (healthy baseline
~5 min, zero bytes both times). gemini's phase-2 lane also timed out and needed a relaunch.
Third attempt running. If it wedges again the honest move is to record the lane as
unavailable and escalate — not to keep spending hours, and certainly not to invent a verdict.

## 2026-08-20 — Phase 2 iter 2: a FOURTH env-derivation method

gemini APPROVE. **codex REQUEST_CHANGES — `SENTRY_AUTH_TOKEN` missing from `globalEnv`.**

Third env var missed across two rounds, and each miss has exposed a *different* blind spot
in my derivation. This one is the most interesting:

`SENTRY_AUTH_TOKEN` appears **nowhere in our source**. Grep confirms it: zero hits across
`apps/**`. It is consumed internally by `withSentryConfig` at build time for source-map
uploads, and documented in `docs/self-hosting.md:86` as "build-time only".

So **all three** of my derivation methods were blind to it by construction:
1. Zod schema — it is not in the schema.
2. Static `process.env.X` grep — it is not in our code.
3. Dynamic `process.env[` grep — it is not in our code.

The missing category: **env consumed by DEPENDENCIES**. For that class, documentation is the
only authority, because our source never names the variable at all.

**Fixed as a class, not an instance.** Wrote a cross-check comparing the documented env
surface (`docs/self-hosting.md` table + `apps/api/.env.example` keys, names only) against
`globalEnv`: 28 documented + 29 example keys vs 34 declared + wildcard. Result before:
exactly one gap (`SENTRY_AUTH_TOKEN`). After: **NONE**. So the set is known complete rather
than hoped complete — and I can re-run that check any time.

turbo.json now documents **four** required derivation steps, each annotated with the real
variable that was lost by skipping it. Step 3 lost the facilitator budget vars; step 4 lost
SENTRY_AUTH_TOKEN. A future reader gets the failure history, not just the procedure.

Verified: `SENTRY_AUTH_TOKEN` appears in turbo's `configured` list and moves the build hash
(`96403d2b` → `f7b032dd`). Suite 66 files / 623 passed / 3 skipped; `pnpm build` twice →
FULL TURBO.

### Pattern worth naming

Three env misses, three different mechanisms — dynamic index, dependency-consumed,
and (in phase 2's original bug) a task I forgot to annotate. Each time I fixed the instance
AND the method, and each time a *new* category appeared. That is a good argument for the
architect's phase-6 compensating control: `turbo.json` has now been wrong three times, and
it is the file where being wrong is invisible.

## 2026-08-20 — Phase 2 iter 2 CLOSED: claude APPROVE, and the hypothesis needs nuance

gemini APPROVE | codex REQUEST_CHANGES (SENTRY_AUTH_TOKEN, fixed) | **claude APPROVE**
(5763 bytes, completed normally).

### Data point for the architect's wedge hypothesis

Claude's lane **completed this time**, on the SAME phase with the SAME never-terminating
`dev` task that wedged it three times on iteration 1.

That does not refute the hypothesis — it refines it. The mechanism is "a reviewer that
*decides* to exercise the dev task hangs forever", and whether it so decides is
**stochastic**, not deterministic. 3 hangs then 1 completion is consistent with a
probabilistic trigger; it is not consistent with "this phase always hangs". Worth reporting
accurately rather than claiming the prediction was cleanly confirmed.

Claude independently re-derived globalEnv, proved the cache key both directions, verified
the gen:types edge cold AND warm, and ran the suite + api CI command + frontend build.

### Four non-blocking findings, all real, all actioned

1. **`typecheck` + `build` race** — the best of the four. `apps/api/tsconfig.json` includes
   `.next/types/**/*.ts`, which a concurrent `next build` rewrites underneath `tsc`. Claude
   hit it once in two runs of **the plan's own acceptance command**: intermittent
   `typecheck exited (2)`, passes on re-run. Predates the task graph, but turbo makes
   concurrency the default so it surfaces more often. CI is unaffected (separate sequential
   steps).
   Documented in turbo.json, and — the part that matters — **Phase 6's criteria now forbid
   the combined invocation and explicitly warn against dismissing a typecheck failure there
   as "just a flake"**. Phase 6 re-runs exactly that command, so without this it would have
   been mis-diagnosed by whoever hit it.
2. **`_comment_build:web` was inside `"scripts"`** — so npm listed a runnable "script" whose
   body is an English sentence. Moved to a top-level `"//"` key. My mistake: I reached for a
   JSON comment convention that package.json does have (`"//"`) but put it in the wrong
   place.
3. **`gen:types` narrowed `inputs` will go stale-silent** if `global.css` ever gains a
   repo-local `@import`/`@source`. Correct today (its `@source` points into node_modules,
   covered by the pnpm-lock globalDependency). Caveat added next to the task with the fix to
   apply if it happens.
4. **`docs/self-hosting.md` was in phase 2's file list but untouched** — defensible (same
   app-scoped runbook logic as RELEASE.md) but the rationale existed only in my head.
   Now a phase 6 criterion, so its absence from the diff reads as a decision rather than
   drift.

Also noted: the frontend job name is the one check that *could* be renamed without admin
access, since it is not protection-required. Left frozen per the architect's decision.

Re-verified with typecheck and build run SEPARATELY (per the new rule): 3 tasks each,
66 files / 623 passed.

## 2026-08-20 — Phase 2 iter 3: four wrong CLAIMS of mine, caught by review

gemini APPROVE | codex REQUEST_CHANGES (1) | claude APPROVE (3 minor).

Every finding this round was a **claim I wrote that was false** — not missing code. That is
a distinct and more dangerous failure class than the env omissions: a wrong comment actively
misleads the next reader, and nothing tests a comment.

**codex — `apps/frontend/README.md` documented a workflow I broke.** It said app-local
`pnpm typecheck` "regenerates uniwind types, then tsc --noEmit". True until I de-chained
`typecheck` in this very phase; the ordering is now a Turbo `dependsOn` edge that only
applies through the graph. Drift I introduced and did not notice.

**And then I nearly shipped a false fix for it.** I wrote that skipping `gen:types` makes
`tsc` "fail on the missing uniwind-types.d.ts" — then verified and got **EXIT=0**. The
committed `types.d.ts` supplies Expo ambient types, so tsc passes regardless. The generated
file only adds uniwind's `UniwindConfig` theme tuple.

So the real consequence is **a silently weaker typecheck**, not a failure: theme-name
mistakes go uncaught while the command still reports success. That is worse than what I
guessed, and it is this project's signature shape yet again. Corrected to the verified
behaviour, with the EXIT=0 evidence stated in the doc.

**claude — three more of my comments were wrong:**
1. The frontend `"//"` claimed the in-script `gen:types` "becomes a Turbo cache hit". It does
   not — `pnpm run` bypasses Turbo entirely and re-runs uniwind. **Verified empirically:
   one forced build prints "Artifacts generated" TWICE.** Reworded to "duplicate, idempotent,
   sub-second — and required for the Docker path".
2. The `build:web` turbo task is effectively **unreachable via the graph**: frontend `build`
   shells straight to `pnpm run build:web`, so ordering comes from `build`'s own dependsOn,
   not from `build:web`'s config. Its `dependsOn`/`outputs` apply only to a direct
   `turbo run build:web`. Documented as a reachability note so nobody relies on it to order
   anything.
3. `.env.ci` in `inputs` is redundant — the file is git-tracked, so `$TURBO_DEFAULT$` already
   covers it. Harmless, but I had implied it was a safety net. Now labelled documentation-only,
   with the caveat that it would not help if the file were ever gitignored.

### Lesson

I have been rigorous about proving *behaviour* and careless about proving *claims*. Four
comments in this phase asserted mechanisms I never tested — cache-hit behaviour, failure
modes, reachability. Each was plausible and each was wrong. Comments deserve the same
"negative test it before believing it" discipline as scans: if a comment states a mechanism,
run the thing and read the output before writing the sentence.

Suite still 66 files / 623 passed; `pnpm build` twice → FULL TURBO.

## 2026-08-21 — Phase 4: shared eslint config

`@ansari/eslint-config` created, both apps consuming it, violation sets provably unchanged.

**Behaviour preservation, with non-zero denominators** (an empty-to-empty diff proves
nothing, so the file counts matter as much as the violation counts):

| app | linted files | violations | set identical |
|---|---|---|---|
| api | 77 → 77 | 7 → 7 | YES |
| frontend | 6 → 6 | 0 → 0 | YES |

**The env guard is intact and stays in the api.** `eslint-env-guard.test.ts`: 9/9 passing.
It lints virtual files through the *real composed* config, so it proves the guard survived
being layered on top of a shared base. The package README states why it is not shared:
its allowlist names backend-relative paths (`lib/config.ts`, `drizzle.config.ts`) that mean
nothing in an Expo app — security rules belong where their allowlist is meaningful.

**The CJS→ESM conversion had a real cost, and it failed loudly.**
`eslint-config-expo/flat` is a DIRECTORY. CommonJS `require()` resolves it via index.js;
ESM `import` does not — `ERR_UNSUPPORTED_DIR_IMPORT`. Fixed with an explicit
`eslint-config-expo/flat.js` and a comment recording why. Worth noting this is the *good*
failure mode: a hard error, not a config that silently resolves to zero rules.

**Guarded against the silent-zero case anyway.** Wrote a throwaway probe file with an unused
variable, confirmed the frontend config reports it, then deleted the probe. That is the
check that distinguishes "config is clean" from "config isn't running" — the two look
identical in a violation diff.

### Phase 3 review (landed mid-phase-4)
gemini APPROVE. codex REQUEST_CHANGES — but both points were requests for *evidence* rather
than defects: record the frontend image rebuild and the frozen-lockfile re-run. I had done
both and simply not recorded the output, which is a fair hit: "I did it" is not evidence.
Re-ran `pnpm install --frozen-lockfile` (clean, lockfile up to date) and surfaced the
phase-3 frontend build log lines (`COPY packages packages` → frozen install → `Exported:
dist` → `FRONTEND_EXIT=0`). Both images are rebuilding again now against the phase-4 tree,
which covers both phases at once.
