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
