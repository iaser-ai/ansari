### Iteration 1 Reviews
- gemini: APPROVE — Phase 4 deliverables for durable admin authorization, reserved-address reservation, startup assertions, and administrative bootstrapping are fully implemented and verified.
- codex: REQUEST_CHANGES — Durable authorization and reservation are correct, but the bootstrap can promote an attacker-controlled pre-existing account.
- claude: APPROVE — Phase 4 is complete and correct — admin gates on the durable flag, the anti-oracle 409 placement is right and regression-tested, and I empirically confirmed both the `next build` guard and the production boot fail-fast; only docs and small hardening nits remain.

### Builder Response to Iteration 1
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


### IMPORTANT: Stateful Review Context
This is NOT the first review iteration. Previous reviewers raised concerns and the builder has responded.
Before re-raising a previous concern:
1. Check if the builder has already addressed it in code
2. If the builder disputes a concern with evidence, verify the claim against actual project files before insisting
3. Do not re-raise concerns that have been explained as false positives with valid justification
4. Check package.json and config files for version numbers before flagging missing configuration
