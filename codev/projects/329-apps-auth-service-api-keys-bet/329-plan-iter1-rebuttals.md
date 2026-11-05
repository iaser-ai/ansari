# Plan 329, iteration 1: rebuttal

Reviews: codex REQUEST_CHANGES; gemini COMMENT (skipped, `agy` not installed).

1. Provisional limits: resolved by the owner after the review started. Traffic is low, one instance, no numbers; size by judgement. The plan now carries initial values (the decision), alerts at one third of the caps, wide bounds and an `update-limits` path (commit cd1ebb1). The spec's decision 3 is updated to match.
2. CORS via OPTIONS fall-through: accepted. The router terminates every request to its path; non-POST methods, OPTIONS included, get 404 with no CORS headers and never call `next()`. Tests added.
3. JSON parser errors: accepted. A route-local error handler maps parse, size and content-type errors to the exact 400 body. Tests added.
4. Eligibility binds the BSUID: accepted. `issueWhatsappToken` takes the BSUID and requires the sole account row's `account_id` to equal it under the lock. A re-pointed-row case is added to the matrix.
5. Sentry flush in scripts: accepted. Initialise, await `flush` before exit, report a failed flush.
6. Missing tests: accepted. Expired ban (phases 5 and 6), delegation inputs over HTTP, rate-limit key contents (no BSUID or phone), and unchanged row counts after every key refusal.

Repository-moved warning: the HEAD change was my own commit (cd1ebb1, owner decision 3), made while the review ran.
