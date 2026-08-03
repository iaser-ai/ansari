# Rebuttal — Phase 5 (system-account reservation via system_key), Implement iteration 1

**Verdicts:** Gemini APPROVE · Claude APPROVE · Codex REQUEST_CHANGES. Both Codex points ACCEPTED.

---

## Codex 1 — `getOrCreateSystemUser` treated every insert failure as an occupied system email

The catch block reported the hijacked-email remediation message whenever the post-insert key re-read was empty, so a DB outage / permission / schema error would produce misleading guidance. ACCEPTED.

Fix (`lib/db/users.ts`): added `isUniqueViolation(err)` and gate the interpretation on it — `if (!isUniqueViolation(err)) throw err;` rethrows all non-unique failures unchanged; only a unique violation is interpreted (re-read for a `system_key` race → return; else the occupied-email fail-fast).

**Detail worth noting:** drizzle wraps the driver error, so the pg/pglite `code: '23505'` sits under `.cause`, not on the top-level error (this is exactly why a naive top-level `err.code === '23505'` check failed my first attempt). `isUniqueViolation` therefore walks the `.cause` chain (up to 5 levels).

Tests (`tests/system-user.test.ts`):
- `isUniqueViolation` unit: `{code:'23505'}` and `{cause:{code:'23505'}}` → true; `42P01`, `08006`, a plain `Error`, `null`, `undefined` → false.
- **Non-unique regression**: drop the `users` table so the query fails with a non-23505 error, then assert `getOrCreateSystemUser` rejects **and** the message does **not** match `/already held by a/` — i.e. the real error propagates rather than being masked as a hijack.
- The hijack (23505) fail-fast and race-reread paths remain covered.

## Codex 2 — endpoint→identity mapping was not asserted

The endpoint tests mocked `getOrCreateSystemUser` but never asserted which key each endpoint passes. ACCEPTED.
- `tests/mcp-complete.test.ts`: new test asserts `getOrCreateSystemUser` is called with `'ai-skill'`.
- `tests/openai-compat.test.ts`: the passing 200 test now asserts it is called with `'leaderboard'`.

---

## Result
Full suite **530 passed, 3 skipped**; `npm run typecheck` clean; `next build` green. System provisioning now interprets only genuine unique violations and surfaces all other DB failures faithfully, and the critical endpoint-to-identity mapping is regression-tested for both identities.
