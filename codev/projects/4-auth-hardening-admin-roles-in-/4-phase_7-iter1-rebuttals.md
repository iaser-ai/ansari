# Rebuttal — Phase 7 (atomic rotation + session version + reset kill + reuse), Implement iteration 1

**Verdicts:** Gemini APPROVE · Codex REQUEST_CHANGES · Claude REQUEST_CHANGES. Both confirmed the *logic* is correct (capture-at-auth-time, executor threading, version checks on both paths, the reuse state machine); the change-requests are a real race + missing real-DB coverage. All ACCEPTED.

---

## Codex 1 (correctness) — logout-vs-refresh race

A concurrent **logout** deletes all tokens after a refresh has validated, but logout (Phase 6) did **not** bump `session_version`, so the refresh's transaction issues a new pair carrying the (unchanged) current version → a valid session survives logout. ACCEPTED.

Fix — address the root cause Codex identified ("logout does not bump session_version"): **logout now runs `bumpSessionVersion` + `deleteUserTokens` in one transaction** (`logout/route.ts`), exactly mirroring reset. A refresh that captured the pre-logout version and mints a pair embeds the stale version, which then fails the version check — the same uniform mechanism that already closes the reset race, and it needs no row locking. (This subsumes "do not issue when the row was concurrently revoked": even if the refresh does issue, its tokens are dead.) `logout-route.test.ts` updated to assert both `bumpSessionVersion` and `deleteUserTokens` run.

## Codex 2 + Claude 1 — atomicity/executor threading not proven by a real transaction

Both transactional routes were tested with `db.transaction = cb => cb({})` and fully-mocked helpers, so a helper that ignored `exec` and wrote through the module-level `db` would still pass. ACCEPTED — this was the plan's highest-impact risk and an explicit test deliverable.

Added real-DB (pglite) tests in `session-version-reuse.test.ts`:
- **Executor-threading rollback**: `db.transaction(markTokenRotated(tx) → issueTokenPair(tx) → throw)` and assert `rotated_at` is still NULL and no new token rows exist. If either helper wrote through the global `db`, the rollback could not undo it — so this proves the threading.
- **Real reset transaction**: `updateUser` + `bumpSessionVersion` + `deleteUserTokens` in one real `db.transaction` → password changed, `session_version` = 1, tokens gone, together.

## Codex 2 + Claude 2 — only one reset-vs-refresh ordering; missing-claim untested

ACCEPTED. Added:
- **Reverse ordering**: a refresh that COMMITS first (valid pair at version 0) is then killed by a later reset (bump + revoke) — asserted dead afterward.
- **logout-vs-refresh** deterministic race (validates the fix above).
- **missing session_version claim → treated as version 0**: a manually-signed legacy token (no claim) still authenticates while the user is at version 0.

The forward ordering (reset commits then stale issuance) was already covered.

## Non-blocking (both) — deleteExpiredTokens still sweeps rotated-past-grace rows
Correctly deferred: Phase 9 owns the retention flip + the `token-grace.test.ts:151` rewrite, and the sweep is wired to no caller yet, so nothing regresses today. Noted so it isn't lost.

## Non-blocking (Codex/Claude) — `findToken` didn't get `exec`; reuse warning lacks an id
- `findToken` `exec`: intentionally omitted — it's never called inside a transaction (refresh validation goes through `lookupRefreshToken`, which does take `exec`). Both reviewers called this a reasonable deviation.
- Reuse warning identifier: left generic for now (both marked optional); a hashed id can be added later without violating the no-user-content rule.

---

## Result
Full suite **554 passed, 3 skipped**; `npm run typecheck` clean; `next build` green. The logout race is closed via the same session-version mechanism as reset, and the transaction atomicity + both orderings are now proven against a real pglite transaction.
