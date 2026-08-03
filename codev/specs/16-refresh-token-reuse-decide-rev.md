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
   BCP (RFC 9700 §4.14.2; the issue cites it under the pre-RFC draft numbering,
   §4.13.2) — and, separately, whether the discarded boolean result of
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
`'reuse'`), rejected with a 401, and logged with the user's UUID. But nothing is
*done* about it. RFC 9700 §4.14.2 (OAuth 2.0 Security BCP) recommends that on
detected reuse the authorization server revoke the refresh-token lineage, because
reuse of a spent token is high-signal evidence that the token was stolen — and the
server cannot tell whether the replaying party or the holder of the newer token is
the attacker. Today a thief who exfiltrated a refresh token that has since been
rotated gets a 401 and a log line, while any sessions they may have established (by
refreshing *before* the victim did) survive untouched.

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
- The presented token's embedded `session_version` is checked against the user row
  only in pre-transaction validation, not re-checked inside the rotation
  transaction.
- `markTokenRotated(token, tx)` returns `true` only if it transitioned `rotated_at`
  from NULL. The refresh route ignores the result. The implicit safety argument —
  that any concurrent revocation bumps `session_version`, so tokens minted from the
  pre-revocation user row are dead on arrival at validation — is real but recorded
  nowhere in the code. The in-transaction recheck runs under READ COMMITTED with no
  row lock, so a concurrent delete can land between the recheck's read and the
  rotation UPDATE.
- Existing coverage: `session-version-reuse.test.ts` and `token-grace.test.ts` pin
  detection, grace-window behavior, and reset/logout-vs-refresh interleavings against
  a real (pglite) database.

## Desired State
- A **ratified, documented revoke-on-reuse policy**, implemented: detected reuse of a
  spent refresh token protects the account according to the chosen policy (see
  Solution Approaches; the recommendation is bounded family revocation). The policy
  applies wherever a token is classified as `reuse` — at pre-validation and at the
  in-transaction recheck — and **only** on `reuse`: a `not_found` (including the
  normal logout-wins-the-race outcome at the recheck) never triggers revocation or
  a reuse log.
- Revocation is **exactly-once per spent token**: only the request that atomically
  consumes the spent token row applies the bump and emits the containment log, even
  under concurrent replays of the same token.
- Repeated replays of a stolen spent token cannot be used to harass the legitimate
  user (the DoS vector from the issue is bounded by design), and the bound is
  **per-compromise**, not merely per-token: acting on reuse also removes the user's
  other outstanding refresh-token rows, so a bulk leak of N spent rows cannot yield
  N separate forced logouts.
- The refresh path's 401 responses are **unified** (single status + body for reuse,
  not-found/expired, and stale-version rejections), *establishing* the anti-oracle
  property the policy depends on — in particular, a second replay of a consumed
  token must not be distinguishable from the first (which would confirm to the
  attacker that revocation fired).
- `markTokenRotated`'s result is either acted upon or provably irrelevant under the
  chosen concurrency option (see the sub-decision in Solution Approaches), with the
  reasoning recorded as a code comment. The two `false` cases are no longer
  conflated silently.
- Tests pin the new behavior, including the concurrency interleavings, against a
  real database.

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
      user's outstanding tokens, plus removal of the user's refresh-token rows) —
      verified by an end-to-end test against pglite.
- [ ] Revocation is exactly-once: two concurrent replays of the same spent token
      produce exactly one version bump and one reuse log — verified by a
      concurrent-replay test.
- [ ] A later replay of the *same* spent token does **not** re-trigger revocation
      (bounded-DoS property), and its response is indistinguishable from the first
      replay's — verified by test.
- [ ] At the in-transaction recheck, `reuse` applies the same policy and logging as
      the pre-validation site, while `not_found` (logout/reset won the race) aborts
      issuance with the generic 401 and **no** revocation or reuse log — both
      verified by test.
- [ ] A refresh that was authorized before a reuse-triggered bump cannot mint a
      token pair that survives the bump: the presented token's embedded
      `session_version` is re-verified against the user row inside the serialized
      rotation transaction — verified by an ordering test.
- [ ] The rotation step no longer silently ignores an unanticipated
      `markTokenRotated` outcome, per the ratified concurrency option (fail fast on
      a vanished row, or eliminate the vanished-row case via locking); the benign
      already-rotated-in-grace case still proceeds (issue #34).
- [ ] The refresh path returns a single unified 401 status + body for reuse,
      unknown/expired, and stale-version rejections (anti-oracle established).
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
  rows. Consuming a row on detected reuse is consistent with this rationale —
  retention exists precisely to enable first-reuse detection, which has then served
  its purpose for that token.
- Auth error responses must be uniform/generic. The refresh path does not fully
  satisfy this today (three distinct 401 bodies); unifying them is **in scope** as a
  prerequisite of the reuse policy.
- No user content in logs or Sentry; user UUIDs are acceptable internal identifiers.
- Fail fast, no silent fallbacks (project development principle #1).
- The full test suite must run without external services (pglite in-process DB).

### Business Constraints
- Follow-up scope from PR #15's review: intentionally small; no expansion into
  adjacent auth work (e.g. logout coverage, safeErrorMeta extension are separate
  issues). The 401-body unification above is the one deliberate addition, because
  the policy's anti-oracle requirement is unmeetable without it.
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
- Ignores RFC 9700 §4.14.2 guidance for the exact scenario it targets: when reuse is
  detected, the attacker may be the one holding the *newer* token (they refreshed
  first; the victim's replay is what trips detection). Log-only leaves the attacker's
  live session running.
- Turns every reuse log line into a manual incident (ops must investigate and revoke
  by hand) with no tooling to do so.
- The detection machinery (row retention past grace) exists purely to feed a log line.

**Estimated Complexity**: Low
**Risk Level**: Medium (accepts ongoing exposure the detection was built to catch)

### Approach 2: Unbounded account revocation (bump on every reuse)
**Description**: On every `reuse` classification, bump the user's `session_version`
(revoking all access + refresh tokens on all devices) and log.

**Pros**:
- Implements the BCP's revocation goal; attacker-held newer tokens die immediately,
  regardless of which party trips detection.
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

### Approach 3 (RECOMMENDED): Bounded account revocation — revoke once, consume the family
**Description**: On `reuse`, atomically and exactly-once: (a) bump `session_version`,
and (b) consume the replayed token row **and the user's other outstanding
refresh-token rows** via the existing deletion primitives (`deleteToken` /
`deleteUserTokens(userId, 'refresh')`), so no retained row for this account can
re-trigger revocation. Any further replay reads as `not_found` and is inert. The
"atomically and exactly-once" requirement means the bump and log are applied only by
the request whose consume of the spent row actually took effect — two concurrent
replays of the same token must yield one bump and one log, not two. Applied
identically at both detection sites, on `reuse` only.

Note on strength: this is deliberately **stronger** than RFC 9700 §4.14.2's minimum
(revoking the refresh-token lineage). `session_version` revokes *every* session and
access token for the account, because it is the project's single sanctioned
revocation primitive (arch-critical) and theft of one token gives no assurance about
which sessions are the attacker's.

**Pros**:
- Implements the BCP's security goal: on evidence of theft, no token from the
  compromised account — including a newer one the attacker may hold — survives.
- Caps the DoS vector by construction, **per compromise**: after one revocation, no
  retained row for the account remains to replay, so even a bulk leak of N spent
  rows yields one forced re-login, not N. The victim experiences at most one
  surprise re-login per compromise, which is arguably the correct UX for "your
  token was stolen."
- Consuming rows is consistent with the retention rationale — rows are retained *to
  detect first reuse*; once detected and acted on, retention has served its purpose
  for that account's outstanding tokens.
- Uses only existing primitives (`bumpSessionVersion`, `deleteToken`,
  `deleteUserTokens`) inside the established transactional pattern.

**Cons**:
- The false-positive scenario (client loses the rotation response, retries after >60s)
  now logs out all of the user's devices once. Judged acceptable: the window is
  narrow, the event is rare, recovery is a normal login, and the server provably
  cannot distinguish this from theft (RFC 9700's own argument).
- Later replay events are no longer log-distinguishable as "reuse" (the rows are
  gone); the first-reuse log line is the lasting record. Minor observability trade —
  and required anyway, since distinguishing them in the *response* would hand the
  attacker confirmation that revocation fired.

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

**Option B: Distinguish and fail fast.** Make the rotation step report *which* of
the two `false` cases occurred; proceed on already-rotated, abort issuance (generic
401) on row-vanished. Caveat identified in review: the in-transaction recheck runs
under READ COMMITTED without a row lock, so it cannot disambiguate by itself — a
concurrent delete can commit after the recheck's read. Distinguishing requires an
additional read after the failed update, making this less cheap than it first
appears.

**Option C (RECOMMENDED): Eliminate the race with a row lock.** Have the
in-transaction recheck take a row-level lock on the token row (`SELECT … FOR
UPDATE` semantics), serializing the rotation transaction against any concurrent
logout/reset delete. The vanished-row case then cannot occur *within* the
transaction: either the recheck sees the row (locked until commit — rotation
proceeds; a benign `false` from `markTokenRotated` can only mean
already-rotated-in-grace) or the delete won and the recheck reports
`not_found`/`reuse` and issuance never starts. This makes the discard of the
boolean **provably safe by construction**; a code comment records the argument, and
lock-ordering against the logout/reset transactions is a plan-phase concern.

## Open Questions

### Critical (Blocks Progress)
- [ ] None. The policy recommendation (Approach 3 + Option C) is this spec's
      proposal; ratification happens at the spec-approval gate.

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
- **Response Time**: No measurable regression on the refresh path — the reuse branch
  adds writes only on an already-failing (401) request; the happy path adds no
  queries beyond the (already-performed) recheck now taking a row lock.
- **Throughput**: Unchanged; no new hot-path work.
- **Resource Usage**: Strictly reduced token-row retention (consumed rows are
  removed earlier than natural expiry).
- **Availability**: No new external dependencies.

## Security Considerations
- **Threat model**: attacker exfiltrates a refresh token (device theft, log leak,
  network capture). If they refresh first, the victim's next refresh trips reuse; if
  the victim refreshed first, the attacker's replay trips it. In both cases the
  server cannot tell who is who — account-wide revocation (Approach 3) is the only
  response that contains the attacker in both orderings.
- **Anti-oracle**: the refresh path's 401s must be unified — one status + body for
  reuse, unknown/expired, and stale-version rejections — so neither a reuse
  classification nor a subsequent already-consumed replay is externally
  distinguishable. Scope: response **status and body semantics** only. A
  timing-side-channel guarantee is explicitly out of scope (the reuse branch
  performs extra writes; no practical timing-equality criterion or test exists at
  this layer), and is acceptable because timing tells the attacker nothing
  actionable that the unified response doesn't already deny.
- **Exactly-once revocation**: under concurrent replays of one spent token, the
  bump and containment log must be applied by exactly one request — the one whose
  atomic consume of the row succeeded.
- **DoS resistance**: bounded per-compromise — consume-on-reuse removes the
  replayed row and the account's other outstanding refresh rows, so no retained
  token remains to re-trigger revocation.
- **Stale-authorization gap**: a refresh authorized *before* a reuse-triggered bump
  must not issue a surviving pair *after* it. The presented token's embedded
  `session_version` must therefore be re-verified against the user row **inside**
  the serialized rotation transaction — the pre-transaction check alone leaves the
  authorized-before-bump / issuing-after-bump interleaving open (the in-transaction
  read would otherwise observe the *new* version and mint tokens that survive).
  With that in-transaction re-verification (plus the refresh-row deletion of
  Approach 3), no interleaving lets a minted pair outlive the bump; a dedicated
  ordering test pins this. No additional locking beyond Option C's row lock is
  required — the plan should not invent more.
- **Logging**: user UUID only; never raw or hashed token material, never user
  content. Unchanged from spec 4 discipline.

## Test Scenarios
### Functional Tests
1. **Happy path regression**: valid refresh still rotates and issues; concurrent
   refresh within grace still succeeds for both callers (issue #34).
2. **Reuse revokes account**: replay a token rotated past grace → unified 401 body;
   the user's previously-valid access and refresh tokens now fail validation; the
   user's other refresh rows are gone.
3. **Bounded DoS**: replay the same spent token again → unified 401, `not_found`
   classification, `session_version` unchanged from the first reuse; a fresh
   post-reuse login session is unaffected.
4. **Recheck-site `reuse`**: interleaving where reuse is first classified at the
   in-transaction recheck → policy applied (bump + consume + log), no pair issued.
5. **Recheck-site `not_found`** (logout/reset wins the race): issuance aborts with
   the unified 401, **no** bump, **no** reuse log — the normal-race outcome is not
   treated as an attack.
6. **Concurrent replays, exactly-once**: two simultaneous replays of the same spent
   token → exactly one version bump and one reuse log; both receive the unified 401.
7. **Stale-authorization ordering**: refresh authorized pre-bump, issuing post-bump
   → no surviving pair (in-transaction version re-verification rejects it).
8. **Rotation concurrency under Option C**: with the row lock, a benign
   already-rotated-in-grace `false` still proceeds; a logout-delete serialized
   before the recheck yields `not_found` and no issuance.
9. **False-positive path**: legitimate retry after >grace (lost response) → treated
   as reuse (documented, asserted) — account revoked once, password login recovers.

### Non-Functional Tests
1. **Anti-oracle**: response status + body are identical across reuse,
   unknown-token, expired, stale-version, and already-consumed-replay rejections on
   the refresh path.
2. **Log hygiene**: reuse log contains UUID only (no token material, no email).

## Dependencies
- **External Services**: None.
- **Internal Systems**: spec-4 auth machinery — `session_version` validation,
  `lookupRefreshToken` classification, transactional token lifecycle, grace window.
- **Libraries/Frameworks**: Existing stack only (Drizzle, pglite for tests — noting
  pglite's transaction/locking semantics must actually exercise the row-lock
  behavior; if it cannot, the plan must say how the Option C path is verified). No
  new dependencies.

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
| Legit user logged out by lost-response retry (false positive) | Low | Medium | Bounded to one event per compromise; grace window absorbs normal retries; normal login recovers; behavior asserted in tests so it's a documented decision, not an accident |
| Attacker loops revocation with spent token(s) (DoS) | — | High if unmitigated | Eliminated by design: replayed row and the account's other refresh rows consumed on first reuse; replay reads `not_found` |
| Double-bump under concurrent replays | Medium | Low | Exactly-once requirement: bump/log gated on winning the atomic consume; concurrent-replay test |
| Refresh authorized pre-bump issues a surviving pair | Low | High | In-transaction re-verification of the embedded session_version; dedicated ordering test |
| Reuse response becomes distinguishable (oracle) | Medium (exists today as 3 distinct bodies) | Medium | Unify refresh-path 401 bodies (in scope); equality test across all five rejection cases |
| Row-lock (Option C) introduces deadlock with logout/reset | Low | Medium | Lock-ordering analysis is a mandated plan-phase item; interleaving tests on pglite |
| Scope creep into adjacent auth follow-ups | Medium | Low | Constraints section pins scope to issue #16's two items + the 401-unification prerequisite |

## Expert Consultation
**Date**: 2026-08-02
**Models Consulted**: Gemini (APPROVE), Codex (REQUEST_CHANGES), Claude
(REQUEST_CHANGES) — 3-way porch consultation, iteration 1. Rebuttal:
`codev/projects/16-refresh-token-reuse-decide-rev/16-specify-iter1-rebuttals.md`.
**Sections Updated**:
- Problem Statement / References: RFC citation corrected to RFC 9700 §4.14.2 (issue
  cited draft numbering §4.13.2); session_version bump described as deliberately
  stronger than the RFC's lineage revocation (Codex).
- Current State: documented the three distinct 401 bodies (pre-existing oracle) and
  the READ COMMITTED / no-row-lock recheck semantics (Claude).
- Desired State / Constraints / Success Criteria: 401-body unification scoped IN as
  a prerequisite ("establishing", not "preserving", the anti-oracle property);
  exactly-once revocation; per-compromise DoS bound via
  `deleteUserTokens(userId,'refresh')` (Codex + Claude).
- Solution Approaches: `reuse`-only trigger made explicit (never `not_found`);
  consume mechanism named (`deleteToken`/`deleteUserTokens`); Option C
  (row lock, eliminates the vanished-row race) added and recommended over Option B,
  whose "cheap distinction" rationale was corrected (Claude).
- Security Considerations: anti-oracle scoped to status+body semantics with timing
  explicitly out of scope (Codex); stale-authorization gap (authorized-pre-bump /
  issuing-post-bump) closed via in-transaction session_version re-verification
  (Codex), stated as verify-and-test with no extra locking beyond Option C (Claude).
- Test Scenarios: recheck-site `reuse` and `not_found` split into separate scenarios
  with opposite expectations; concurrent-replay exactly-once and
  stale-authorization ordering tests added (Codex + Claude).

## Approval
- [ ] Technical Lead Review
- [ ] Product Owner Review
- [ ] Stakeholder Sign-off
- [x] Expert AI Consultation Complete

## Notes
- The builder branch predated PR #15's merge; `origin/develop` was merged in
  (commit 5ab8a9d) before drafting so this spec describes the actual integrated
  code, not the pre-spec-4 state.
- Recommendation summary for the gate: **Approach 3** (exactly-once account
  revocation via `session_version` bump; consume the replayed row and the account's
  other refresh rows so replays are inert) plus **Option C** for `markTokenRotated`
  (row lock in the recheck eliminates the vanished-row race; discard becomes
  provably safe and is documented). Approach 1 (log-only) is the fallback if the
  architect judges any forced-logout risk unacceptable; it should then be recorded
  as an explicit accepted-risk decision in code comments and lessons-learned.
- **Ratification sequencing**: before the Plan phase starts, this spec will be
  edited to state the ratified choice as *the* decision (collapsing the
  conditional phrasing), so the plan and implementation have a single target.
