# Contributing to Ansari

Thank you for wanting to improve Ansari. Contributions of all kinds are welcome —
bug reports, fixes, tests, documentation, and translations.

## Development setup

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

# Then, from the repo root: starts BOTH apps together
pnpm dev
```

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
`apps/api/.env.ci` — no secrets needed. To reproduce a CI run exactly, load that
env the way CI does before building or testing the api:

```bash
set -a && . ./apps/api/.env.ci && set +a
pnpm build
```

Without it the api build fails with `Environment validation failed`: `apps/api`
Zod-validates its configuration, and Turborepo's strict env mode only forwards
variables declared in `turbo.json`.

You can still target one package directly — `pnpm api lint`, `pnpm frontend web`,
`pnpm api db:migrate` — which is the right thing for scripts Turbo does not model.

## Pull requests

- Keep PRs focused: one change per PR.
- Add or update tests for any behavior change. The Vitest suite
  (`tests/*.test.ts`) is the regression net.
- Never commit real credentials or `.env` files. `apps/api/.env.ci` contains
  deliberately fake placeholder values only.
- Islamic-content changes (prompts, citations, source handling) get extra
  scrutiny: accuracy and proper sourcing are the core of this project. Cite the
  basis for any change to `lib/ai/prompts/`.

## Reporting security issues

Do not open a public issue — see [SECURITY.md](SECURITY.md).
