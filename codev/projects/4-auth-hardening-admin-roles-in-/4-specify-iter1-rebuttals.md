# Rebuttal — Spec #4 (Auth Hardening), Specify iteration 1

**Verdicts:** Gemini APPROVE · Codex REQUEST_CHANGES · Claude REQUEST_CHANGES.

Both change-requests were high-confidence and code-grounded, and I agree with essentially all of them. The spec has been revised to incorporate each point. Below I address every REQUEST_CHANGES item with the disposition (ACCEPTED / ACCEPTED-WITH-NUANCE) and where it landed in the spec. There are no rejections.

---

## Codex (REQUEST_CHANGES)

**C1 — Refresh reuse semantics conflict (concurrent-both-succeed vs. reject rotated replay; indistinguishable in the 60s grace).** ACCEPTED.
Defined precise semantics in Desired State #5: **in-grace** → rotated token still validates (preserves issue #34 concurrent refresh); **post-grace** → the rotated row is retained until natural expiry and its reuse is *detected* (rejected + logged); **unknown hash** → forged/rejected. This makes acceptance/detection/rejection explicit and testable (new Success Criterion + non-functional test).

**C2 — Session-version must be checked during authentication of both token types, not refresh-only.** ACCEPTED. Resolved to check on **every** validation (access + refresh). Claude independently noted this is *free* because `authenticateRequest`/`findToken` already `innerJoin users`. Desired State #5, Constraints, Risks (perf risk downgraded to Low), Open Questions (resolved).

**C3 — "System marker" can't uniquely resolve AI-skill vs leaderboard; needs a unique immutable server-controlled key; define missing/duplicate/concurrent behavior.** ACCEPTED. Changed to a unique `system_key` (`'ai-skill'`/`'leaderboard'`) with a unique index; idempotent provisioning; migration/runbook handles a possibly-hijacked email row. Desired State #2, Constraints.

**C4 — Logout receives only the bearer access token; there is no "submitted refresh token"; require global `deleteUserTokens(user.id)` or define a pairing contract.** ACCEPTED. Resolved to full `deleteUserTokens(user.id)` (all-device), the issue-blessed option, with the all-device trade-off documented and no client wire change. Desired State #3, Constraints, Success Criteria.

**C5 — Close the feedback existence oracle testably: nonexistent / foreign-thread / mismatched-message must return the same status and shape.** ACCEPTED. Added the uniform-response requirement to Desired State #4 and a dedicated oracle-uniformity test in Test Scenarios / Success Criteria.

**C6 — Factual: `updateUser` supports email internally but its only caller updates `passwordHash`; no public email-update route. Correct the "user-mutable email" claim while keeping the pre-registration attack.** ACCEPTED. Corrected Problem Statement #1 and Current State: the pre-registration vector is the live one; the durable flag is defense-in-depth against any future email-change endpoint.

**C7 — The 128-char cap bounds work but doesn't prevent bcrypt's 72-byte truncation (esp. multibyte); don't claim truncation surprises are eliminated.** ACCEPTED-WITH-NUANCE. The `.max(128)` cap is a pinned (baked) decision, so it stays; I removed any implication that truncation is *eliminated* and documented the residual 72-byte/multibyte risk explicitly in Desired State #7 and Notes. No bcrypt behavior change is in scope.

---

## Claude (REQUEST_CHANGES)

**Cl1 — Logout: no refresh token in the request; the two offered options differ materially (breaking client change vs. all-device logout).** ACCEPTED. Same resolution as C4: full `deleteUserTokens(user.id)` (all-device), trade-off stated. The ambiguous "at minimum … or …" phrasing was removed.

**Cl2 — Reuse-detection vs. the expired-token sweep contradict: `deleteExpiredTokens` deletes post-grace rotated rows, and `findToken` returns undefined for them, making detection impossible without retaining rows.** ACCEPTED. Reconciled: the sweep deletes only tokens past **natural `expires_at`**; post-grace rotated rows are retained until expiry so reuse is distinguishable from a forged hash. Desired State #5/#7, new Sweep/retention Success Criterion, Risks.

**Cl3 — Migration backfill could promote an already-hijacked account to permanent system status; must verify legitimacy (`password_hash='nologin'` + `source`) and inspect-before-apply.** ACCEPTED. Backfill is now conditional on `password_hash='nologin' AND source IN ('ai-skill','leaderboard')` with an inspect-before-apply runbook step; promoted from nice-to-know to a Success Criterion + Risk row.

**Cl4 — A single `source='system'` marker can't disambiguate the two system identities; need marker + key.** ACCEPTED. Same as C3 — unique `system_key` per identity.

**Cl5 — Admin bootstrap has no path: registration of admin addresses is blocked and boot hard-fails if none exists → unbootable fresh deploy / CI break.** ACCEPTED. Added a documented out-of-band create-or-flag bootstrap (e.g. `scripts/grant-admin.ts`) as the sole admin-creation path, and gated the startup assertion to `NODE_ENV==='production'` so dev/CI don't hard-fail. Desired State #1, Success Criteria, Risks.

**Cl6 — Session-version scope has a free answer: check on the access path (join already returns the user); refresh-only leaves a pre-reset access token valid up to 2h.** ACCEPTED. Same as C2 — check everywhere; perf risk downgraded.

**Cl7 — Factual: `updateUser` reachable only from `reset_password` with `passwordHash`; no email-change endpoint.** ACCEPTED. Same as C6.

**Cl8 — Startup assertion has no natural App-Router hook; `instrumentation.ts register()` is the place but couples boot to DB reachability; gate on production.** ACCEPTED. Noted `instrumentation.ts register()` as the hook (per-instance, `NEXT_RUNTIME==='nodejs'`), gated to production, and documented the DB-reachability trade-off in Notes/Risks.

**Cl9 — Reserved-address/domain check must run against the normalized (lowercased) value; email normalization is already handled in create/update/find.** ACCEPTED. Desired State #1/#2 now state the check runs against the normalized value; Current State records existing normalization.

**Cl10 — Test Scenario 8 will fight the `getEnv()` memo (`cachedEnv`); existing tests set `JWT_SECRET` in `beforeAll`; need a cache reset / re-import.** ACCEPTED. Flagged in Test Scenarios; the plan will budget a cache-reset (or re-import) hook so the short-secret test is reliable.

---

## Gemini (APPROVE)
No blocking issues. Its three plan-phase notes — conditional system backfill SQL, dev/CI assertion handling, rotated-reuse logging under privacy rules (no user content / no unhashed tokens) — overlap the accepted changes above and are carried forward into Constraints/Risks for the plan.

---

## Net effect
Two genuine spec-level contradictions are now resolved (reuse-detection ⟷ sweep retention; concurrent-refresh ⟷ reuse rejection), the three under-determined decisions are decided (logout scope, system key, session-version scope), two safety gaps are closed as Success Criteria (conditional backfill, admin bootstrap), and two factual/wording corrections are applied. Two design-level choices remain deliberately open for the plan (the `deleteExpiredTokens` trigger mechanism, and rotated-reuse response strength) — these do not block spec approval.
