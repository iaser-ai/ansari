# Specification: Refresh-Token Reuse — Revoke-on-Reuse Policy + markTokenRotated Result Handling

<!--
SPEC vs PLAN BOUNDARY:
This spec defines WHAT and WHY. The plan defines HOW and WHEN.
-->

## Metadata
- **ID**: spec-2026-08-02-refresh-token-reuse-decide-rev
- **Status**: draft (policy ratified by architect 2026-08-03; awaiting spec-approval gate)
- **Created**: 2026-08-02

## Ratified Decision (2026-08-03, human/architect)

This spec's deliverable was a policy decision. The decision has been made — **slim
Approach 3 + Option A** — and this document now states it as *the* specification.
The alternatives and cut refinements are retained below only as decision record.

1. **Revoke on reuse.** When either detection site classifies a presented refresh
   token as `reuse` (and only `reuse` — never `not_found`), the server
   transactionally: bumps the user's `session_version`, deletes the user's
   refresh-token rows (`deleteUserTokens(userId, 'refresh')`), and emits the
   containment log line (user UUID only).
2. **Unified generic 401 at the route boundary.** All refresh-route rejections
   share one generic 401 status + body, normalized at the route boundary only —
   internal classification strings/results are not refactored.
3. **`markTokenRotated`: Option A (document-only).** The discarded boolean stays
   discarded, with a code comment recording the safety argument.
4. **Deliberately cut** (accepted-risk / documented-not-prevented — see Security
   Considerations): exactly-once winner semantics for concurrent replays (a benign
   double bump/log is accepted and documented); Option C's row lock; in-transaction
   stale-authorization re-verification (stale pairs die at `session_version`
   validation — document, don't prevent).

## Clarifying Questions Asked
This project runs autonomously from GitHub issue #16, which was filed from the PR #15
integration review and frames the questions itself. The answers were taken from the
issue body, the PR #15 review record, and the merged spec-4 code:

1. **What decision is being requested?** Whether detected reuse of a spent (rotated
   past grace) refresh token should revoke the token family, per OAuth 2.0 Security
   BCP (RFC 9700 §4.14.2; the issue cites it under the pre-RFC draft numbering,
   §4.13.2) — and, separately, whether the discarded boolean result of
   `markTokenRotated` in the rotation transaction is a latent bug or provably safe.
2. **Is the revocation primitive in scope to build?** No — `bumpSessionVersion`
   already exists (spec 4) and is the project's uniform "kill all sessions" primitive.
   This spec decides *whether and how* to invoke it on reuse.
3. **Who arbitrates the policy?** The human. The decision was ratified by the
   architect on 2026-08-03 and is recorded above.

## Problem Statement
Spec 4 (PR #15) added rotated-token reuse *detection*: replaying a refresh token more
than the 60-second grace window after rotation is recognized (`lookupRefreshToken` →
`'reuse'`), rejected with a 401, and logged with the user's UUID. But nothing is
*done* about it. RFC 9700 §4.14.2 (OAuth 2.0 Security BCP) recommends that on
detected reuse the authorization server revoke the refresh-token lineage, because
reuse of a spent token is high-signal evidence that the token was stolen — and the
server cannot tell whether the replaying party or the holder of the newer token is
the attacker. Today a thief who exfiltrated a refresh token that has since been
rotated gets a 401 and a log line, while any sessions they may have established (by
refreshing *before* the victim did) survive untouched.

Separately, the rotation transaction discards `markTokenRotated`'s boolean result.
A `false` return conflates two situations — a benign concurrent refresh inside the
grace window, and the token row vanishing mid-transaction under a concurrent
revocation — and the code neither distinguishes them nor documents why ignoring
both is safe.

## Current State
- `lookupRefreshToken` classifies a presented refresh token as `valid` (unexpired,
  never rotated or within grace), `reuse` (rotated past grace but retained until
  natural expiry — deliberately kept for detection), or `not_found`.
- On `reuse`, the refresh route logs `"Refresh token reuse detected for user <uuid>"`
  and returns a 401. **No revocation occurs.** The attacker's other sessions (if
  any) remain live; the victim is not protected.
- The refresh path's 401 bodies are **not uniform today**: reuse returns
  `"Invalid or expired refresh token"`, an unknown/expired token returns
  `"Refresh token not found or expired"`, and a stale `session_version` returns
  `"Session no longer valid"`. The three cases are therefore already
  distinguishable to a caller — a pre-existing (minor) oracle on the refresh path.
- Reuse can also surface at a **second site**: the in-transaction recheck that
  serializes rotation against concurrent logout/reset. There it produces only a
  silent 401 — no log, and (a fortiori) no policy applied. A `not_found` at the
  same recheck is the *normal* outcome of a logout/reset winning the race and is not
  a security signal.
- `markTokenRotated(token, tx)` returns `true` only if it transitioned `rotated_at`
  from NULL. The refresh route ignores the result. The implicit safety argument —
  that any concurrent revocation bumps `session_version`, so tokens minted from the
  pre-revocation user row are dead on arrival at validation — is real but recorded
  nowhere in the code.
- Existing coverage: `session-version-reuse.test.ts` and `token-grace.test.ts` pin
  detection, grace-window behavior, stale-version rejection, and
  reset/logout-vs-refresh interleavings against a real (pglite) database.

## Desired State
- Detected reuse of a spent refresh token **contains the compromise**: within a
  single transaction, the user's `session_version` is bumped (revoking every
  outstanding access and refresh token on all devices) and the user's refresh-token
  rows are deleted, and the containment log line is emitted. This applies wherever
  a token is classified as `reuse` — at pre-validation and at the in-transaction
  recheck — and **only** on `reuse`: a `not_found` (including the normal
  logout-wins-the-race outcome at the recheck) never triggers revocation or a reuse
  log.
- The DoS vector from the issue is bounded **per compromise**: after one
  revocation, no retained refresh row for the account remains, so any later replay
  of the same (or any other previously-leaked) spent token reads `not_found` and is
  inert. A fresh post-reuse login is unaffected by further replays.
- The refresh route returns **one unified generic 401** (single status + body) for
  every rejection — reuse, unknown, expired, stale-version, and replay-after-
  consume — normalized at the route boundary; internal classification results and
  their strings are unchanged. This establishes the anti-oracle property the policy
  depends on (in particular, a later replay must not confirm that revocation fired).
- `markTokenRotated`'s discarded result is documented in place with the safety
  argument (Option A); the two `false` cases are no longer conflated *silently*.
- Tests pin the new behavior against a real database (see Test Scenarios — slim
  matrix; existing suites already cover grace-window and stale-version mechanics).

## Stakeholders
- **Primary Users**: Ansari end users — protected when their refresh token is stolen;
  not lockout-harassable by an attacker holding only a spent token.
- **Secondary Users**: Ops/on-call — reuse events remain visible in logs and imply
  containment happened, not an alarm requiring manual response.
- **Technical Team**: Backend maintainers of the auth surface (`lib/auth`,
  `lib/db/users.ts`, the v2 auth routes).
- **Business Owners**: Project architect (spec-approval gate holder; ratified the
  policy 2026-08-03).

## Success Criteria
- [ ] Replaying a refresh token rotated more than the grace window ago bumps the
      user's `session_version` and deletes the user's refresh-token rows in one
      transaction, with the containment log emitted — previously-valid access and
      refresh tokens all fail validation afterward (pglite end-to-end test).
- [ ] A later replay of the same spent token is inert: classified `not_found`, no
      further bump, and a fresh post-reuse login session is unaffected (test).
- [ ] Every refresh-route rejection returns the same generic 401 status + body
      (anti-oracle established; test).
- [ ] Reuse at the in-transaction recheck applies the same policy + log; `not_found`
      there aborts issuance with the generic 401 and no revocation and no reuse log.
- [ ] `markTokenRotated`'s call site carries the Option A safety comment.
- [ ] Concurrent refreshes within the grace window still both succeed (issue #34 —
      existing suite must stay green).
- [ ] No new log line contains user content or raw token material.
- [ ] All tests pass; no reduction in coverage of the auth suites.
- [ ] Documentation updated (arch/lessons per the Review phase's tier routing).

## Constraints
### Technical Constraints
- `session_version` is the project's **only** sanctioned kill-all-sessions
  primitive; auth validates every token's embedded version against the user row
  (arch-critical). The policy builds on it, plus the existing deletion primitives —
  no parallel revocation mechanism.
- Token lifecycle mutations run inside `db.transaction` with the `exec`/`Executor`
  parameter threading (spec 4); the reuse-containment writes must share one
  transaction.
- Rotated-but-unexpired token rows are deliberately **retained** so replay is
  detectable; the sweep (`deleteExpiredTokens`) only removes past-natural-expiry
  rows. Consuming the account's refresh rows on detected reuse is consistent with
  this rationale — retention exists to enable first-reuse detection, which has then
  served its purpose for that account.
- Auth error responses must be uniform/generic. The refresh route does not satisfy
  this today (three distinct 401 bodies); unifying them **at the route boundary
  only** is in scope as a prerequisite of the reuse policy. Internal classification
  strings are not refactored.
- No user content in logs or Sentry; user UUIDs are acceptable internal identifiers.
- The full test suite must run without external services (pglite in-process DB).

### Business Constraints
- Follow-up scope from PR #15's review: intentionally small; no expansion into
  adjacent auth work (e.g. logout coverage, safeErrorMeta extension are separate
  issues). The route-boundary 401 unification is the one deliberate addition,
  because the policy's anti-oracle requirement is unmeetable without it.
- The policy choice was the spec's deliverable; it is ratified (see Ratified
  Decision) and is not to be re-litigated in plan or implementation.

## Assumptions
- The 60-second grace window (issue #34) remains as-is; this spec does not retune it.
- A reuse event can only involve a token the server genuinely issued (the lookup keys
  on the stored hash), so "reuse" is never triggerable by forged input alone.
- Password login remains available to a victim whose sessions are revoked (recovery
  path exists; revocation is an inconvenience, not a lockout).
- `bumpSessionVersion` semantics (increment; all outstanding tokens embedded with an
  older version fail validation) are correct and tested — relied upon, not re-proven.

## Solution Approaches

> **Decision record.** Approach 3 (slim variant, as ratified — see Ratified
> Decision) was chosen. Approaches 1, 2, and 4 were considered and rejected;
> Options B/C and three hardening refinements were considered and deliberately cut.
> Kept for the record; not open questions.

### Approach 1: Status quo, documented (log-only) — REJECTED
Keep detection + logging as the complete response. Rejected because it ignores RFC
9700 §4.14.2 for the exact scenario detection was built to catch: when reuse trips,
the attacker may hold the *newer* token, and log-only leaves their session running
while ops gets an unactionable alarm.

### Approach 2: Unbounded account revocation (bump on every reuse) — REJECTED
Bump `session_version` on every `reuse` classification, retaining spent rows until
natural expiry. Rejected for the self-inflicted-DoS vector the issue flags: a spent
token stays a revocation trigger for up to 90 days, enabling a logout loop against
the victim.

### Approach 3 (RATIFIED, slim): Bounded account revocation — revoke, consume the family
On `reuse` (either detection site, never `not_found`): transactionally bump
`session_version`, delete the user's refresh-token rows
(`deleteUserTokens(userId, 'refresh')` — which also consumes the replayed row), and
emit the containment log. Any later replay reads `not_found` and is inert, so the
DoS bound is one forced re-login per compromise, not per leaked token.

Note on strength: this is deliberately **stronger** than RFC 9700 §4.14.2's minimum
(revoking the refresh-token lineage). `session_version` revokes *every* session and
access token for the account, because it is the project's single sanctioned
revocation primitive (arch-critical) and theft of one token gives no assurance about
which sessions are the attacker's.

Accepted costs (documented, not mitigated):
- **False positive**: a legitimate client that lost the rotation response and
  retries after the grace window logs out all the user's devices once. Rare, narrow
  window, normal login recovers — and the server provably cannot distinguish this
  from theft (RFC 9700's own argument).
- **Benign double bump/log**: two near-simultaneous replays of the same spent token
  may each apply the policy before the other's delete lands (no winner-selection
  semantics — deliberately cut). Outcome: `session_version` advances twice, two log
  lines. Harmless — the deletes are idempotent, all pre-reuse tokens are equally
  dead, and no legitimate session exists at that moment to disturb.
- **Observability**: later replays are not log-distinguishable as "reuse" (rows are
  gone); the first-reuse log line is the lasting record — required anyway, since
  distinguishing them in the response would confirm to the attacker that revocation
  fired.

### Approach 4: Partial revocation (refresh tokens only, no version bump) — REJECTED
Deleting refresh rows while leaving access tokens (≤2h) alive contradicts acting on
detected theft and introduces a second, weaker revocation idiom alongside
`session_version`, violating the arch-critical uniformity constraint.

---

### markTokenRotated result — sub-decision

**Option A (RATIFIED): Document-only.** Keep discarding the boolean; add a code
comment at the call site recording the safety argument: `false` means either
(a) already-rotated-in-grace — benign and *required* to proceed (issue #34
concurrent refreshes), or (b) the row vanished under a concurrent revocation —
in which case the pair minted from the transaction's user-row read embeds a
`session_version` that the concurrent revocation has bumped past, so the pair is
dead on arrival at validation. Ignoring the boolean is therefore safe in both
cases; the comment makes the conflation explicit instead of silent.

**Option B (cut): distinguish-and-fail-fast.** Requires an extra post-failure read
to disambiguate under READ COMMITTED; adds machinery to prevent an outcome that is
already harmless.

**Option C (cut): row lock in the recheck.** `SELECT … FOR UPDATE` would eliminate
the vanished-row case but adds lock-ordering obligations against logout/reset for
no behavioral gain over the documented safety argument.

## Open Questions

### Critical (Blocks Progress)
- [ ] None — the policy is ratified.

### Important (Affects Design)
- [ ] Should the reuse log line be upgraded to a structured event (e.g. Sentry
      message without user content) so ops can alert on it, or is `console.warn`
      sufficient for now? (Default: keep `console.warn`; structured audit logging is
      out of scope.)

### Nice-to-Know (Optimization)
- [ ] Whether the frontend should surface a distinct "you were signed out for
      security reasons" message on next login. Out of scope for the backend; noted
      for a possible frontend issue.

## Performance Requirements
- **Response Time**: No measurable regression — the containment branch adds writes
  only on an already-failing (401) request; the happy path is unchanged.
- **Throughput**: Unchanged; no new hot-path work.
- **Resource Usage**: Strictly reduced token-row retention (consumed rows are
  removed earlier than natural expiry).
- **Availability**: No new external dependencies.

## Security Considerations
- **Threat model**: attacker exfiltrates a refresh token (device theft, log leak,
  network capture). If they refresh first, the victim's next refresh trips reuse; if
  the victim refreshed first, the attacker's replay trips it. In both cases the
  server cannot tell who is who — account-wide revocation is the only response that
  contains the attacker in both orderings.
- **Anti-oracle**: one generic 401 status + body for every refresh-route rejection,
  normalized at the route boundary. Scope is response **status and body** only; a
  timing-side-channel guarantee is explicitly out of scope (the containment branch
  performs extra writes; no practical timing-equality criterion exists at this
  layer, and timing tells the attacker nothing actionable that the unified response
  doesn't already deny).
- **Concurrent replays (double bump) — accepted**: winner-selection ("exactly-once")
  semantics were deliberately cut. A double bump/double log is benign (idempotent
  deletes; all stale tokens equally dead; no live legitimate session at that
  moment). The implementation documents this rather than serializing replays.
- **Stale-authorization interleaving — documented, not prevented**: a refresh
  authorized before a concurrent reuse-containment commits will either (a) run its
  in-transaction recheck against the pre-commit snapshot — minting a pair that
  embeds the *old* `session_version`, which the bump kills at validation — or
  (b) see the post-commit state, where its token row has been deleted
  (`not_found`) and nothing is issued. Either way no usable pair survives; this
  argument is recorded in code comments, and no in-transaction re-verification or
  locking is added for it.
- **DoS resistance**: bounded per-compromise — containment removes the replayed row
  and the account's other refresh rows, so no retained token remains to re-trigger
  revocation.
- **Logging**: user UUID only; never raw or hashed token material, never user
  content. Unchanged from spec 4 discipline.

## Test Scenarios
Slim matrix (ratified): three focused tests. Existing suites
(`session-version-reuse.test.ts`, `token-grace.test.ts`, `refresh-token-route.test.ts`)
already pin grace-window concurrency, stale-version rejection, and the
reset/logout-vs-refresh interleavings, and must remain green.

### Functional Tests
1. **First reuse contains the compromise**: replay a token rotated past grace →
   generic 401; `session_version` bumped; the user's refresh rows are deleted;
   previously-valid access and refresh tokens now fail validation; containment log
   emitted (UUID only).
2. **Later replay is inert**: replay the same spent token again → generic 401 via
   `not_found`, no further bump — and a fresh post-reuse login session is
   unaffected by the replay.
3. **Unified 401**: refresh-route rejections (reuse, unknown token, expired,
   stale-version, replay-after-consume) share one generic status + body.

### Non-Functional Tests
1. Log-hygiene assertion folded into test 1 (UUID only; no token material) — no
   separate scenario.

## Dependencies
- **External Services**: None.
- **Internal Systems**: spec-4 auth machinery — `session_version` validation,
  `lookupRefreshToken` classification, transactional token lifecycle
  (`exec`/`Executor` threading), grace window.
- **Libraries/Frameworks**: Existing stack only (Drizzle, pglite for tests). No new
  dependencies.

## References
- GitHub issue #16 (this project) — filed from PR #15 integration review.
- PR #15 / spec 4: `codev/specs/4-auth-hardening-admin-roles-in-.md` (reuse
  detection, session_version, transactional rotation).
- RFC 9700 (OAuth 2.0 Security Best Current Practice) **§4.14.2** — refresh token
  rotation and revocation on reuse detection. The issue and PR #15 review cite this
  as "OAuth BCP §4.13.2" (pre-RFC draft numbering); code comments must cite the RFC
  section.
- Issue #34 — refresh-token grace window for concurrent SPA refreshes.
- `codev/resources/arch-critical.md` — session_version as the uniform revocation
  primitive; transactional `exec` threading.

## Risks and Mitigation
| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| Legit user logged out by lost-response retry (false positive) | Low | Medium | Bounded to one event per compromise; grace window absorbs normal retries; normal login recovers; asserted in tests as a documented decision |
| Attacker loops revocation with spent token(s) (DoS) | — | High if unmitigated | Eliminated by design: replayed row and the account's other refresh rows consumed on first reuse; replay reads `not_found` |
| Double bump under concurrent replays | Medium | Low (benign) | Accepted and documented (idempotent deletes; no winner semantics — deliberate cut) |
| Refresh racing containment mints a surviving pair | Low | High if real | Shown impossible by snapshot argument (old-version pair dies at validation; post-commit sees `not_found`); documented in code, existing stale-version suite covers the kill mechanism |
| Reuse response distinguishable (oracle) | Medium (exists today as 3 distinct bodies) | Medium | Route-boundary 401 unification (in scope); equality test across all rejection cases |
| Scope creep into adjacent auth follow-ups | Medium | Low | Constraints pin scope to issue #16's two items + the route-boundary 401 unification |

## Expert Consultation
**Date**: 2026-08-02
**Models Consulted**: Gemini (APPROVE), Codex (REQUEST_CHANGES), Claude
(REQUEST_CHANGES) — 3-way porch consultation, iteration 1. Rebuttal:
`codev/projects/16-refresh-token-reuse-decide-rev/16-specify-iter1-rebuttals.md`.
**Sections Updated** (iteration 1):
- Problem Statement / References: RFC citation corrected to RFC 9700 §4.14.2 (issue
  cited draft numbering §4.13.2); session_version bump described as deliberately
  stronger than the RFC's lineage revocation (Codex).
- Current State: documented the three distinct 401 bodies (pre-existing oracle)
  (Claude).
- `reuse`-only trigger made explicit — `not_found` (logout-wins race) never
  revokes (Codex + Claude); consume mechanism named (Claude); per-compromise DoS
  bound via `deleteUserTokens(userId,'refresh')` (Claude).
- Anti-oracle scoped to status+body semantics, timing out of scope (Codex).

**Human ratification (2026-08-03)**: the architect ratified slim Approach 3 +
Option A and cut three reviewer-originated hardening items (exactly-once winner
semantics; Option C row lock; in-transaction stale-authorization re-verification)
as machinery preventing already-harmless outcomes. The cuts and their safety
arguments are recorded in Ratified Decision, Solution Approaches, and Security
Considerations; the test matrix was slimmed to three focused tests accordingly.

## Approval
- [ ] Technical Lead Review
- [ ] Product Owner Review
- [ ] Stakeholder Sign-off
- [x] Expert AI Consultation Complete

## Notes
- The builder branch predated PR #15's merge; `origin/develop` was merged in
  (commit 5ab8a9d) before drafting so this spec describes the actual integrated
  code, not the pre-spec-4 state.
- Per the ratification-sequencing commitment from iteration 1, this spec has been
  edited to state the ratified choice as *the* decision; conditional phrasing is
  collapsed and alternatives are retained as decision record only.
