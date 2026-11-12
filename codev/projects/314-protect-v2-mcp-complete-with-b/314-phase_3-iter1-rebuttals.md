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
