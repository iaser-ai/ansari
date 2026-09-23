# spir-66 thread — persist & return retrieved documents (issue #66)

## 2026-09-23 — specify
- Finding: putting `document` blocks in `messages.content` (the issue's literal suggestion) turns
  every retrieval answer's bare-string `content` into an array on thread GET / share GET —
  breaks the frozen contract unless every content reader filters. Spec 73's lesson is
  "invisibility structural, not a filter".
- Spec recommends Approach 2: new nullable `documents` jsonb column (element type = existing
  `document` ContentBlock), returned as sibling `documents` key, omitted when empty. Needs a
  small additive migration — departs from the issue's "no migration" expectation; flagged to
  architect for spec-approval.
- Citable = `citations.enabled === true` (excludes no-results/unavailable/limit/unknown notices).
- Note: doc text is already in `tool_calls` (spec 73) but that column must never be served.
- 2026-09-22 architect decisions: (1) separate `documents` column confirmed, (2) share GET includes
  documents, (3) mcp-complete / v1 completions out of scope. Migration write-up added to spec
  (generate → review SQL → human applies; never db:push; migration before deploy).
- 2026-09-23 3-way spec review: gemini lane skipped (agy CLI not installed); codex REQUEST_CHANGES
  addressed in 7ed5124 (dedupe rule = title+context+source.data, first wins; tool_calls wording;
  plain-text/untrusted + no new size cap). Claude lane was still running when spec-approval was
  granted by the human; its output (if any) lands in codev/projects/66-*/66-specify-iter1-claude.txt.
- spec-approval APPROVED; porch in plan phase.

## Plan phase (2026-09-23)
- Plan written (3 phases: facilitator collects citable docs on `done` → `documents` column + migration + persistence at both chat routes → thread GET + share return documents additively).
- 3-way review: gemini skipped (agy missing); codex REQUEST_CHANGES, claude COMMENT. All points accepted (commit 2444136):
  conditional spread so `documents` key is truly absent; package filter is `ansari-api` (not `api` — would false-green);
  existing exact-key contract assertions must stay unmodified; client-parser check targets `legacy/frontend-{web,app}` + prototype, not apps/frontend;
  collision-safe dedupe key `JSON.stringify([title, context ?? null, data])`.
- Now at plan-approval gate, waiting for human approval.
