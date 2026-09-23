# spir-168 thread — serve citable documents derived from tool_calls

## 2026-09-24 — specify
- Owner ruling on #168 (Option C) read: read path may load tool_calls ONLY inside a dedicated derivation helper returning derived blocks; API contract paramount; arch-critical amended in the PR.
- Spec drafted. Key recommendations (flagged for confirmation at spec-approval):
  - Persist per-entry `result_meta: [{citable, source_type, media_type}]` as a sibling on the tool_result record, aligned with content.results. Gemini payload / record `content` untouched. No migration (inside existing jsonb).
  - Historical rows (no result_meta) fail closed.
  - Share snapshots: derive at creation and copy (C1) so the public share GET never loads tool_calls.
- Consult iter1: Gemini APPROVE; Codex REQUEST_CHANGES (raw_payload wording contradiction, v1/chat/completions doesn't persist tool_calls, decisions left "to confirm", malformed jsonb must not 500). All four addressed. Claude consult hung/down — user directed proceeding with Codex + Gemini only.
- Claude consult arrived late (REQUEST_CHANGES): contract key order, vacuous scan, in-code comments, numeric cost bound (14 KB/row median or 2x thread-GET latency), budget-skip site, helper auth scoping — all folded in. Rebuttal written.
