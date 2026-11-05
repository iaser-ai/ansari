### Iteration 1 Reviews
- codex: REQUEST_CHANGES — Strong structure and coverage, but several security-critical implementation details remain unresolved.
- gemini: COMMENT — Gemini lane skipped — agy exited with code 3

### Builder Response to Iteration 1
# Plan 329, iteration 1: rebuttal

Reviews: codex REQUEST_CHANGES; gemini COMMENT (skipped, `agy` not installed).

1. Provisional limits: resolved by the owner after the review started. Traffic is low, one instance, no numbers; size by judgement. The plan now carries initial values (the decision), alerts at one third of the caps, wide bounds and an `update-limits` path (commit cd1ebb1). The spec's decision 3 is updated to match.
2. CORS via OPTIONS fall-through: accepted. The router terminates every request to its path; non-POST methods, OPTIONS included, get 404 with no CORS headers and never call `next()`. Tests added.
3. JSON parser errors: accepted. A route-local error handler maps parse, size and content-type errors to the exact 400 body. Tests added.
4. Eligibility binds the BSUID: accepted. `issueWhatsappToken` takes the BSUID and requires the sole account row's `account_id` to equal it under the lock. A re-pointed-row case is added to the matrix.
5. Sentry flush in scripts: accepted. Initialise, await `flush` before exit, report a failed flush.
6. Missing tests: accepted. Expired ban (phases 5 and 6), delegation inputs over HTTP, rate-limit key contents (no BSUID or phone), and unchanged row counts after every key refusal.

Repository-moved warning: the HEAD change was my own commit (cd1ebb1, owner decision 3), made while the review ran.


### IMPORTANT: Stateful Review Context
This is NOT the first review iteration. Previous reviewers raised concerns and the builder has responded.
Before re-raising a previous concern:
1. Check if the builder has already addressed it in code
2. If the builder disputes a concern with evidence, verify the claim against actual project files before insisting
3. Do not re-raise concerns that have been explained as false positives with valid justification
4. Check package.json and config files for version numbers before flagging missing configuration

### Builder note for this round (2026-10-30): what is new
Phases 1-7 were implemented and approved, and the PR (#331) reached its gate. The owner then reopened the project (porch rolled back review -> plan). The new material to review:
- spec §5, "Owner amendment (2026-10-30)": better-auth's phone-number plugin columns in migration 0001 (in place; not applied anywhere); the plugin enabled and unblocked, with a stub OTP sender, one 4xx body and per-number budgets; verified-by-construction numbers; in the exchange, claim / supersede / refuse when a number is already held; widened eligibility; link notice; unlink; the residual. Commits 1d84f91d and ca1452db.
- plan "Phase 8" (commit d3b92b00), which implements §5.
Please review phase 8 against spec §5. Phases 1-7 are the record of shipped work.
