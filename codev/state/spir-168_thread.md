# spir-168 thread — serve citable documents derived from tool_calls

## 2026-09-24 — specify
- Owner ruling on #168 (Option C) read: read path may load tool_calls ONLY inside a dedicated derivation helper returning derived blocks; API contract paramount; arch-critical amended in the PR.
- Spec drafted. Key recommendations (flagged for confirmation at spec-approval):
  - Persist per-entry `result_meta: [{citable, source_type, media_type}]` as a sibling on the tool_result record, aligned with content.results. Gemini payload / record `content` untouched. No migration (inside existing jsonb).
  - Historical rows (no result_meta) fail closed.
  - Share snapshots: derive at creation and copy (C1) so the public share GET never loads tool_calls.
- Consult iter1: Gemini APPROVE; Codex REQUEST_CHANGES (raw_payload wording contradiction, v1/chat/completions doesn't persist tool_calls, decisions left "to confirm", malformed jsonb must not 500). All four addressed. Claude consult hung/down — user directed proceeding with Codex + Gemini only.
- Claude consult arrived late (REQUEST_CHANGES): contract key order, vacuous scan, in-code comments, numeric cost bound (14 KB/row median or 2x thread-GET latency), budget-skip site, helper auth scoping — all folded in. Rebuttal written.
- Owner review at spec gate: simplified to persist ONLY the tool's own `citations.enabled`, as `citations: [{enabled}]` beside `content` on each tool_result record (no source_type/media_type; those are filled from DocumentBlock literal types with a compile-time guard). Owner confirmed this is not a DB change (existing jsonb key, no column/migration). Read-time inference from tool identity/wording considered and rejected (zero-result 'ok' notices are structurally identical to hits).

## plan
- Spec approved by owner (porch gate recorded). Owner also asked for, and got, a thread/share documents parity criterion (fd20f5d).
- Plan: 4 phases. (1) persist citations[] on tool_result records and capture byte-identity fixtures pre-change. (2) derivation module lib/db/citable-documents.ts, pure + DB helper. (3) serve on thread GET + C1 snapshots + share GET. (4) arch-critical/arch.md/in-code comments + read-cost report.
- Plan consult iter1: Gemini APPROVE; Codex REQUEST_CHANGES (single citability point for #109 -> citabilityOf in lib/tools/types.ts; benchmark method; malformed-reason plumbing) — all accepted.
- 2026-09-24: staging read-only measurement (owner pointed to the backend DATABASE_URL, Railway proxy host; session forced default_transaction_read_only=on). 103 assistant rows, 80 with tool_calls (2026-08-27..2026-09-23). pg_column_size(tool_calls): median 5,588 B, p95 14,110 B, max 14,564 B, so within the 14 KB median bound. Uncompressed JSON text (what Node parses): median 12.7 KB, p95 32.9 KB. Threads are short: median 1, p95 2, max 3 assistant messages. The sample is small, so Phase 4 re-runs this.
- 2026-09-24, owner direction at the plan gate: serve documents through dedicated endpoints, GET /api/v2/threads/{id}/documents (derives live, owner-scoped) and GET /api/v2/share/{id}/documents (public, reads the snapshot). Thread GET and share GET are NOT modified. Share snapshots keep documents built in (C1). Join key: message_index (share GET has no ids); the thread entries also carry message_id. Spec and plan revised. #161 must adapt, so the prototypes architect needs to agree.

## implement: phase_1 (persist per-result citability)
- Fixtures for thread GET and share GET were captured from UNMODIFIED handlers and committed on their own (73ccb81) before any code change. The thread includes an answer whose records WILL derive documents.
- citabilityOf() added to lib/tools/types.ts. It is the single write-side rule, used by both record sites (buildToolResultRecord, and the budget-skip record, where it yields []). formatToolResultForGemini is untouched (diff shows only the import plus two record fields).
- Surprise: no existing test needed updating. The facilitator tests assert on content/status, not whole-record equality, so the plan's expected "update exact-record expectations" did not happen.
- Negative tests: N1 citabilityOf hard-coded true → 16 failed. N2 citations leaked into the Gemini payload → 1 failed (payload freeze). N3 record builder drops citations → 7 failed. All 53 passed again after restore.
- Suite 796 passed / 3 skipped (baseline 768/3); typecheck clean; lint 0 errors (7 pre-existing warnings); build OK.

## implement: phase_2 (derivation helper)
- lib/db/citable-documents.ts. deriveCitableDocuments(unknown) is pure and returns {documents, rejected: RejectReason[]}. It validates each record and fails closed per record (any bad entry drops the whole record). It dedups on JSON [title, context ?? null, text] and keeps the first occurrence. findCitableDocumentsByThread selects only id + tool_calls for assistant rows, and warns {messageId, reasons} with legacy 'no_citations' excluded. Only the map leaves the module.
- Fidelity guard: TEXT_SOURCE is typed through an ExactLiteral over DocumentBlock['source'] literals. Widening 'text' to 'text' | 'pdf' fails tsc at citable-documents.ts:43 (verified).
- Caught a vacuous check: tsconfig excludes tests/**, so expectTypeOf in tests is never type-checked. I removed the type-level test rather than keep a check that could not fail. The declared return type (checked in lib/) plus a runtime key test cover it. Worth a lessons entry.
- Negative tests: N1 citability check removed → 7 failed; N2 length check removed → 1 failed; N3 source type widened → tsc error. All 36 passed after restore.
- Suite 832 passed / 3 skipped; build OK; lint 0 errors (7 pre-existing warnings).

## implement: phase_3 (documents endpoints + snapshot documents)
- Helper reworked: findCitableDocumentsByThread now returns MessageDocuments[] {messageId, messageIndex, documents}. It uses ONE query over the thread (id, role, tool_calls ordered by created_at, the same order findMessagesByThread uses), so the index is taken from the same result set as the ordering it describes. Phase 2's DB tests were updated to match.
- New routes: GET /api/v2/threads/[id]/documents (auth + owner-scoped findThreadById, 404 identical to thread GET) and GET /api/v2/share/[id]/documents (public, snapshot-only). Their catch blocks log {name, code} only. Thread GET and share GET files are UNTOUCHED, and the Phase 1 byte fixtures still pass.
- createThreadSnapshot selects message id (lookup only) and stores documents on snapshot messages when non-empty. ThreadSnapshot type gains optional documents.
- A source scan on the public share route (no citable-documents or threads import, no tool_calls mention) caught my own comment that named tool_calls. Reworded.
- Negative tests: N1 derivation off → 11 failed; N2 off-by-one index → 7; N3 share GET spreads snapshot documents → 2 (incl. byte fixture); N4 no owner scope → 1. All 33 passed after restore.
- Suite 853 passed / 3 skipped; tsc clean; lint 0 errors (7 pre-existing warnings); next build lists both routes.

## implement: phase_4 (docs + read-cost report)
- Docs: arch-critical fact rewritten (still 10 facts / 4 map / 25 lines), arch.md tool-call paragraph + new "Citable documents (spec 168)" paragraph, in-code comments in messages.ts / threads.ts / shares.ts. Stale-wording audit: the pattern hits 5 passages in HEAD and 0 in the working tree (and 0 repo-wide).
- Read cost, STORAGE (staging-measured 2026-09-24, owner-authorised read-only session, aggregates only): pg_column_size(tool_calls) median 5.6 KB, p95 14.1 KB, n=80, well inside the 14 KB median bound.
- Read cost, LATENCY (synthetic pglite fixture: 50 messages, 25 assistant; stored median 4.7 KB, JSON-text median 16.7 KB; 389 documents): thread GET median 0.93-1.04 ms (p95 1.4-1.6); /documents median 4.86-5.03 ms (p95 5.5-5.8). Ratio 4.9-5.3x at the median, 3.6-3.9x at p95, over 3 runs. That TRIPS the spec's 2x latency bound, so the architect was flagged before the PR. Cause: the endpoint parses all tool_calls and serialises every document's text (394 KB response vs 53 KB for thread GET). Absolute cost is ~5 ms for a 25-answer thread, and staging threads have 1-3 answers.
- Benchmark lives at apps/api/scripts/bench-documents.bench.ts with its own config (scripts/vitest.bench.config.ts, include REPLACED not merged; mergeConfig concatenates arrays, which I caught). Run: pnpm vitest run --config scripts/vitest.bench.config.ts --silent=false --reporter=verbose. Console output only shows with those flags.
- Flaky PRE-EXISTING tests (not 168): migration-schema-parity ("deployed on staging/production") and eslint-env-guard ("flags process.env.JWT_SECRET") hit the 5 s default vitest timeout under CPU load (2 of 4 root runs with a concurrent build, plus 1 plain run right after a build). Parity test is 0.5-0.7 s normally, identical on base c1c198d, so not a regression. I did NOT skip them, because parity is the #165 outage guard. I proposed per-test timeouts to the architect and am awaiting a decision.
