# Contributing to Ansari

Thank you for wanting to improve Ansari. Contributions of all kinds are welcome —
bug reports, fixes, tests, documentation, and translations.

## Development setup

All development happens inside `backend/` for now (`frontend/` is being migrated).

```bash
cd backend
npm ci
cp .env.example .env    # see docs/self-hosting.md for the full env contract
npm run db:migrate      # needs a local Postgres and DATABASE_URL
npm run dev
```

**Run all npm commands from inside `backend/`, not the repo root.**
`backend/package-lock.json` is the single authoritative lockfile — there is
deliberately no root `package.json` or root lockfile (workspaces tooling arrives
when `frontend/` lands). Running `npm install` at the repo root would create a
stray root lockfile; don't.

## Checks

Before opening a PR, make sure all three pass (CI runs exactly these, with the
dummy env in `backend/.env.ci` — no secrets needed):

```bash
npm run typecheck
npm test
npm run build
```

Playwright e2e tests (`tests/e2e/*.spec.ts`) are not run in CI — they need a live
app and database. Run them locally with `npx playwright test` if your change
touches user-facing flows.

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
