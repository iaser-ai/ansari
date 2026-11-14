### Iteration 1 Reviews
- codex: REQUEST_CHANGES — Phase 3 implementation is sound, but its rollout-mode documentation contradicts the specification.
- gemini: APPROVE — Phase 3 implementation and tests are complete, fail-closed, and aligned with the spec and plan; one minor doc wording fix noted for `docs/self-hosting.md`.

### Builder Response to Iteration 1
# Phase 3, iteration 1: rebuttal

## Codex (REQUEST_CHANGES)

**`docs/self-hosting.md:113` says an unreachable apps/auth is 503 in both modes.** Accepted, fixed in 89f14233.
Spec §3 says log-only "always serves, including when apps/auth is unreachable". Acceptance also requires
log-only to record `unverified` and raise a Sentry warning. The row now reads: `enforce` refuses a missing
or invalid key with 401 and answers 503 when apps/auth is unreachable; `log-only` verifies, records the
verdict (`unverified` when apps/auth is unreachable, with a Sentry warning) and always serves. The wrong
sentence appeared nowhere else (grepped apps/, docs/, the thread).

## Gemini (APPROVE)

Raised the same docs sentence as a note. Fixed by the same commit.

## Changes since iteration 1 also made at the security architect's request (8a2a4da3)

- The turbo.json and config.ts removal follow-up now says "one week after enforcement; the issue is
  opened at enforce (rollout step 6)", not a calendar date. Enforcement waits on the apps/auth cutover,
  which has no fixed date.
- client.ts contract comment: the `{ valid: false }` refusal is pinned on both sides. apps/auth tests
  assert the byte-identical body. apps/api accepts only that shape, so adding a field on apps/auth
  turns every bad key into a 503 and both sides must change together.


### IMPORTANT: Stateful Review Context
This is NOT the first review iteration. Previous reviewers raised concerns and the builder has responded.
Before re-raising a previous concern:
1. Check if the builder has already addressed it in code
2. If the builder disputes a concern with evidence, verify the claim against actual project files before insisting
3. Do not re-raise concerns that have been explained as false positives with valid justification
4. Check package.json and config files for version numbers before flagging missing configuration
