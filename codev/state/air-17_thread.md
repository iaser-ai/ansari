# air-17 thread — Replace auth-config-bypass grep-test with ESLint rule (issue #17)

## 2026-08-02 — start

- AIR strict mode, phase: implement.
- Discovery: `backend/tests/auth-config-bypass.test.ts` did not exist on my branch base —
  it landed with PR #15 (builder/spir-4), merged to develop today. Merged origin/develop
  into builder/air-17 to pick it up before replacing it.
- Survey: legitimate direct env reads are `lib/config.ts` (Zod-parses whole process.env,
  plus `getEnv().X` accessors) and `drizzle.config.ts` (DATABASE_URL). `tests/**` is
  already excluded from lint scope, so test-file env writes are unaffected.
- Design: property-only `no-restricted-properties` entries (JWT_SECRET, DATABASE_URL,
  ACCESS/REFRESH_TOKEN_EXPIRY_HOURS — the old grep test guarded the expiries too, keeping
  parity). Property-only (no `object:` key) is deliberate: ESLint can't match the nested
  `process.env.X` chain via `object: 'process'`, and property-only also catches
  `getEnv().JWT_SECRET` sidesteps outside config.ts. Allowlist via a `files:` override
  that switches the rule off for `lib/config.ts` + `drizzle.config.ts`.
- Test: vitest suite lints virtual files through the real `eslint.config.mjs` (ESLint
  Node API) — rule fires in lib/src, silent in allowlisted files.
