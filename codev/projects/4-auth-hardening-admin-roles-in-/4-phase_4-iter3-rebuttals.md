# Rebuttal — Phase 4, Implement iteration 3

**Verdicts:** Gemini APPROVE · Claude APPROVE · Codex REQUEST_CHANGES. Both Codex points ACCEPTED.

---

## Codex 1 — promotion + token deletion were not atomic (race)

The iter-2 fix did `db.update(...)` then `deleteUserTokens(...)` as two separate statements. A pre-registrant's refresh could validate between them (or the account is admin before revocation completes), minting fresh tokens that survive. ACCEPTED.

Fix (`scripts/grant-admin.ts`): the promote path now runs in a **single `db.transaction`**:
- set `is_admin` + reset password,
- `session_version = session_version + 1` (via `sql`),
- `delete from tokens where user_id = …`.

The `session_version` bump is the durable defense Codex asked for: Phase 7 embeds the version in issued tokens and rejects any with a stale version, so even a token minted by a refresh racing the promotion is invalidated. It is forward-compatible — no enforcement until Phase 7 lands — but committing it here means the bootstrap is race-safe the moment Phase 7's check exists, and the atomic delete already revokes all *current* sessions immediately.

Test (`tests/grant-admin.test.ts`): the promote test now asserts, after promotion, that the seeded token row count is `0` **and** `session_version` incremented `0 → 1`, within the one transaction.

## Codex 2 — missing route-level `/admin/stats` integration test

`admin-stats-endpoint.test.ts` mocks `requireAdmin`, and `admin-auth.test.ts` tests `requireAdmin` in isolation, so the full route → `requireAdmin` → `is_admin` chain was never exercised. ACCEPTED.

Added `tests/admin-stats-authz.test.ts`: it uses the **real** `requireAdmin` (only `authenticateRequest` and the stats queries are mocked) and proves, at the route level:
- authenticated `is_admin=false` → **403** (`Admin access required`),
- authenticated `is_admin=true` → **200** (stats body),
- unauthenticated → **401**.

---

## Result
Full suite **520 passed, 3 skipped**; `npm run typecheck` clean; `next build` green. Bootstrap promotion is now atomic with a session-version bump, and the admin-stats authorization chain has end-to-end route coverage.
