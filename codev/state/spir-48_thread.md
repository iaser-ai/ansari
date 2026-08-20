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
