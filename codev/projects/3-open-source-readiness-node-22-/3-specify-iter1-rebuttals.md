# Spec 3 — Rebuttal to iteration-1 spec review

**Verdicts**: Gemini APPROVE · Codex REQUEST_CHANGES · Claude REQUEST_CHANGES.

The two REQUEST_CHANGES reviews were high-signal and correct on every point. I accepted all
blocking items and all non-blocking nits. No point was rejected. Summary of each and what changed.

## Codex

1. **Exact 503 body / "shape identical" vs "generic non-ok body" conflict** — ACCEPTED.
   Resolved in Success Criteria + Constraints: both 200 and 503 carry the *same field set*
   (`status`, `service`, `timestamp`); only `status` flips `'ok'`→`'error'` alongside the HTTP code;
   no new fields, no raw DB error text. This removes the apparent contradiction.

2. **Measurable timeout; "through the pool" misleading (pool is private, only `db`/`schema`/`closeDb`
   exported)** — ACCEPTED. Pinned a hard 2000 ms race (vs the pool's 5000 ms `connectionTimeoutMillis`)
   in Success Criteria and Performance Requirements, and reworded to run `SELECT 1` via the exported
   `db` handle rather than "the pool."

3. **Resolve test-suite scope in the spec, not the plan** — ACCEPTED. Both choices are now firm
   in Open Questions and Success Criteria: e2e → **remove** (`tests/e2e/`, `playwright.config.ts`,
   `@playwright/test` devDep) with `CONTRIBUTING.md` updated; `api.test.ts` → **replace** vacuous cases
   with real `login` + public `share` route tests.

4. **Make dependency-security acceptance deterministic** — ACCEPTED. Restated as: after `drizzle-kit`
   moves to `devDependencies`, `npm audit --omit=dev` reports **0**; `--force` forbidden; residual
   `--force`-only advisories documented.

5. **"Current majors" is a moving target; require SHA→release comments** — ACCEPTED. Success Criteria
   now requires all actions pinned to a full commit SHA with a trailing `# vX.Y.Z` comment, off the
   deprecated majors. Resolved the SHA-scope open question: pin *all* actions (first- and third-party).

6. **Verify how Railway consumes Node 22 (`railway.toml` has no Node directive)** — ACCEPTED. Softened
   the claim in Problem Statement / Desired State / Assumptions: `railway.toml` carries no Node
   directive; Railway's Nixpacks build honoring `.nvmrc`/`engines` is *confirmed during implementation*,
   and any Node pin found elsewhere is updated too.

7. **Chronology: a 2026-08-01 spec can't cite a 2026-08-02 review** — ACCEPTED. Removed the future date;
   now "a recent multi-model review."

## Claude

Claude independently verified every Current State claim against the tree (found all accurate) and
raised two blocking items plus nits.

1. **`npm audit` criterion unachievable; the shortcut is destructive** (4 `esbuild`/`@esbuild-kit/*`
   advisories only "fixable" via `npm audit fix --force`, which downgrades `drizzle-kit`
   0.31.8→0.18.1, `isSemVerMajor: true`) — ACCEPTED. Same fix as Codex #4, plus an explicit Constraint
   forbidding `--force` and noting those advisories leave the prod audit once `drizzle-kit` moves to
   devDeps. This is the key insight and it's now captured verbatim in the criterion.

2. **Healthcheck under-specifies failure modes** — ACCEPTED, all three sub-points:
   - *Unset `DATABASE_URL` → 500 at import, not 503* (module-scope `getPool()` throws). Success
     Criteria + Test Scenarios now require 503 on unset/unreachable `DATABASE_URL` (route imports the
     db lazily/guards so the probe still answers 503).
   - *Timeout contradicts the 5000 ms pool.* Pinned 2000 ms race (also Codex #2).
   - *No route declares segment config.* Added `export const dynamic = 'force-dynamic'` as an explicit
     requirement so the probe is never build-time-cached.
   - Also captured Claude's note that `tests/health.test.ts` must convert to the
     `vi.mock('@/lib/db/index')` + pglite pattern (its current top-level static import would break once
     the route imports the db module).

3. **Nits** — ACCEPTED: `lint` script value pinned to `eslint .`; "removed-in-Next-16" reworded to be
   precise (deprecated in 15, real breakage = no config + `eslint-config-next@16` vs Next 15); e2e
   removal now includes `@playwright/test` + `playwright.config.ts`.

## Net

All blocking items from both reviewers are addressed by concrete edits to Success Criteria,
Constraints, Performance Requirements, Test Scenarios, and Open Questions. No rewrite was needed —
the reviewers explicitly said as much. Gemini's APPROVE stands unchanged. Committed as
`[Spec 3] Specification with multi-agent review`.
