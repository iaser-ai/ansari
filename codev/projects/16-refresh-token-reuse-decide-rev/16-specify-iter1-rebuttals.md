# Spec 16 — Specify iteration 1 rebuttals

Verdicts: Gemini APPROVE · Codex REQUEST_CHANGES · Claude REQUEST_CHANGES.
All REQUEST_CHANGES points are addressed below; every one resulted in a spec change
(none are disputed on substance, one is narrowed).

## Codex

1. **Exactly-once revocation underspecified (concurrent replays double-bump).**
   ACCEPTED. Desired State and Security Considerations now require that only the
   request whose atomic consume of the spent row succeeds applies the bump and log;
   Success Criteria and Test Scenario 6 add a concurrent-replay test asserting
   exactly one bump and one log.

2. **Concurrent refresh can survive the reuse bump (authorized-pre-bump /
   issuing-post-bump mints tokens embedding the NEW version).** ACCEPTED — this was
   a real gap: the in-transaction recheck reads the *current* user row, so a refresh
   validated pre-bump would issue a pair embedding the post-bump version. The spec
   now requires re-verification of the presented token's embedded `session_version`
   against the user row *inside* the serialized transaction (Security
   Considerations "stale-authorization gap"; Success Criteria; Test Scenario 7).
   Note: Claude's review asserted this atomicity "is already satisfied" — that
   analysis covered the bump-before-validation and bump-after-issuance orderings but
   not this middle interleaving, so Codex's point stands and is incorporated; per
   Claude's related caution, it is stated as verify-and-test with no locking beyond
   Option C.

3. **RFC citation wrong (§4.14.2, not §4.13.2) and "family revocation"
   mischaracterized.** ACCEPTED. All citations corrected to RFC 9700 §4.14.2, with
   an explicit note that the issue used the pre-RFC draft numbering. The spec now
   states that the `session_version` bump is deliberately *stronger* than the RFC's
   refresh-lineage revocation (account-wide), and why (uniform primitive,
   arch-critical; theft gives no assurance about which sessions are the attacker's).
   Approach headings renamed from "family" to "account" revocation accordingly.

4. **Second-site test conflates `reuse` and `not_found`.** ACCEPTED (also raised by
   Claude). Test Scenario 4/5 now split them with opposite expectations: recheck
   `reuse` → policy applied; recheck `not_found` (logout/reset won the race) →
   abort issuance, generic 401, **no** bump, **no** reuse log. Desired State states
   the policy triggers on `reuse` only.

5. **Anti-oracle requirements conflict (timing-class untestable).** ACCEPTED —
   narrowed as suggested. The requirement is now scoped to identical response
   status + body semantics; a timing-side-channel guarantee is explicitly out of
   scope, with the rationale recorded.

## Claude

1. **Anti-oracle premise factually wrong (three distinct 401 bodies exist today);
   Approach 3 would widen the leak (replay #2 body reveals revocation fired).**
   ACCEPTED — verified against `middleware.ts` / `route.ts`; the reviewer is right
   that the spec claimed a property the code doesn't have. Current State now
   documents the three bodies as a pre-existing oracle; unifying the refresh-path
   401s is scoped IN as a prerequisite (Constraints justify the scope addition);
   Desired State / Success Criteria say "established", not "preserved"; NF test 1
   now asserts equality across all five rejection cases including
   already-consumed replay.

2. **Option B's "distinction is cheap" is incorrect (READ COMMITTED, no lock);
   add row-lock Option C.** ACCEPTED. Option B retains a corrected feasibility
   caveat; new Option C (`SELECT … FOR UPDATE` on the token row in the recheck) is
   added and is now the recommendation — it eliminates the vanished-row case rather
   than detecting it, making the discarded boolean provably safe by construction.
   Lock-ordering vs logout/reset is flagged as a mandated plan-phase item (also in
   Risks). Test Scenario 8 covers the Option C concurrency behavior, and the
   Dependencies section flags that pglite must genuinely exercise the lock
   semantics (else the plan must state the verification strategy).

3. **`reuse` vs `not_found` at the recheck.** ACCEPTED — same fix as Codex #4.

4. **DoS bound is per-token, not per-compromise; decide whether reuse also deletes
   the user's other refresh rows.** ACCEPTED — decided in the affirmative:
   Approach 3 now consumes the replayed row **and** runs
   `deleteUserTokens(userId, 'refresh')`, tightening the bound to one forced
   re-login per compromise and making "family revocation" literal. Success
   Criteria, Desired State, and Test Scenario 2 updated.

5. **Atomicity requirement risks plan inventing unnecessary locking.** ACCEPTED in
   spirit, amended by Codex #2: the property is *not* fully guaranteed today (the
   authorized-pre-bump interleaving), so the spec keeps it as a requirement — but
   phrased as in-transaction re-verification + ordering test, with an explicit
   instruction that no locking beyond Option C's row lock is to be added.

6. **"Consume the row" mechanism-agnostic.** ACCEPTED. `deleteToken` /
   `deleteUserTokens` are named explicitly in Approach 3.

7. **Ratification sequencing.** ACCEPTED. Notes now commit to editing the spec to
   the ratified choice (collapsing conditionals) before the Plan phase starts.

8. **RFC section verification.** ACCEPTED — folded into Codex #3.

## Gemini

APPROVE, no issues. One correction to its summary for the record: it endorsed the
spec citing "§4.13.2"; the correct RFC 9700 section is §4.14.2 (fixed per Codex).
