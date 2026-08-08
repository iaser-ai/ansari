# Contributing to Ansari

Thank you for wanting to improve Ansari. Contributions of all kinds are welcome —
bug reports, fixes, tests, documentation, and translations.

## Development setup

This is a **pnpm workspace** (`backend/` + `frontend/`): install once at the
repo root, then run scripts inside the package you're working on.

```bash
corepack enable         # provides pnpm (version pinned in package.json)
pnpm install            # at the repo root

# Backend
cd backend
cp .env.example .env    # see docs/self-hosting.md for the full env contract
pnpm db:migrate         # needs a local Postgres and DATABASE_URL
pnpm dev

# Frontend
cd frontend
pnpm start              # Expo dev server; `pnpm web` for the web target
```

**Use pnpm, not npm or yarn.** The single authoritative lockfile is the root
`pnpm-lock.yaml`; there are deliberately no per-package lockfiles. Shared
toolchain versions (e.g. TypeScript) live in the `catalog:` section of
`pnpm-workspace.yaml`.

## Checks

Before opening a PR, make sure these pass (CI runs them — the backend test step
with coverage — using the dummy env in `backend/.env.ci`, no secrets needed):

```bash
# inside backend/
pnpm lint && pnpm typecheck && pnpm test && pnpm build

# inside frontend/
pnpm lint && pnpm typecheck
```

## Pull requests

- Keep PRs focused: one change per PR.
- Add or update tests for any behavior change. The Vitest suite
  (`tests/*.test.ts`) is the regression net.
- Never commit real credentials or `.env` files. `backend/.env.ci` contains
  deliberately fake placeholder values only.
- Islamic-content changes (prompts, citations, source handling) get extra
  scrutiny: accuracy and proper sourcing are the core of this project. Cite the
  basis for any change to `lib/ai/prompts/`.

## Reporting security issues

Do not open a public issue — see [SECURITY.md](SECURITY.md).
