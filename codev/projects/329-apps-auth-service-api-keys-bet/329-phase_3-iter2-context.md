### Iteration 1 Reviews
- codex: REQUEST_CHANGES — Reserved-domain coverage is solid, but padded noreply sign-ups violate the explicit 409 contract.
- gemini: COMMENT — Gemini lane skipped — agy exited with code 3

### Builder Response to Iteration 1
# Phase 3, iteration 1: rebuttal

Reviews: codex REQUEST_CHANGES (one issue); gemini COMMENT (skipped, `agy` not installed).

**Padded noreply sign-up returns 400, not 409: disagree with changing the code; the spec text is corrected instead.**

- `signUpGuard` validates the email before the reserved/taken check. That is the legacy register order (validation → reserved or taken → strength), pinned by spec 300 and by apps/api's frozen `/v2/users` contract suite. Trimming before validation would change sign-up for every address, which is outside this spec and touches a frozen contract.
- The property the criterion protects is "no oracle". It holds: a padded noreply address, a padded taken address and a padded fresh address all get the identical 400 `INVALID_EMAIL`, and unpadded noreply and taken addresses get the identical 409. The test asserts both.
- The spec's "(any case, surrounding spaces) → 409" was my drafting error: the existing guard never gave 409 for a padded address, the system domain included. The spec criterion is amended to state the real behaviour (same commit), and the security architect is told.


### IMPORTANT: Stateful Review Context
This is NOT the first review iteration. Previous reviewers raised concerns and the builder has responded.
Before re-raising a previous concern:
1. Check if the builder has already addressed it in code
2. If the builder disputes a concern with evidence, verify the claim against actual project files before insisting
3. Do not re-raise concerns that have been explained as false positives with valid justification
4. Check package.json and config files for version numbers before flagging missing configuration
