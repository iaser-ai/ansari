# Rebuttal — Phase 4 (durable admin authz + reservation + bootstrap), Implement iteration 1

**Verdicts:** Gemini APPROVE · Claude APPROVE · Codex REQUEST_CHANGES.

Codex's single point is ACCEPTED — it's a real security defect in the bootstrap script.

---

## Codex

**`scripts/grant-admin.ts` blindly set `is_admin=true` on any existing account while preserving its password → could permanently grant admin to an attacker who pre-registered the allowlisted address (the exact vulnerability being fixed), and could "succeed" on an unusable `nologin`/invalid hash.** ACCEPTED.

Fix: `grantAdmin(email, password)` now **requires a password in all cases and SETS it on the account** (create or promote):
- **New account** → created with `is_admin=true` and a bcrypt hash of the operator's password (login-capable).
- **Existing account** → promoted to `is_admin=true` **AND its password is reset** to the operator-supplied value.

Resetting the password on promotion is the security fix: if the address was pre-registered by an attacker, overwriting the credential with the operator's password **locks the attacker out** and guarantees the admin account is login-capable. There is no longer any path that preserves a possibly-attacker-controlled hash, and no path that leaves an unusable `nologin` admin.

Test updates (`tests/grant-admin.test.ts`), per Codex's request to "verify actual password authentication rather than preserving an arbitrary hash":
- **New account**: `verifyPassword(operatorPw, row.password_hash) === true` (login-capable).
- **Promote existing (pre-registered attacker sim)**: seed a real attacker bcrypt hash, promote with the operator's password, then assert `verifyPassword(operatorPw, hash) === true` **and** `verifyPassword(attackerPw, hash) === false` — the attacker is locked out.
- **New guard**: promoting an existing account without a password now throws and does **not** flip `is_admin`.

CLI prompt text updated: the password is always SET (not "only if new").

---

## Non-blocking (Gemini / Claude) — no changes required
Both approved. The durable `is_admin` gate, the anti-oracle 409 placement (before the strength check, folded into the existing-conflict branch), and the production-gated startup assertion (with the `NEXT_PHASE` build guard, verified by a green `next build`) were all confirmed correct.

---

## Result
Full suite **514 passed, 3 skipped**; `npm run typecheck` clean; `next build` green. The bootstrap is now safe against the pre-registration promotion attack and always produces a login-capable admin.
