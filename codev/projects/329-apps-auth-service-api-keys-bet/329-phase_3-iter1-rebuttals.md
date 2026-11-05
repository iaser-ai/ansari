# Phase 3, iteration 1: rebuttal

Reviews: codex REQUEST_CHANGES (one issue); gemini COMMENT (skipped, `agy` not installed).

**Padded noreply sign-up returns 400, not 409: disagree with changing the code; the spec text is corrected instead.**

- `signUpGuard` validates the email before the reserved/taken check. That is the legacy register order (validation → reserved or taken → strength), pinned by spec 300 and by apps/api's frozen `/v2/users` contract suite. Trimming before validation would change sign-up for every address, which is outside this spec and touches a frozen contract.
- The property the criterion protects is "no oracle". It holds: a padded noreply address, a padded taken address and a padded fresh address all get the identical 400 `INVALID_EMAIL`, and unpadded noreply and taken addresses get the identical 409. The test asserts both.
- The spec's "(any case, surrounding spaces) → 409" was my drafting error: the existing guard never gave 409 for a padded address, the system domain included. The spec criterion is amended to state the real behaviour (same commit), and the security architect is told.
