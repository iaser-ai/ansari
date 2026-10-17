# Contributing to Ansari

Thank you for wanting to improve Ansari. Contributions of all kinds are welcome —
bug reports, fixes, tests, documentation, and translations.

## Filing an issue

You don't need to write code to help — a clear report is a real contribution.
[Open an issue](https://github.com/iaser-ai/ansari/issues/new/choose) and pick the
form that fits:

- **Bug report** — what happened, what you expected, the steps to reproduce it,
  where you saw it (askansari.ai, the mobile app, the API, or a self-hosted
  instance), and roughly when, with your timezone, so we can find the matching logs.
- **Feature request** — start with the problem you are trying to solve and who it
  affects, then any alternatives you considered. A proposed solution is welcome
  but optional.

If neither form fits, a blank issue is fine. For general questions, email
`info@iaser.ai`.

**Answer-accuracy issues should cite sources.** Ansari is an Islamic Q&A
assistant, so accuracy and sourcing are the heart of the project. If an answer is
wrong or misleading, include the exact question you asked and the evidence for
what it should have said — the Qur'an ayah, hadith reference, or scholarly work.

**Security vulnerabilities never go in a public issue** — see
[Reporting security issues](#reporting-security-issues) below.

## Development setup

You need **Node 22** (22.18 or newer; `.nvmrc` pins the major for `nvm use`).
[`docs/self-hosting.md`](docs/self-hosting.md) covers prerequisites and the full
environment contract, and [`apps/api/README.md`](apps/api/README.md) covers the
backend in more depth.

This is a **pnpm workspace** (`apps/api/` + `apps/frontend/`) driven by
**[Turborepo](https://turborepo.com)**: install once at the repo root, then run
tasks from the root — `pnpm dev` brings up **both** apps at once.

```bash
corepack enable         # provides pnpm (version pinned in package.json)
pnpm install            # at the repo root

# One-time backend setup — from the repo root
cd apps/api
cp .env.example .env    # see docs/self-hosting.md for the full env contract
pnpm db:migrate         # needs a local Postgres and DATABASE_URL
cd ../..

# One-time auth setup: a SECOND local database, never the app's
createdb ansari_auth
cd apps/auth
cp .env.example .env    # DATABASE_URL = the ansari_auth owner URL; the service's
                        # startup error names any variable still missing
pnpm db:migrate         # applies packages/auth/drizzle/ to that DATABASE_URL
cd ../..

# Then, from the repo root: starts BOTH apps (api + frontend) together
pnpm dev
# …and the auth service in a second terminal (`pnpm dev` does not start it)
pnpm auth dev
```

**Two databases.** Development and CI use two: the app database (`apps/api`,
e.g. `ansari`) and the auth database (`apps/auth`, e.g. `ansari_auth`), each
with its own owner URL. `apps/api` never reads the auth database; it reaches
`apps/auth` over HTTP at its origin, like any client, so set its
`AUTH_URL=http://localhost:3100` (`pnpm auth dev` serves `:3100`). No secret is
shared between the two. An auth database you set up earlier by
applying `0000_auth_schema.sql` with psql has no drizzle journal row, so
`db:migrate` re-runs `0000` against it and fails (drizzle-kit prints no
reason); drop and recreate `ansari_auth`
(local data only) and migrate again. **If you applied the old `packages/auth`
`0000` migration** (before spec 300), drop and recreate your local auth
database and apply the new `0000`: the journal was replaced, not extended.
The test suites need neither database (they run on pglite).

`pnpm dev` needs a real terminal: it runs Turbo's interactive UI so the Expo dev
server keeps its keypress shortcuts (`i`, `a`, `w`, `r`) while sharing a console
with the API. To run one app on its own — or in a script or non-TTY shell — use
`pnpm api dev` or `pnpm frontend start`.

**Use pnpm, not npm or yarn.** The single authoritative lockfile is the root
`pnpm-lock.yaml`; there are deliberately no per-package lockfiles. Shared
toolchain versions (e.g. TypeScript) live in the `catalog:` section of
`pnpm-workspace.yaml`.

## Checks

Before opening a PR, make sure these pass. Run them **from the repo root** —
[Turborepo](https://turborepo.com) fans each task out across every package that
defines it, and caches the results:

```bash
pnpm lint          # both apps
pnpm typecheck     # both apps (regenerates the frontend's uniwind types first)
pnpm test          # api only — the frontend has no test suite yet
pnpm build         # both apps
```

Turbo prints which packages each task ran in, so the scope is always visible
rather than implied. A second identical run is a cache hit.

CI runs the same tasks (with `test:coverage` for the api) using the dummy env in
`apps/api/.env.ci` — no secrets needed. `pnpm build` needs no env at all. The
api test suite does: load that env the way CI does before testing the api:

```bash
set -a && . ./apps/api/.env.ci && set +a
pnpm test
```

Without it the api tests fail with `Environment validation failed`: `apps/api`
Zod-validates its configuration on first use, and Turborepo's strict env mode
only forwards variables declared in `turbo.json`. The build never touches the
config, so it passes either way (the database handle is created lazily, #260).

You can still target one package directly — `pnpm api lint`, `pnpm frontend web`,
`pnpm api db:migrate` — which is the right thing for scripts Turbo does not model.

## Pull requests

- **Branch from `develop` and target `develop`** — not `main`. `main` is
  production and is only ever fast-forwarded to `develop` during a release (see
  [RELEASE.md](RELEASE.md)), so PRs against it can't be merged.
- CI must be green before a PR can merge. `develop` requires all four checks:
  `api (lint, typecheck, test, build)`, `auth (lint, typecheck, test, build)`,
  `frontend (lint, typecheck)`, and `gitleaks (secret scan)`. The
  [Checks](#checks) above are the same tasks, so passing them locally is a good
  predictor. If the secret scan fails, see [Secret scanning](#secret-scanning).
- Stage files explicitly (`git add path/to/file`). Please don't use `git add -A`
  or `git add .` — that is how stray files and secrets end up in commits.
- Keep PRs focused: one change per PR.
- Add or update tests for any behavior change. The Vitest suite
  (`tests/*.test.ts`) is the regression net.
- Never commit real credentials or `.env` files. `apps/api/.env.ci` contains
  deliberately fake placeholder values only.
- Islamic-content changes (prompts, citations, source handling) get extra
  scrutiny: accuracy and proper sourcing are the core of this project. Cite the
  basis for any change to `lib/ai/prompts/`.

### Developing with Codev (strongly recommended)

We strongly recommend developing with [Codev](https://github.com/cluesmith/codev),
the human-agent software development methodology this project is built with:
spawn a builder with Agent Farm (`afx spawn <issue>`) and let porch drive it
through the protocol. If you work from a fork, a few notes save the usual
papercuts:

- The [CLI reference](https://github.com/cluesmith/codev/blob/main/codev/resources/commands/overview.md)
  covers `codev`, `afx`, `porch` and `consult`. Protocol docs
  (`codev/protocols/<name>/`) ship with the installed `@cluesmith/codev`
  package and resolve from there when absent from this repo.
- Commit the generated `codev/projects/<id>/status.yaml` and
  `codev/state/<id>_thread.md` with your PR. They are expected, not noise:
  builder thread files are versioned on purpose.
- In a fresh worktree, porch's `build` check passes with no env loaded
  ([#260](https://github.com/iaser-ai/ansari/issues/260)). Running the api tests
  still needs the dummy env first: `set -a && . ./apps/api/.env.ci && set +a`.
- Porch gate approvals recorded in your fork are your own state, not maintainer
  approval. Maintainers review and merge (with merge commits, never squash).
- Sync your fork's `develop` with upstream before branching. A stale base means
  CI tests an old merge, and the review has to re-verify against current
  `develop`.
- A first-time fork PR shows "no checks reported" until a maintainer approves the
  workflow run. That is normal; there is nothing for you to do.

## Secret scanning

Every PR is scanned for credentials by [gitleaks](https://github.com/gitleaks/gitleaks).
On a PR the scan covers **only the PR's own commits** (`origin/develop..HEAD`), so
a hit is in a commit on your branch. (Pushes to `develop` and `main` scan the
branch's full history.) If it flags something:

- **A real credential** — rotate it immediately, then remove it from your
  branch's history by rewriting the commit. An allowlist entry is not a fix: the
  secret is already exposed.
- **A test fixture** (a fake key or token in a test) — prefer changing the
  fixture to a value that doesn't trip the scanner. If that is genuinely
  impossible, add an allowlist entry with a written justification beside it:
  either a `.gitleaksignore` fingerprint (`commit:file:rule:line`, which pins one
  adjudicated finding) or a `.gitleaks.toml` regex (wider, so it needs a stronger
  reason).

Changes to `.gitleaksignore` and `.gitleaks.toml` always get extra scrutiny — a
maintainer reviews the entry itself, not just the PR around it.

## Reporting security issues

**Please never report a vulnerability in a public issue, PR, or comment.** Use
GitHub's [private vulnerability reporting](https://github.com/iaser-ai/ansari/security/advisories/new)
("Report a vulnerability" under the repository's Security tab) so it can be fixed
before it is disclosed. [SECURITY.md](SECURITY.md) has the full policy.
