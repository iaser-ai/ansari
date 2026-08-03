# Specification: Refresh-Token Reuse — Revoke-on-Reuse Policy + markTokenRotated Result Handling

<!--
SPEC vs PLAN BOUNDARY:
This spec defines WHAT and WHY. The plan defines HOW and WHEN.
-->

## Metadata
- **ID**: spec-2026-08-02-refresh-token-reuse-decide-rev
- **Status**: draft
- **Created**: 2026-08-02

## Clarifying Questions Asked
This project runs autonomously from GitHub issue #16, which was filed from the PR #15
integration review and frames the questions itself. The answers were taken from the
issue body, the PR #15 review record, and the merged spec-4 code:

1. **What decision is being requested?** Whether detected reuse of a spent (rotated
   past grace) refresh token should revoke the token family, per OAuth 2.0 Security
   BCP (RFC 9700) §4.13.2 — and, separately, whether the discarded boolean result of
   `markTokenRotated` in the rotation transaction is a latent bug or provably safe.
2. **Is the revocation primitive in scope to build?** No — `bumpSessionVersion`
   already exists (spec 4) and is the project's uniform "kill all sessions" primitive.
   This spec decides *whether and how* to invoke it on reuse.
3. **Who arbitrates the policy?** The spec proposes and justifies a recommendation;
   the human spec-approval gate ratifies it. The DoS tradeoff flagged in the issue is
   weighed explicitly in Solution Approaches.

## Problem Statement
Spec 4 (PR #15) added rotated-token reuse *detection*: replaying a refresh token more
than the 60-second grace window after rotation is recognized (`lookupRefreshToken` →
`'reuse'`), rejected with a generic 401, and logged with the user's UUID. But nothing
is *done* about it. RFC 9700 §4.13.2 (OAuth 2.0 Security BCP) recommends that on
detected reuse the authorization server revoke the whole token family, because reuse
of a spent token is high-signal evidence that the token was stolen — and the server
cannot tell whether the replaying party or the holder of the newer token is the
attacker. Today a thief who exfiltrated a refresh token that has since been rotated
gets a 401 and a log line, while any sessions they may have established (by refreshing
*before* the victim did) survive untouched.

Separately, the rotation transaction discards `markTokenRotated`'s boolean result.
A `false` return conflates two very different situations — a benign concurrent
refresh inside the grace window, and the token row vanishing mid-transaction under a
concurrent revocation — and the code neither distinguishes them nor documents why
ignoring both is safe. This violates the project's fail-fast principle by silently
proceeding to issue tokens in a state the code did not anticipate.

## Current State
- `lookupRefreshToken` classifies a presented refresh token as `valid` (unexpired,
  never rotated or within grace), `reuse` (rotated past grace but retained until
  natural expiry — deliberately kept for detection), or `not_found`.
- On `reuse`, the refresh route logs `"Refresh token reuse detected for user <uuid>"`
  and returns the generic 401. **No revocation occurs.** The attacker's other
  sessions (if any) remain live; the victim is not protected.
- Reuse can also surface at a **second site**: the in-transaction recheck that
  serializes rotation against concurrent logout/reset. There it produces only a
  silent generic 401 — no log, and (a fortiori) no policy applied.
- `markTokenRotated(token, tx)` returns `true` only if it transitioned `rotated_at`
  from NULL. The refresh route ignores the result. The implicit safety argument —
  that any concurrent revocation bumps `session_version`, so tokens minted from the
  pre-revocation user row are dead on arrival at validation — is real but recorded
  nowhere in the code.
- Existing coverage: `session-version-reuse.test.ts` and `token-grace.test.ts` pin
  detection, grace-window behavior, and reset/logout-vs-refresh interleavings against
  a real (pglite) database.

## Desired State
- A **ratified, documented revoke-on-reuse policy**, implemented: detected reuse of a
  spent refresh token protects the account according to the chosen policy (see
  Solution Approaches; the recommendation is bounded family revocation), applied
  consistently at **both** detection sites.
- Repeated replays of the same stolen spent token cannot be used to harass the
  legitimate user indefinitely (the DoS vector from the issue is bounded by design).
- The external response for reuse remains byte-identical to other invalid-token
  failures (anti-oracle), and logging still carries only internal identifiers.
- `markTokenRotated`'s result is either acted upon (fail fast when the row vanished;
  proceed when already-rotated-in-grace) or its discard is justified by an
  explicit code comment stating the `session_version` safety argument — with the
  decision recorded in this spec. The desired state distinguishes the two `false`
  cases rather than conflating them.
- Tests pin the new behavior, including the interleavings, against a real database.

## Stakeholders
- **Primary Users**: Ansari end users — protected when their refresh token is stolen;
  must not be lockout-harassable by an attacker holding only a spent token.
- **Secondary Users**: Ops/on-call — reuse events must remain visible in logs and
  become actionable (revocation means the log line implies containment, not an alarm
  requiring manual response).
- **Technical Team**: Backend maintainers of the auth surface (`lib/auth`,
  `lib/db/users.ts`, the v2 auth routes).
- **Business Owners**: Project architect (spec-approval gate holder).

## Success Criteria
- [ ] Replaying a refresh token rotated more than the grace window ago triggers the
      ratified reuse policy (recommended: session-version bump revoking all of the
      user's outstanding tokens) — verified by an end-to-end test against pglite.
- [ ] A second replay of the *same* spent token does **not** re-trigger revocation
      (bounded-DoS property) — verified by test.
- [ ] Reuse surfacing via the in-transaction recheck applies the same policy and
      logging as the pre-validation site — verified by test.
- [ ] Concurrent refreshes within the grace window still both succeed (issue #34
      regression guard) and do not trigger the reuse policy.
- [ ] The rotation step no longer silently ignores a vanished token row: issuance
      does not proceed in that case (or, if the document-only option is ratified, a
      code comment states the session_version safety argument verbatim).
- [ ] The HTTP response for reuse is identical (status + body) to that for an
      unknown/expired refresh token (anti-oracle preserved).
- [ ] No new log line contains user content or raw token material.
- [ ] All tests pass; no reduction in coverage of the auth suites.
- [ ] Documentation updated (arch/lessons per the Review phase's tier routing).

## Constraints
### Technical Constraints
- `session_version` is the project's **only** sanctioned kill-all-sessions
  primitive; auth validates every token's embedded version against the user row
  (arch-critical). The policy must build on it, not invent a parallel mechanism.
- Token lifecycle mutations run inside `db.transaction` with the `exec`/`Executor`
  parameter threading (spec 4); new writes in those paths must use the transaction.
- Rotated-but-unexpired token rows are deliberately **retained** so replay is
  detectable; the sweep (`deleteExpiredTokens`) only removes past-natural-expiry
  rows. Any policy that consumes a token on reuse must not silently break this
  retention rationale — it may consume the row precisely *because* detection has
  already served its purpose for that token.
- Auth error responses are uniform/generic (anti-oracle, spec 4); reuse handling
  must not become distinguishable from ordinary invalid-token rejection.
- No user content in logs or Sentry; user UUIDs are acceptable internal identifiers.
- Fail fast, no silent fallbacks (project development principle #1).
- The full test suite must run without external services (pglite in-process DB).

### Business Constraints
- Follow-up scope from PR #15's review: intentionally small; no expansion into
  adjacent auth work (e.g. logout coverage, safeErrorMeta extension are separate
  issues).
- No baked decisions in issue #16 — the policy choice is this spec's deliverable,
  ratified at the spec-approval gate.

## Assumptions
- The 60-second grace window (issue #34) remains as-is; this spec does not retune it.
- A reuse event can only involve a token the server genuinely issued (the lookup keys
  on the stored hash), so "reuse" is never triggerable by forged input alone.
- Password login remains available to a victim whose sessions are revoked (recovery
  path exists; revocation is an inconvenience, not a lockout).
- `bumpSessionVersion` semantics (increment; all outstanding tokens embedded with an
  older version fail validation) are correct and tested — relied upon, not re-proven.

## Solution Approaches

### Approach 1: Status quo, documented (log-only)
**Description**: Keep detection + logging as the complete response. Record in code
and spec why revocation was rejected.

**Pros**:
- Zero risk of self-inflicted DoS: an attacker with a spent token can never log the
  victim out.
- No false-positive cost: a legitimate client that lost the rotation response to a
  network failure and retries past the grace window merely re-authenticates itself
  (one device), rather than logging every device out.
- No code change beyond comments.

**Cons**:
- Ignores RFC 9700 §4.13.2 guidance for the exact scenario it targets: when reuse is
  detected, the attacker may be the one holding the *newer* token (they refreshed
  first; the victim's replay is what trips detection). Log-only leaves the attacker's
  live session running.
- Turns every reuse log line into a manual incident (ops must investigate and revoke
  by hand) with no tooling to do so.
- The detection machinery (row retention past grace) exists purely to feed a log line.

**Estimated Complexity**: Low
**Risk Level**: Medium (accepts ongoing exposure the detection was built to catch)

### Approach 2: Unbounded family revocation (bump on every reuse)
**Description**: On every `reuse` classification, bump the user's `session_version`
(revoking all access + refresh tokens on all devices) and log.

**Pros**:
- Directly implements the BCP recommendation; attacker-held newer tokens die
  immediately, regardless of which party trips detection.
- Simplest possible policy: one primitive call at the detection sites.

**Cons**:
- **Unbounded DoS**: the spent-token row is retained until natural expiry (up to 90
  days), so an attacker holding only a spent token can re-replay it after each
  victim re-login, forcing a logout loop for as long as the row lives. This is the
  self-inflicted-DoS vector the issue explicitly flags.
- Amplifies the false-positive cost of the lost-response scenario: one device's
  network hiccup logs out every device — and could repeat.

**Estimated Complexity**: Low
**Risk Level**: High (weaponizable against the legitimate user)

### Approach 3 (RECOMMENDED): Bounded family revocation — revoke once, then consume the spent token
**Description**: On reuse, atomically (a) bump `session_version` — revoking the
entire family per the BCP — and (b) consume the replayed token row (remove it or
otherwise make it unable to re-trigger), so any further replay of that token reads as
`not_found` and is inert. One stolen spent token buys the attacker exactly one forced
re-login of the victim, never a loop. Applied identically at both detection sites,
with the existing log line kept (emitted at revocation time).

**Pros**:
- Implements the BCP's actual security goal: on evidence of theft, no token from the
  compromised family — including a newer one the attacker may hold — survives.
- Caps the DoS vector by construction: replay #2 of the same token cannot revoke
  anything. The victim experiences at most one surprise re-login per genuinely
  compromised token, which is arguably the correct UX for "your token was stolen."
- Consuming the row is consistent with the retention rationale — the row was
  retained *to detect first reuse*; once detected and acted on, retention has
  served its purpose.
- Uses only existing primitives (`bumpSessionVersion`, token deletion) inside the
  established transactional pattern.

**Cons**:
- The false-positive scenario (client loses the rotation response, retries after >60s)
  now logs out all of the user's devices once. Judged acceptable: the window is
  narrow, the event is rare, recovery is a normal login, and the server provably
  cannot distinguish this from theft (RFC 9700's own argument).
- Second-replay events are no longer log-distinguishable as "reuse" (the row is
  gone); the first-reuse log line is the lasting record. Minor observability trade.

**Estimated Complexity**: Medium
**Risk Level**: Low

### Approach 4: Partial revocation (refresh tokens only, no version bump)
**Description**: On reuse, delete the user's refresh tokens but leave access tokens
(≤2h lifetime) and `session_version` untouched.

**Pros**:
- Softer blast radius; active UI sessions survive until access expiry.

**Cons**:
- Leaves an attacker's stolen *access* token usable for up to 2 hours after theft was
  detected — contradicts the point of acting on detection.
- Introduces a second, weaker revocation idiom alongside `session_version`,
  violating the arch-critical constraint that version bump is the uniform primitive.
- Same DoS-bounding question as Approach 3 but with weaker protection.

**Estimated Complexity**: Medium
**Risk Level**: Medium

---

### markTokenRotated result — sub-decision (orthogonal to the policy above)

**Option A: Document-only.** Keep discarding the boolean; add a comment proving
safety: `false` means either already-rotated-in-grace (benign, must proceed — issue
#34) or row-vanished under concurrent revocation (tokens minted from the stale user
row embed a stale `session_version` and die at validation).

**Option B (RECOMMENDED): Distinguish and fail fast.** Make the rotation step
report *which* of the two `false` cases occurred. Proceed on already-rotated (grace
concurrency is a supported flow); abort issuance (generic 401) when the row vanished,
instead of minting tokens known to be dead on arrival. Rationale: aligns with the
fail-fast principle; removes sole reliance on the version-check backstop; the
distinction is cheap because the in-transaction recheck has already read the row.
Option B also keeps the safety comment for the already-rotated path.

## Open Questions

### Critical (Blocks Progress)
- [ ] None. The policy recommendation (Approach 3 + Option B) is this spec's
      proposal; ratification happens at the spec-approval gate.

### Important (Affects Design)
- [ ] Should the reuse log line be upgraded to a structured event (e.g. Sentry
      message without user content) so ops can alert on it, or is `console.warn`
      sufficient for now? (Default: keep `console.warn`; structured audit logging is
      out of scope.)
- [ ] On reuse detected at the in-transaction recheck, is it acceptable to apply the
      bump inside that same transaction (serialized with the rotation it aborts)?
      (Default: yes — same transactional pattern as reset/logout.)

### Nice-to-Know (Optimization)
- [ ] Whether the frontend should surface a distinct "you were signed out for
      security reasons" message on next login. Out of scope for the backend; noted
      for a possible frontend issue.

## Performance Requirements
- **Response Time**: No measurable regression on the refresh path — the reuse branch
  adds at most one UPDATE and one DELETE on an already-failing (401) request; the
  happy path adds no queries.
- **Throughput**: Unchanged; no new hot-path work.
- **Resource Usage**: Strictly reduced token-row retention (consumed reuse rows are
  removed earlier than natural expiry).
- **Availability**: No new external dependencies.

## Security Considerations
- **Threat model**: attacker exfiltrates a refresh token (device theft, log leak,
  network capture). If they refresh first, the victim's next refresh trips reuse; if
  the victim refreshed first, the attacker's replay trips it. In both cases the
  server cannot tell who is who — family revocation (Approach 3) is the only response
  that contains the attacker in both orderings.
- **Anti-oracle**: the reuse response must remain byte-identical to the generic
  invalid-token 401. Revocation must not change status, body, or observable timing
  class.
- **DoS resistance**: bounded by consume-on-reuse — one revocation per stolen spent
  token, never a loop.
- **Logging**: user UUID only; never raw or hashed token material, never user
  content. Unchanged from spec 4 discipline.
- **Atomicity**: revocation on reuse must not race token issuance into a state where
  a new pair survives the bump (the bump must be ordered/transacted such that any
  concurrently-minted pair embeds the pre-bump version and therefore dies).

## Test Scenarios
### Functional Tests
1. **Happy path regression**: valid refresh still rotates and issues; concurrent
   refresh within grace still succeeds for both callers (issue #34).
2. **Reuse revokes family**: replay a token rotated past grace → 401 generic body;
   user's previously-valid access and refresh tokens now fail validation.
3. **Bounded DoS**: replay the same spent token a second time → 401, `not_found`
   classification, session_version unchanged from the first reuse; a fresh
   post-reuse login session is unaffected.
4. **In-transaction detection site**: revocation/logout racing a refresh such that
   reuse/not_found is first seen at the recheck → same policy outcome, no token pair
   issued.
5. **Vanished-row rotation** (Option B): token row deleted between validation and
   rotation → no tokens issued, generic 401.
6. **False-positive path**: legitimate retry after >grace (lost response) → treated
   as reuse (documented, asserted) — family revoked once, password login recovers.

### Non-Functional Tests
1. **Anti-oracle**: response status + body for reuse === response for unknown token.
2. **Log hygiene**: reuse log contains UUID only (no token material, no email).
3. **Atomicity under interleaving**: reuse-triggered bump vs concurrent refresh
   issuance — minted pair must not survive (pglite transaction test).

## Dependencies
- **External Services**: None.
- **Internal Systems**: spec-4 auth machinery — `session_version` validation,
  `lookupRefreshToken` classification, transactional token lifecycle, grace window.
- **Libraries/Frameworks**: Existing stack only (Drizzle, pglite for tests). No new
  dependencies.

## References
- GitHub issue #16 (this project) — filed from PR #15 integration review.
- PR #15 / spec 4: `codev/specs/4-auth-hardening-admin-roles-in-.md` (reuse
  detection, session_version, transactional rotation).
- RFC 9700 (OAuth 2.0 Security Best Current Practice) §4.13.2 — refresh token
  rotation and revocation on reuse detection. (The issue cites this as "OAuth BCP
  §4.13.2".)
- Issue #34 — refresh-token grace window for concurrent SPA refreshes.
- `codev/resources/arch-critical.md` — session_version as the uniform revocation
  primitive; transactional `exec` threading.

## Risks and Mitigation
| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| Legit user logged out by lost-response retry (false positive) | Low | Medium | Bounded to one event per token; grace window absorbs normal retries; normal login recovers; behavior asserted in tests so it's a documented decision, not an accident |
| Attacker loops revocation with one spent token (DoS) | — | High if unmitigated | Eliminated by design: token consumed on first reuse; replay reads `not_found` |
| Revocation races issuance, new pair survives bump | Low | High | Transactional ordering requirement in Security Considerations; dedicated interleaving test on pglite |
| Reuse response becomes distinguishable (oracle) | Low | Medium | Anti-oracle equality test (status + body) |
| Scope creep into adjacent auth follow-ups | Medium | Low | Constraints section pins scope to issue #16's two items |

## Expert Consultation
<!-- Populated after porch-run 3-way consultation -->
**Date**: pending
**Models Consulted**: pending (Gemini, Codex, Claude via porch verify)
**Sections Updated**: pending

## Approval
- [ ] Technical Lead Review
- [ ] Product Owner Review
- [ ] Stakeholder Sign-off
- [ ] Expert AI Consultation Complete

## Notes
- The builder branch predated PR #15's merge; `origin/develop` was merged in
  (commit 5ab8a9d) before drafting so this spec describes the actual integrated
  code, not the pre-spec-4 state.
- Recommendation summary for the gate: **Approach 3** (revoke family once via
  `session_version` bump, consume the spent token so replays are inert) plus
  **Option B** for `markTokenRotated` (distinguish already-rotated from vanished;
  fail fast on vanished). Approach 1 (log-only) is the fallback if the architect
  judges any forced-logout risk unacceptable; it should then be recorded as an
  explicit accepted-risk decision in code comments and lessons-learned.
