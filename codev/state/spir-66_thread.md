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
- plan-approval APPROVED 2026-09-23 by the human (typed in this builder's terminal).

## Implement — Phase 1 (2026-09-23)
- New `lib/facilitator/citable-documents.ts` collector (filters on `citations.enabled === true`, fails closed;
  JSON-tuple dedupe key; projects to the `document` ContentBlock; `undefined` when empty). `DocumentContentBlock`
  type exported from `db/schema/messages.ts`.
- `agent.ts`: one collector per request, fed right after `processToolCall` for every executed dispatch; both `done`
  yields spread `documents` in only when non-empty. `error` yields, the tool_result frame, the Gemini functionResponse,
  and tool_calls records are unchanged, and the existing facilitator-*.test.ts suites pass with no edits.
- Tests: 9 unit tests + 13 facilitator tests. Negative-tested twice: dropping the `add` call fails 7 tests, and
  dropping the enabled filter fails 8. Both pass again once restored.
- Full suite 785 passed / 3 skipped; typecheck clean; lint 0 errors (7 warnings were already there, none in touched files).

## Implement — Phase 2 (2026-09-23)
- Merged origin/develop first (no new migrations landed; next.js bump + legacy/ relocation). `drizzle-kit generate`
  named the file `0008_*` (it numbers by journal idx, and 0005 is missing on disk) — renamed to `0009_documents.sql`
  (journal tag fixed), per the spec-73 lesson. SQL is exactly `ALTER TABLE "messages" ADD COLUMN "documents" jsonb;`;
  the 0007→0008 snapshot diff is that one column. NOT applied anywhere.
- `messages.documents` jsonb nullable + `documentsOrNull` in the schema module; `MessageRow` omits it, so
  `messageReadColumns` (replay/GET/share read path) is unchanged. Both chat routes' `done` createMessage now write
  `documents: documentsOrNull(event.documents)`; nothing else in the routes changed.
- pglite DDL: 9 real `CREATE TABLE messages` sites updated (model-provenance only mentions it in a comment).
  No vi.mock factory mocks `@/db/schema*`; routes call no new `@/lib/db/threads` export.
- Tests: documents-persistence (5, pglite) + documents-routes (16, both routes via describe.each).
  Negative tests: dropping `documents:` from the web route fails 3; from the chat route fails 3; adding `documents`
  to messageReadColumns fails the projection test. All restored green.
- Full suite 807 passed / 3 skipped; typecheck clean; lint 0 errors (same 7 old warnings).
- Phase 2 consult: codex APPROVE, claude APPROVE, gemini skipped (agy CLI missing). Applied claude nits: dropped unused
  `shares` DDL in documents-persistence; wire-identity test strips each route's own heartbeat sentinel.
  Heads-up for the next migration: the next `drizzle-kit generate` will emit `0009_*` again (journal idx 9) —
  rename it to `0010_*`.

## Phase 3 — thread GET + share return documents (2026-09-23)
- `getThreadWithMessages` now uses a separate `threadViewColumns` (= messageReadColumns + documents);
  `findMessagesByThread` (replay, naming) unchanged. Thread GET + share GET spread `documents` only when
  non-empty; `createThreadSnapshot` snapshots it under the same rule.
- Byte-identity proof: deterministic SQL seed (user, no-tool, legacy NULL, hand-inserted `[]`) → fixture
  captured by running the seed through the UNMODIFIED HEAD route (swapped in temporarily), pasted as a literal.
- Existing exact-key asserts in thread-get-contract untouched; new pinned lists for doc-bearing cases.
- Negative tests: drop thread-GET spread → 2 fail; drop snapshot projection `documents` → 1 fail; drop
  share-GET spread → 1 fail; make key unconditional → 4 fail (incl. original bare-string test + fixture). All restored green.
- Client check: prototypes/ansari-expo wire-schemas non-strict by design; legacy/frontend-{web,app}
  ChatService.getThread/getSharedThread pass `data.messages` through unvalidated, addMessage sends only
  the new message; apps/frontend has 0 hits. No strict parser.
- Docs: arch.md new "Citable documents" paragraph + fixed stale snapshot-projection/migration-number
  claims in the spec-73 paragraph; arch-critical frozen-contract fact extended in place.
- Suite 813 passed / 3 skipped; typecheck clean; lint 0 errors.
