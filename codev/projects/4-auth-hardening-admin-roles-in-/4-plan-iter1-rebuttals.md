# Rebuttal — Plan #4 (Auth Hardening), Plan iteration 1

**Verdicts:** Gemini APPROVE · Codex REQUEST_CHANGES · Claude REQUEST_CHANGES (both HIGH confidence; Claude verified against the `spir-4` worktree source).

Both change-requests were code-grounded and correct. I verified the key claims directly (hand-DDL in `tests/token-grace.test.ts:37` & `tests/attribution-schema.test.ts:35`; `schema.test.ts:5-15` column enumeration; `logout/route.ts:12` returns 401 on no-token; `register/route.ts` 409 at line 36 sits *before* the strength check at 39-46; `railway.toml` has no cron). **All points ACCEPTED**; no rejections. Dispositions below.

---

## Codex (REQUEST_CHANGES)

**C1 — Phase 2 self-contradiction: `request_password_reset` issues a single reset token, not a pair.** ACCEPTED. Phase 2 now migrates only the three pair-issuing routes (register/login/refresh) to `issueTokenPair`; `request_password_reset` is **explicitly excluded** and only has its secret access routed through `config.auth`.

**C2 — Phase 7 tx client threading undefined; helpers use the global `db`, so atomicity is illusory.** ACCEPTED (also Cl2). Phase 2 now defines `issueTokenPair(userId, exec=db)` and `storeToken(..., exec=db)` with an `Executor` type up front; Phase 7 enumerates adding the `exec` param to `markTokenRotated`, `findToken`, `deleteUserTokens`, `updateUser` and passing `tx` to all inner queries.

**C3 — Reset/refresh race: tokens must carry the version captured when the refresh was authorized; don't re-fetch after the increment.** ACCEPTED. Phase 7 now captures `session_version` at refresh-validation time and passes it into transactional issuance; equality check, missing claim = 0; `issueTokenPair` must NOT re-read the version inside the transaction. A test asserts a reset-before-issue interleaving yields a rejected token.

**C4 — Admin bootstrap not executable: `createUser` needs a password hash; "create-or-flag or register-then-flag" conflicts with reserved registration.** ACCEPTED (also Cl3). `scripts/grant-admin.ts` now **creates the account with a real bcrypt `password_hash`** (via `hashPassword`) and `is_admin=true` (idempotent upsert); register-then-flag removed; exact `npx tsx scripts/grant-admin.ts <email>` command; password taken via prompt/env, never a positional CLI arg; tests for create-login-capable + idempotency.

**C5 — System provisioning: undefined email when the canonical system email is occupied.** ACCEPTED (also Cl5). Phase 5 now defines the created row's email (the canonical reserved address, only creatable by the helper post-reservation) and specifies an **explicit fail-fast** (with operator-actionable log) when the unique-`email` insert collides with a pre-existing non-system row — not a re-read-by-`system_key` loop. Inspect-before-apply is a hard deploy precondition.

**C6 — Phase 6 mislabels unauthenticated logout as success/no-op; it returns 401.** ACCEPTED (also Cl smaller note). Phase 6 now preserves the **401** for no-token and invalid-token; only a valid access token proceeds to `deleteUserTokens`. Tests assert both 401 paths.

**C7 — The two open design choices should be selected now or gated.** ACCEPTED. Both **closed** in this iteration: opportunistic natural-expiry sweep (no cron); rotated-reuse = reject + log (no version bump). Recorded in Phase 7/9 + Notes.

---

## Claude (REQUEST_CHANGES) — code-verified

**Cl1 — Phase 3 is not "schema-only, safe": adding columns breaks hand-DDL pglite suites via drizzle column enumeration.** ACCEPTED. Phase 3 now lists same-commit DDL/fixture sync as REQUIRED deliverables: `tests/token-grace.test.ts` DDL, `tests/attribution-schema.test.ts` DDL, `tests/schema.test.ts` column assertions, and `User`-literal fixtures (`refresh-token-route.test.ts`, etc.). The "apply migration on pglite" *new* harness is dropped; the backfill predicate is tested via the existing hand-DDL pattern.

**Cl2 — Transactional rotation unimplementable without a tx executor.** ACCEPTED — see C2.

**Cl3 — Bootstrap circularity not broken; needs a bcrypt hash (admin page logs in email+password).** ACCEPTED — see C4.

**Cl4 — Startup assertion will fire during `next build` (both gates true in build; CI builds against unreachable `.env.ci` DB).** ACCEPTED. Added the `NEXT_PHASE !== 'phase-production-build'` guard to Phase 4 (all three conditions must hold), with a real-build verification step.

**Cl5 — `getOrCreateSystemUser` "re-read by system_key on conflict" is wrong for the hijacked case (conflict is on `email`).** ACCEPTED — see C5 (explicit fail-fast + operator log; defined created email).

**Cl6 — Anti-oracle depends on check *placement*, not just the string: existing 409 precedes the strength check.** ACCEPTED. Phase 4/5 now pin the reserved-address check **before** the password-strength check (adjacent to `register/route.ts:36`), ideally folded into the same branch; a placement test covers `reserved + weak-password` → still 409.

**Cl7 — Phase 9 inverts a green assertion (`token-grace.test.ts:147`).** ACCEPTED. Phase 9 now lists rewriting that assertion to the retention contract as an explicit deliverable.

**Smaller notes** — all ACCEPTED:
- Logout no-token stays **401** (Phase 6).
- pglite can't test real races → Phase 7 states races are tested as **deterministic interleavings**, and flags `db.transaction()` may serialize/deadlock existing pglite patterns (verify no hang).
- `User`-literal fixture churn (`admin-auth.test.ts`, `refresh-token-route.test.ts:40`) → covered by Phase 3 fixture-sync deliverable; `admin-auth.test.ts` is rewritten in Phase 4 (its `isAdmin(email)` target is removed).
- Sweep mechanism resolved now → **opportunistic** (no cron; `railway.toml` has none).

---

## Gemini (APPROVE)
No blocking issues; endorsed the foundation-first sequencing, anti-oracle rigor, and runbook ordering. Its observations are consistent with the accepted changes.

---

## Net effect
The plan's two structural gaps that would have bitten a builder mid-phase — **illusory transaction atomicity** (no executor threading) and **Phase 3 silently breaking the pglite suites** — are fixed with explicit, enumerated deliverables. The admin-bootstrap and system-lazy-create paths are now executable with defined credentials/emails and fail-fast behavior. The anti-oracle guarantee is pinned to *placement*, not just the error string. Both previously-open design choices are closed. No changes were rejected.
