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
