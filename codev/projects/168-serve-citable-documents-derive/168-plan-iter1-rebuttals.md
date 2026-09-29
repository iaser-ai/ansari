# Plan 168 — iteration 1 rebuttals

Gemini: APPROVE, with no issues raised.

## Codex (REQUEST_CHANGES), all accepted

1. **No single citability computation point for #109.** Added `citabilityOf(result)`, exported from `lib/tools/types.ts`. It is the only place the write-side `enabled === true` rule is written. The facilitator's record builder calls it, and #109's SSE frame can reuse it later. The SSE frame itself is still out of scope.
2. **Latency method underspecified.** Added a committed benchmark script, `apps/api/scripts/bench-thread-get.ts`. It uses a 50-message pglite fixture with realistic `tool_calls` sized to a median of about 7 KB, which the script asserts before timing. The baseline is the pre-change GET mapping frozen in the script and run in the same process. It runs 20 warm-up requests, then 200 measured requests alternated between the two versions, and reports median, p95 and the ratio. It also asserts that `documents` were actually returned, so it cannot time a trivial path.
3. **How malformed-data reasons reach the logger.** The pure function now returns `{ documents, rejected: RejectReason[] }`. `RejectReason` is a closed set of literal values that carries no record data. The DB wrapper logs `{ messageId, reasons }` and returns only the documents map, so `rejected` never leaves the module. Legacy rows (`no_citations`) are counted but not logged. A test uses a sentinel string to prove no record text reaches the log.
