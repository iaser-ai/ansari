# Rebuttal — Phase 7, Implement iteration 2

**Verdicts:** Gemini APPROVE · Claude APPROVE · Codex REQUEST_CHANGES. Both Codex points ACCEPTED — the reset-token one is a genuine TOCTOU.

---

## Codex 1 — refresh validation was outside the transaction (mark-and-issue only)

ACCEPTED. The refresh route now performs the authoritative check **inside** the transaction:

```ts
const pair = await db.transaction(async (tx) => {
  const recheck = await lookupRefreshToken(refresh_token, tx);  // serialized vs concurrent revoke
  if (recheck.status !== 'valid') return null;                  // revoked/expired/reuse → DON'T issue
  await markTokenRotated(refresh_token, tx);
  return issueTokenPair(recheck.user.id, recheck.user.sessionVersion, tx);
});
if (!pair) return 401;
```

- If a concurrent logout/reset revoked the token after the initial validation, the in-tx recheck reads `not_found` and we **do not issue** (closes the "issues after revoke" gap, and no longer relies on `markTokenRotated`'s return).
- An in-grace rotated token still reads `valid`, so **concurrent refreshes with the same token both succeed** (issue #34 preserved).
- Issuance embeds the version read inside the transaction; the version bump on reset/logout still invalidates anything minted under any remaining interleaving (defense-in-depth backstop).

Test: `refresh-token-route.test.ts` — validation passes but the in-tx recheck returns `not_found` → 401 and `issueTokenPair` is not called.

## Codex 2 — reset-token double-consumption (TOCTOU on a one-time token)

ACCEPTED — this was a real concurrency defect. `findToken` was outside the transaction, so two concurrent requests with the same reset token could both validate and both change the password.

Fix (`reset_password/route.ts`): the reset token is now **consumed atomically inside the transaction** via a conditional delete before anything else:

```ts
const applied = await db.transaction(async (tx) => {
  const consumed = await deleteToken(reset_token, tx);  // DELETE ... RETURNING
  if (!consumed) return false;                          // already used by a concurrent request
  await updateUser(..., tx);
  await bumpSessionVersion(..., tx);
  await deleteUserTokens(..., tx);
  return true;
});
if (!applied) return 400;
```

`DELETE ... RETURNING` hands the row to exactly one of two concurrent callers (the row lock serializes them); the loser gets `false` and returns 400 without touching the password. Added the `exec` param to `deleteToken`.

Tests:
- `password-reset.test.ts`: the conditional consume returning `false` → 400, and `updateUser` / `bumpSessionVersion` / `deleteUserTokens` are **not** called.
- `session-version-reuse.test.ts` (real DB): `deleteToken(token)` returns `true` then `false` — proving the token is consumable exactly once.

## Codex 3 — test coverage

ACCEPTED. Added: revocation-between-lookup-and-issuance (above), concurrent reuse of one reset token (above), and **rejection of BOTH members of a stale pair** — after a version bump, both the access token (`authenticateRequest`) and the refresh token (`validateRefreshToken`) are rejected, not just the access token.

---

## Result
Full suite **558 passed, 3 skipped**; `npm run typecheck` clean; `next build` green. Both the refresh mint and the reset consume are now transaction-authoritative: a concurrently-revoked refresh token is not re-issued, and a one-time reset token cannot drive two password changes.
