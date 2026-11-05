# Spec 329: response to the security architect's review rounds 1 and 2, plus owner decisions

Inputs: 329-specify-iter2-input-{codex,claude}.md (round 1, folded into 45e7d49), 329-specify-iter3-input-{codex,claude}.md (round 2), owner decisions D1–D4.

## Owner decisions (all adopted)
- D1: no strict BSUID regex; sanity bounds only (non-empty, ≤256 characters, no whitespace or control characters). The delegation-input criteria are restated as a property of the lookup.
- D2: BSUID stored raw.
- D3: optional `phone_number`, stored on `auth.users` as an additionalField with `input: false` and `returned: false`; absent from /me; one column; in the never-log list.
- D4: session row written directly in the lock transaction (`generateId(32)`, createSession's generator) under `FOR NO KEY UPDATE`; `runWithTransaction` + `createSession` is the probe-chosen alternative.

## Round 2: blocking (all accepted)
- C1 CORS: the exchange router is mounted before `corsFor`; the criterion is a finite Origin list plus a middleware-order test.
- C2 boot: fail only on `42P01` / a missing constraint; an unreachable database starts the service and `/health` reports it; added the converse criterion.
- C3 budget executor: pool, outside the transaction, after resolve and before the lock; the counter survives refused requests.
- C4 iat: explicit `{sub, sid, iat, exp}` to signJWT; claim-set equality with /token; definePayload agreement test; `exp` fixed before the session decision (non-circular).
- C5: corrected the claim that the per-user budget protects the key budget; the risk row was rewritten.
- C6: the check runs on every plugin refusal; a missing bearer is answered without the database; `APIKEY_RELATION_CHECK_TTL` in limits.ts; the criterion reads "after the cache window".

## Round 2: should-fix (all accepted)
- C7: 7 endpoints, 5 routed, filtered on a defined path. C8: lock_timeout and statement_timeout. C9: 500 is not retried per message; runbook repair for eligibility.
- C10: alerts carry counts and hash prefixes; user ids only in server log lines; key ids allowed in script events. C11: signJWT in probe 4, as a note.
- Testability: `SESSION_MARGIN` constant; deadlines on probes; the apps/api scan gets a scope, a known-bad line, a near miss and a hit count; key-storage criterion = full key absent, `start` null, hash equality; staging sign-off recorded on PR #327 with counts (5 messages in 1 s → 5 answers, 1 user, 1 session); finite variant and origin lists; the "no echo" criterion is restricted to the bearer, BSUID, phone and body.
- Codex extras: the boot check also asserts the account unique constraint; `X-Retry-After` is integer seconds from consumeWindow; "auth.apikey absent" means dropped under a running service.
- BSUID regex items: moot (D1).
