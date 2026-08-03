### Iteration 1 Reviews
- gemini: APPROVE — Phase 5 is fully implemented and well-tested according to the spec and plan.
- codex: REQUEST_CHANGES — Core system-key reservation works, but provisioning incorrectly treats every database insert failure as an occupied system email.
- claude: APPROVE — Phase 5 fully implements system-account reservation by `system_key` with correct anti-oracle placement and fail-fast hijack handling; suite and typecheck green, with four minor non-blocking polish items.

### Builder Response to Iteration 1
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


### IMPORTANT: Stateful Review Context
This is NOT the first review iteration. Previous reviewers raised concerns and the builder has responded.
Before re-raising a previous concern:
1. Check if the builder has already addressed it in code
2. If the builder disputes a concern with evidence, verify the claim against actual project files before insisting
3. Do not re-raise concerns that have been explained as false positives with valid justification
4. Check package.json and config files for version numbers before flagging missing configuration
