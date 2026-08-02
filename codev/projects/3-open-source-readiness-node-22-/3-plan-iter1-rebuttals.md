# Plan 3 — Rebuttal to iteration-1 plan review

**Verdicts**: Gemini APPROVE · Codex REQUEST_CHANGES · Claude REQUEST_CHANGES.

Both REQUEST_CHANGES reviews were correct and I verified every claim against the worktree before
editing (`api.test.ts:21`, `shares.ts:16` FK, `railway.toml`, the four docs, `.gitignore:8-9`,
`tsconfig.json:31,33`). All points accepted; no rejections. Revised plan committed as
`[Spec 3] Implementation plan (revised per plan review)`.

## Claude — Blocking

1. **Phase 4 broke its own per-phase green gate** (`tests/api.test.ts:21` imports the health route
   unmocked, asserts 200/`ok`; once the healthcheck runs `SELECT 1` that case → 503). VERIFIED.
   **Fix**: took Claude's option (b) — **swapped Phase 4 and Phase 5** so test-honesty (which deletes
   those vacuous cases, including the health one) runs before the healthcheck change. Both depend only
   on Phase 1, so the swap is free. Updated the phases JSON, dependency map, checkpoints, and added an
   explicit banner on both phases explaining the ordering.

2. **Node-20 / Playwright references stale in unnamed docs.** VERIFIED all hits:
   `README.md:33,39,44`, `AGENTS.md:17,34`, `CLAUDE.md:17,34`, `docs/self-hosting.md:8`.
   **Fix**: named every file explicitly — Node-version bumps → Phase 1 deliverables; Playwright refs →
   Phase 4 deliverables (plus `tsconfig.json` stale exclude and `.gitignore` artifact entries per Codex).

## Codex

1. **Bare `vitest run --coverage` in Actions won't be on PATH.** ACCEPTED. Phase 3 now adds a
   `"test:coverage": "vitest run --coverage"` script and CI calls `npm run test:coverage`.

2. **ESLint flat config: Next 15 needs `FlatCompat` + `@eslint/eslintrc`, not a native spreadable
   export.** ACCEPTED. Phase 2 now prescribes verify-then-install: check for a native flat entry, else
   add `@eslint/eslintrc` as a devDep and use `FlatCompat` extending `next/core-web-vitals` +
   `next/typescript` (Next 15's own scaffold shape).

3. **Playwright footprint also in `AGENTS.md`, `CLAUDE.md`, `tsconfig.json`, `.gitignore`.** ACCEPTED —
   folded into Phase 4's explicit cleanup list (Claude flagged the same docs; merged).

4. **Share test can't seed a bare share row — `shares.thread_id` is a `notNull` FK to `threads`.**
   VERIFIED (`db/schema/shares.ts:16`). ACCEPTED. Phase 4 now requires seeding users→threads→shares in
   order before the assertion.

5. **Phase 4/5 healthcheck: explicitly test the 2000 ms timeout and explain how the unset-`DATABASE_URL`
   case avoids the global `vi.mock` masking the failure.** ACCEPTED. Phase 5 now has a dedicated "Test
   approach" block: timeout via Vitest fake timers / never-resolving `execute`; unset-`DATABASE_URL` via
   a mock factory whose `get db()`/`execute` throws — with an honesty note that this exercises the
   route's try/catch around the lazy import, approximating (not literally reproducing) the real
   import-time failure. That is the correct testable contract.

## Claude — Should-address / smaller

- **tests/** unlinted + untypechecked**: made it a conscious, documented decision in Phase 2 (script
  stays `eslint .` per spec; tests already excluded from typecheck; not expanding scope to avoid churn).
- **Phase 3 touches package.json/lockfile**: called out in Phase 3 as intentional, not Phase 1 leakage.
- **`playwright.config.ts` typecheck-safe**: noted; still removing the stale `tsconfig` exclude for tidiness.
- **Railway `/api/health` becomes a deploy gate** (`railway.toml` `restartPolicyMaxRetries=3`): added to
  Phase 5 risks and Post-Implementation ("confirm the probe passes post-deploy") — the one change that
  can take prod down.

## Net
Gemini's APPROVE stands. Every blocking item from Codex and Claude is addressed by concrete plan edits;
the load-bearing fix is the Phase 4/5 swap that restores the per-phase green-gate invariant.
