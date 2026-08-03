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


### Iteration 2 Reviews
- gemini: APPROVE — Phase 4 implementation fully satisfies all spec and plan requirements for durable admin authorization, address reservation, production startup assertion, and admin bootstrapping.
- codex: REQUEST_CHANGES — Core admin gating and reservation are correct, but promoting a pre-registered account leaves the attacker’s existing sessions authorized as admin.
- claude: REQUEST_CHANGES — Durable `is_admin` gate, anti-oracle 409 placement, and the production-gated startup assertion are all correct and well tested; the bootstrap script's promote path leaves a pre-registrant's existing tokens valid, handing them admin.

### Builder Response to Iteration 2
# Rebuttal — Phase 4, Implement iteration 2

**Verdicts:** Gemini APPROVE · Codex REQUEST_CHANGES · Claude REQUEST_CHANGES.

Codex and Claude independently raised the **same** blocker (plus Codex's logging point). All ACCEPTED.

---

## Blocking (Codex + Claude): promotion resets the password but does not revoke existing tokens

My iter-1 claim that a password reset "locks the attacker out" was **wrong on its own**. A pre-registrant who logged in holds an access token and a **90-day refresh token** as `tokens` rows; resetting the password does not touch them. After promotion `findToken` still resolves them, `authenticateRequest` returns the now-`is_admin=true` row, and `requireAdmin` grants — the attacker reads `/api/v2/admin/stats` and mints access tokens for 90 days. ACCEPTED.

Fix (`scripts/grant-admin.ts`): the promote branch now calls `await deleteUserTokens(existing.id)` after setting `is_admin` + the new password — the same revocation `reset_password/route.ts` already performs on a password change. This genuinely locks out a pre-registrant (old sessions gone + password overwritten).

Test (`tests/grant-admin.test.ts`): added a tokens table to the pglite harness; the new test seeds a live refresh-token row for a pre-existing account, promotes it, and asserts the token row count is **0** afterward.

## Blocking (Codex): startup error leaks the admin email address

`assertConfiguredAdminsExist` embedded the admin address in errors that Next logs, violating the plan's "no user content in logs" requirement. ACCEPTED. Errors now identify the failing entry by its **position** — `configured admin #N of M (from ADMIN_EMAILS)` — never the address. Added a test asserting the thrown message does **not** contain the email.

## Non-blocking (Codex + Claude): DB-unreachable indistinguishable from missing-admin

ACCEPTED (cheap + improves triage). `findUserByEmail` is now wrapped; a DB error rethrows as "Admin bootstrap check could not reach the database …", distinct from the missing/unflagged messages. Added a test (`findUserByEmail` rejects → `/could not reach the database/`).

## Non-blocking (Claude): docs/self-hosting.md is operationally hazardous

ACCEPTED (cheap, prevents a crash-looping deploy). Updated the `ADMIN_EMAILS` row to state it **reserves + asserts**, does not grant (the `is_admin` flag authorizes), and added a **"Provisioning admins"** subsection with the runbook ordering (migration → bootstrap → deploy) and the exact `grant-admin.ts` invocation.

## Non-blocking (Claude): readline echo tradeoff
Added a one-line comment noting input echoes (acceptable for an operator-run bootstrap; never lands in shell history; prefer `GRANT_ADMIN_PASSWORD` non-interactively).

## Deferred to Phase 5 (Claude): normalize inside `isReservedAddress`
Claude suggested normalizing inside the helper when Phase 5 adds a second call site. I'll fold normalization into the helper in Phase 5 (where the system-address extension lands) rather than change the single-caller contract now. Noted.

---

## Result
Full suite **517 passed, 3 skipped**; `npm run typecheck` clean; `next build` green. The bootstrap now revokes a promoted account's sessions (true pre-registrant lockout), the startup error carries no email, and the self-hosting docs reflect the new `ADMIN_EMAILS` semantics.


### IMPORTANT: Stateful Review Context
This is NOT the first review iteration. Previous reviewers raised concerns and the builder has responded.
Before re-raising a previous concern:
1. Check if the builder has already addressed it in code
2. If the builder disputes a concern with evidence, verify the claim against actual project files before insisting
3. Do not re-raise concerns that have been explained as false positives with valid justification
4. Check package.json and config files for version numbers before flagging missing configuration
