### Iteration 1 Reviews
- gemini: APPROVE — Phase 6 correctly implements full session revocation on logout while maintaining the 401 auth-failure contract and test coverage.
- codex: REQUEST_CHANGES — Logout implementation is correct, but the required end-to-end revocation behavior is not tested.
- claude: COMMENT — Logout route correctly implements full all-device revocation with the pinned 401 contract; the only gap is that no test actually proves a post-logout refresh token is rejected.

### Builder Response to Iteration 1
# Rebuttal — Phase 6 (logout: full session revocation), Implement iteration 1

**Verdicts:** Gemini APPROVE · Codex REQUEST_CHANGES · Claude COMMENT.

Codex and Claude raised the **same** gap; ACCEPTED and fixed.

---

## Codex (blocking) + Claude (comment) — no test proves post-logout token rejection

`logout-route.test.ts` mocks `@/lib/db/users`, so it proves the route *calls* `deleteUserTokens(user.id)` but not that the user's stored tokens actually stop validating afterward — and `deleteUserTokens` had **no DB-level coverage** anywhere (`password-reset.test.ts` mocks it; `token-grace.test.ts` never exercised it). The spec criterion "after logout, the user's refresh token is rejected (test)" was therefore not literally proven. ACCEPTED.

Fix (`tests/token-grace.test.ts`, real pglite harness): added a `deleteUserTokens (full logout)` block:
- Insert an access + refresh token, call `deleteUserTokens(USER_ID)`, then assert **both** `findToken('at')` and `findToken('rt')` return undefined — the end-to-end route → delete-by-userId → `findToken` miss composition.
- User-scoping: another user's refresh token survives `deleteUserTokens(USER_ID)`.

The `logout-route.test.ts` (delegation + 401 contract) and this DB-level test together cover the route behavior and the underlying revocation.

## Nits (Claude) — fixed
- `tests/refresh-token-route.test.ts` header comment no longer claims "logout must still invalidate immediately" (logout moved out of that file).
- `tests/token-grace.test.ts:127` comment reworded from "Logout (deleteToken)…" to "deleteToken invalidates a single token…" (logout no longer uses `deleteToken`).

## Residuals to document in the PR body (both reviewers; plan-conformant, NOT defects)
Recorded in the builder thread and will go in the PR description:
1. Logout now returns **401 for an unrecognized bearer** (previously 200) — a client-visible tightening the plan asked for.
2. An **expired** access token yields 401, so its 90-day refresh token can't be revoked at logout (a future `POST /logout {refresh_token}` variant would close this tail). Plan explicitly pinned "only a valid access token proceeds."
3. Logout is **no longer idempotent** (a second call returns 401 after the access token is gone).
4. `deleteToken` is now production-dead code (a removal candidate at PR cleanup; nothing in Phase 7 needs it).

---

## Result
Full suite **534 passed, 3 skipped**; `npm run typecheck` clean; `next build` green. The full-logout revocation is now proven at the DB level, closing the spec's post-logout-rejection criterion.


### IMPORTANT: Stateful Review Context
This is NOT the first review iteration. Previous reviewers raised concerns and the builder has responded.
Before re-raising a previous concern:
1. Check if the builder has already addressed it in code
2. If the builder disputes a concern with evidence, verify the claim against actual project files before insisting
3. Do not re-raise concerns that have been explained as false positives with valid justification
4. Check package.json and config files for version numbers before flagging missing configuration
