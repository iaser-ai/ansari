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
