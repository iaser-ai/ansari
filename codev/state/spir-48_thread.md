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
