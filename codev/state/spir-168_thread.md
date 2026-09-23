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
