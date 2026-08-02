# Rebuttal — Phase 2 (issueTokenPair consolidation), Implement iteration 1

**Verdicts:** Gemini APPROVE · Claude APPROVE · Codex REQUEST_CHANGES.

Both Codex points ACCEPTED.

---

## Codex

**1. "The canonical file list contains no `issueTokenPair` unit/integration test or repo-wide config-bypass assertion test."** ACCEPTED (visibility).

Both tests *do* exist on disk — `backend/tests/issue-token-pair.test.ts` (pglite: pair returned, signed with the config secret, expiries from `config.auth` = 2h/2160h, both stored hashed) and `backend/tests/auth-config-bypass.test.ts` (asserts none of the six auth files read `process.env.JWT_SECRET` / `*_TOKEN_EXPIRY_HOURS`). They were **untracked**, so they did not appear in the reviewed diff. I have now **staged all Phase 2 files**, including these two, so they are unambiguously part of the change set and will be committed atomically with the phase (explicit paths, no `git add -A`).

**2. "No test exercises the migrated login route; add coverage proving login calls `issueTokenPair` and preserves its response contract."** ACCEPTED (real gap).

Added `backend/tests/login-route.test.ts` (3 tests):
- Valid credentials → 200 with the exact Ansari contract (`status:'success'`, `access_token`, `refresh_token`, `token_type:'bearer'`, `first_name`, `last_name`), and asserts `issueTokenPair` was called with `user.id`.
- Unknown user → 401, and `issueTokenPair` is **not** called.
- Wrong password → 401, and `issueTokenPair` is **not** called.

This closes the coverage gap for the one migrated route (register and refresh already had route-level tests, now updated to the `issueTokenPair` mock).

---

## Result
Full suite **502 passed, 3 skipped**; `npm run typecheck` clean; `next build` green with `.env.ci`. The three Phase 2 test files (`issue-token-pair`, `auth-config-bypass`, `login-route`) plus the two updated mocks (`refresh-token-route`, `register-newsletter`) are staged. No points rejected.
