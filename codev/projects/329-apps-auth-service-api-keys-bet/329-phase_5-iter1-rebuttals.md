# Phase 5, iteration 1: response to review

## Codex (REQUEST_CHANGES) 1: signing after the commit breaks the locking invariant

**Not changed: this is the approved plan, decided on probe evidence. The spec text drift is real and has been raised with the security architect.**

Signing after the commit was adopted in plan iteration 2 (security review P1, `329-plan-iter2-rebuttals.md`) and is plan phase 5 step 7, approved at plan-approval. Signing inside the transaction holds a pooled connection while `signJWT` reads `jwks` on a second one. On real Postgres with a pool of 2, 10 concurrent exchanges then HANG with no connect timeout, or fail loudly with one (probe 4 E2, rerun today, in the review). Signing after the commit: 10/10 (E1, and F4 through the real functions). pglite shows the same hazard: a mutant that signs inside the transaction deadlocks its one connection.

Moving the signature out of the transaction does not add a new class of outcome. The spec already accepts each one as a residual after signing:
- **A ban or deletion that commits between our commit and `signJWT`:** the ban deletes the sessions, so the token's `sid` is dead. apps/api's first use fails the live-sid check and the consumer re-exchanges, which is then refused. The spec accepts exactly this for a ban one millisecond after signing ("the token then fails apps/api's first use").
- **A promotion to admin in that window:** with signing inside the transaction, a promotion that commits one millisecond after the commit leaves the holder with the same token in the same state. Admin authority is never in the token. It is `role` read at `/api/account/me` on every request, so the window is not an escalation path. The token carries only `{sub, sid}`, and the next exchange for that user is refused as `ineligible: admin`.
- **The invariant the spec states ("at signing time, the session outlives the token")** still holds: `expiresAt ≥ exp + SESSION_MARGIN` is checked under the lock against the same `exp` that is then signed. A session can only be deleted after the commit, never shortened.

**Spec drift:** spec §2 step 5 still says "the signing run in that one transaction". The approved plan and the code disagree with that sentence. I have asked the security architect whether to amend the spec text to match. I have not edited the approved spec unilaterally.

## Codex (REQUEST_CHANGES) 2: claim equivalence does not check `kid` or `definePayload`

**Accepted (in part) and fixed.** The test now asserts that the exchange JWT's header `kid` is present and equal to the `/api/auth/token` JWT's.

On `definePayload`: the `/token` JWT in that test is minted from the exchange's own session, and `/token` is better-auth's `getJwtToken`, which applies `definePayload`. So `{sub, sid}` equal to `/token`'s for the same session is a direct check of `definePayload`'s output. A comment now says so. 26/26 green.

## Gemini

Skipped again (`agy` exited with code 3). There is nothing to address.
