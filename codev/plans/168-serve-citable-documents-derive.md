# Plan: Serve citable documents derived from `tool_calls`

**Specification**: [codev/specs/168-serve-citable-documents-derive.md](../specs/168-serve-citable-documents-derive.md)

## Executive Summary

This plan implements the spec's ratified design: **A1 + B1 + C1, historical rows fail closed**.
The plan does not re-decide any of it.

- **A1: persist citability.** Every persisted `tool_result` record gains a sibling
  `citations: Array<{ enabled: boolean }>`. The array aligns index-for-index with
  `content.results` and holds the tool's own `citations.enabled`, with a missing flag saved as
  `false`. `content` stays byte-identical to the Gemini `functionResponse`. There is no new
  column and no migration.
- **B1: derive in a dedicated helper.** A pure function turns records into document blocks.
  Beside it, a DB helper selects `id, tool_calls` for a thread's assistant messages, runs the
  pure function inside its own scope, and returns only `Map<messageId, DocumentContentBlock[]>`.
  Raw records never leave that module.
- **C1: share snapshots copy at creation.** `createThreadSnapshot` calls the same DB helper and
  stores each message's non-empty `documents` in the snapshot. Share GET emits the key from the
  snapshot and never touches `tool_calls`.
- **Serving.** Thread GET and share GET append `documents` as the **last** message key, only when
  it is non-empty. `content` and every other key are untouched.

The phases are ordered so that each is independently testable and none changes a response
before the serving phase. Phase 1 (persist the flag) goes first and also pins today's
serialized responses as fixtures before anything that could move them lands.

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "Persist per-result citability on tool_result records"},
    {"id": "phase_2", "title": "Citable-document derivation helper"},
    {"id": "phase_3", "title": "Serve documents on thread GET and share snapshots"},
    {"id": "phase_4", "title": "Invariant documentation and read-cost report"}
  ]
}
```

## Phase Breakdown

### Phase 1: Persist per-result citability on tool_result records

**Dependencies**: None

#### Objective

Stop losing `citations.enabled`. From this phase on, every new `tool_result` record carries the
tool's own per-result citability, so the rows written after deploy are derivable. No response
changes.

#### Files to Create / Modify

- `apps/api/db/schema/messages.ts`: add optional `citations?: Array<{ enabled: boolean }>` to the
  `tool_result` variant of `ToolCallRecord`, with a doc comment covering alignment with
  `content.results`, why it is beside `content` and not inside it, and absent meaning a legacy
  row. Add an exported `DocumentContentBlock` type
  (`Extract<ContentBlock, { type: 'document' }>`) for later phases.
- `apps/api/lib/facilitator/agent.ts`:
  - `buildToolResultRecord` sets `citations` by calling `citabilityOf(result)`. It covers
    executed, degraded, backstop, limit-refused and unknown-tool calls.
  - The inline budget-skip record sets `citations: []`, because its `results` is `[]`.
  - `formatToolResultForGemini` is **not** touched.
- `apps/api/lib/tools/types.ts`: add and export `citabilityOf(result: ToolResult): Array<{
  enabled: boolean }>`, which returns `result.documents.map(d => ({ enabled: d.citations?.enabled
  === true }))`. This is the **single computation point** for per-result citability, as the spec
  requires for #109. The facilitator's record builder calls it now, and the SSE `tool_result`
  frame can call it later without redefining the rule. This spec does not change the SSE frame.
- `apps/api/tests/facilitator-toolcalls.test.ts`: update the existing exact-record expectations
  to include `citations`, as a deliberate change the commit message records. Add new cases.
- `apps/api/tests/facilitator-citability.test.ts` (new): notice-kind and payload-freeze
  coverage.
- `apps/api/tests/toolcalls-persistence.test.ts` or `toolcalls-routes.test.ts`: assert that the
  flag survives the real persist path into pglite jsonb.
- `apps/api/tests/documents-contract-fixture.test.ts` (new): the byte-identity fixtures, captured
  now from the unmodified GET handlers.

#### Deliverables

- [ ] `ToolCallRecord` `tool_result` type carries optional `citations`.
- [ ] `citabilityOf` is exported from `lib/tools/types.ts` and is the only place the
      `enabled === true` rule is written on the write side.
- [ ] Both record-building sites populate it. Alignment holds by construction: both arrays are
      mapped from the same `result.documents`.
- [ ] Tests (below).
- [ ] Captured pre-change fixtures for thread GET and share GET on a thread with no citable
      retrieval: user message, no-tool answer, and a legacy `tool_calls` answer.

#### Acceptance Criteria

- [ ] A real hit records `{ enabled: true }`. Each notice kind records `{ enabled: false }`: "No
      Results" from each of the four tools under `status: 'ok'`, degraded, backstop, tool limit
      and unknown tool. Budget skip records `citations: []`.
- [ ] `citations.length === content.results.length` on every record in every facilitator test
      path.
- [ ] The Gemini `functionResponse` parts are **deep-equal and byte-identical**
      (`JSON.stringify`) to a snapshot of today's output for a representative multi-document
      result and for a notice. The persisted `content` equals the payload sent. No `citations`
      key appears anywhere in the functionResponse.
- [ ] The fixtures are committed and green against the unchanged routes.
- [ ] `pnpm --filter ansari-api test`, `typecheck` and `lint` pass.

#### Test Plan

- **Unit (facilitator, mocked Gemini and tools):** one case per notice kind, one per real hit,
  and a mixed round (one hit tool plus one zero-result tool). Assert per-entry flags, lengths and
  the frozen payload.
- **Integration (pglite):** persist a turn's records through the real route helper, read the raw
  `tool_calls` back with SQL, and assert `citations` round-trips.
- **Negative test:** hard-code `enabled: true` in the mapping and confirm the notice-kind tests
  fail; restore and confirm they pass. Temporarily add `citations` to the Gemini payload and
  confirm the payload-freeze test fails. Record the counts for the review.

---

### Phase 2: Citable-document derivation helper

**Dependencies**: Phase 1 (record shape and `DocumentContentBlock` type)

#### Objective

The one place that turns stored tool records into citable documents. It is fail-closed,
deduplicated and ordered, never throws on malformed data, and never lets a raw record escape.

#### Files to Create / Modify

- `apps/api/lib/db/citable-documents.ts` (new). It is the only module that selects `tool_calls`
  for serving.
  - `deriveCitableDocuments(toolCalls: unknown): { documents: DocumentContentBlock[]; rejected:
    RejectReason[] }` is pure and never logs. `RejectReason` is a closed string-literal union,
    for example `'not_array' | 'bad_content' | 'bad_results' | 'bad_entry' | 'no_citations' |
    'bad_citations' | 'length_mismatch'`. It carries **only** these enum values, one per
    rejected record, and never record data, indexes into it, or text. `'no_citations'` (a legacy
    row) is counted but not logged, because it is expected. Its input is
    `unknown` on purpose, because stored jsonb is untrusted. It validates each record's shape
    at runtime and walks `tool_result` records in array (dispatch) order. It keeps result `i`
    only when `citations` is an array of the same length as `results` and
    `citations[i].enabled === true`. Each kept result becomes
    `{ type: 'document', source: { type, media_type, data: content }, title, ...(context
    string ? { context } : {}) }`. Duplicates are removed on `JSON.stringify([title, context ??
    null, data])`, and the first occurrence wins. A malformed or misaligned record contributes
    nothing, and the others still derive.
  - Compile-time fidelity guard: `source.type` and `media_type` come from the
    `DocumentBlock['source']` literal types, backed by a type-level assertion that fails the
    build if either literal is widened.
  - `findCitableDocumentsByThread(threadId, exec = db): Promise<Map<string,
    DocumentContentBlock[]>>` selects only `messages.id` and `messages.tool_calls`, where
    `thread_id = $1 AND role = 'assistant' AND tool_calls IS NOT NULL`. It derives inside the
    function and returns only message ids with non-empty lists. It does not export the raw rows,
    their type, or any other function that returns them. Its doc comment states that callers
    must already have authorized `threadId`.
  - Malformed-record reporting: the DB wrapper emits one `console.warn` per affected message
    with `{ messageId, reasons }`, where `reasons` is the de-duplicated non-legacy `rejected`
    list. It never includes record content. The wrapper returns only the documents map, so
    `rejected` does not leave the module either.
- `apps/api/tests/citable-documents.test.ts` (new): pure-function unit tests.
- `apps/api/tests/citable-documents-db.test.ts` (new): the DB helper on pglite.

#### Deliverables

- [ ] Pure derivation and DB helper, as above.
- [ ] Tests (below).

#### Acceptance Criteria

- [ ] Real hits are derived in dispatch order across multiple records and rounds.
- [ ] **Status-independence:** a zero-result "No Results" entry under `status: 'ok'` is excluded
      because its flag is `false`. A test builds a filter that keys on `status` and shows it
      would admit the notice, so the test demonstrably fails under a status-based rule.
- [ ] Every notice kind is excluded. A legacy record with no `citations` yields nothing, and so
      does a misaligned one.
- [ ] Each malformed shape in the spec yields nothing from that record without throwing, while a
      well-formed sibling record still derives. The shapes are: non-array `tool_calls`; missing
      or non-object `content`; non-array `results`; an entry with a non-string `title` or
      `content`; a non-string `context`; a `citations` element without a boolean `enabled`.
- [ ] Dedup keeps the first occurrence in place. Documents that differ only in `context`,
      including absent versus present, are both kept. An absent `context` key is omitted from the
      output.
- [ ] The DB helper returns a map keyed by message id with no empty entries, ignores user rows
      and NULL `tool_calls`, and ignores `tool_call_orphans`.
- [ ] `rejected` reports the right enum value for each malformed shape. A test asserts that the
      warn call's argument contains only `messageId` and `reasons`, with no record text (the
      test seeds a sentinel string into the malformed record and checks it is absent from the
      logged arguments).
- [ ] Type-level test: `DocumentContentBlock` output has no `citations`, `status` or other
      record keys.
- [ ] Tests, typecheck and lint pass.

#### Test Plan

- **Unit:** a table-driven suite over hand-built record arrays covering all the cases above.
- **Integration (pglite):** insert assistant and user rows with varied `tool_calls` (legacy, new,
  malformed, NULL) plus an orphan row, then assert the map.
- **Negative tests:** remove the `enabled === true` check and confirm the status-independence and
  notice tests fail. Remove the length check and confirm the misalignment test fails. Record the
  counts.

---

### Phase 3: Serve documents on thread GET and share snapshots

**Dependencies**: Phase 2

#### Objective

Deliver the wire contract. Thread GET and share GET emit an identical `documents` field on
assistant messages with citable retrieval. Every other response is byte-identical.

#### Files to Create / Modify

- `apps/api/src/app/api/v2/threads/[id]/route.ts` (GET only). After the owner-scoped
  `getThreadWithMessages` succeeds, call `findCitableDocumentsByThread(thread.id)`. In the
  message map, spread `...(docs ? { documents: docs } : {})` **after** `created_at`. POST is
  untouched.
- `apps/api/lib/db/shares.ts`. In `createThreadSnapshot`, after the ownership check, add
  `messages.id` to the projection for lookup only (it is not written into the snapshot), call
  the same helper, and write `documents` as the last key of a snapshot message when it is
  non-empty.
- `apps/api/db/schema/shares.ts`: `ThreadSnapshot` message gains
  `documents?: DocumentContentBlock[]`.
- `apps/api/src/app/api/v2/share/[id]/route.ts` (GET): spread `documents` after `created_at`
  when it is present and non-empty in the snapshot.
- `apps/api/lib/db/threads.ts`: **no projection change.** `messageReadColumns` and `MessageRow`
  stay as they are. Only the doc comment is corrected, in Phase 4.
- `apps/api/tests/thread-get-contract.test.ts`: existing assertions stay unmodified. Add
  `citations` to `TOOL_KEY_PATTERN` and to its live-scan negative test, which checks known-bad
  keys and a near-miss. Add a second seeded conversation whose records carry `citations` and
  derive documents, and run the key scans over it too, so the scan is not vacuous.
- `apps/api/tests/documents-routes.test.ts` (new): serving, parity and byte-identity, on
  pglite through the real handlers.
- Every test file that `vi.mock`s `@/lib/db/shares`, `@/lib/db/threads` or the new module is
  grepped, and each factory is updated for the new import (lessons-critical).

#### Deliverables

- [ ] Thread GET, snapshot creation and share GET emit `documents` per the contract.
- [ ] Tests (below).

#### Acceptance Criteria

- [ ] An assistant message with citable retrieval has key order
      `[...MESSAGE_KEYS, 'documents']` on thread GET and `['role', 'content', 'created_at',
      'documents']` on share GET. The snapshot stores `['role', 'content', 'createdAt',
      'documents']`. `content` is still a bare string.
- [ ] Notice-only, no-tool, user, legacy-record and v1-style (no `tool_calls`) messages have no
      `documents` key.
- [ ] **Byte-identity:** the Phase 1 fixtures still match exactly.
- [ ] **Parity:** for a thread mixing citable, notice-only and no-tool assistant messages, each
      message's `documents` in a newly created share deep-equals the thread GET `documents` for
      the same message.
- [ ] A pre-change snapshot, meaning a stored `shares.content` without the key, returns no key.
- [ ] Malformed `tool_calls` on one message: thread GET returns 200 with the well-formed
      messages' documents, and share creation succeeds.
- [ ] Orphan rows change nothing: the response is byte-identical before and after inserting one.
- [ ] History replay is untouched: `findMessagesByThread` rows carry no `toolCalls` or
      `documents`. A POST turn-2 test asserts that the `messageHistory` handed to the facilitator
      contains no document text.
- [ ] No `tool_calls`, `citations`, `status`, `raw_payload` or provenance key in any
      serialized thread GET, share GET or snapshot body, including the documents-bearing seed.
- [ ] The existing `thread-get-contract.test.ts` assertions pass unmodified. Only additions are
      made.
- [ ] Full test suite, typecheck and lint pass.

#### Test Plan

- **Integration (pglite, real handlers):** all criteria above. Records are persisted through
  `createMessage` with realistic Phase 1-shaped records built by the real
  `buildToolResultRecord` path, where practical.
- **Negative tests:** stub `findCitableDocumentsByThread` to return an empty map and confirm the
  serving, parity and share tests fail; restore. Remove the non-empty guard and confirm the
  byte-identity fixture fails; restore. Move the spread before `created_at` and confirm the
  key-order assertion fails; restore. Record every count for the review.

---

### Phase 4: Invariant documentation and read-cost report

**Dependencies**: Phase 3

#### Objective

State the amended invariant accurately everywhere it is written, and measure the read cost
against the spec's bound.

#### Files to Create / Modify

- `codev/resources/arch-critical.md`: rewrite the Vertex/tool-history fact to the owner-ruled
  wording. Read helpers may load `tool_calls` **only inside** the dedicated derivation helper
  (`lib/db/citable-documents.ts`). No API response may serialize raw tool records. `raw_payload`
  is never serialized, and it stays in `messageReadColumns` only for replay. The one additive key
  is `documents`, last and omitted when empty. The hot-tier cap is kept, and wording is tightened
  rather than adding a line.
- `codev/resources/arch.md`: update the Tool-call persistence paragraph for the `citations` field
  and the read-path exception. Add a short Citable documents paragraph covering derivation,
  dedup, fail-closed legacy rows, C1 snapshots and the key position.
- In-code comments that repeat the old absolute claim: `db/schema/messages.ts` (the `toolCalls`
  column), `lib/db/threads.ts` (the `MessageRow` and projection doc) and `lib/db/shares.ts`
  (the snapshot projection comment). Grep the repo for other copies (for example "no API
  response", "project it OUT", "never selects it") and fix every hit.
- `codev/state/spir-168_thread.md`: measurement results.

#### Deliverables

- [ ] Docs and comments updated, with no stale copy left.
- [ ] Read-cost numbers recorded. **Storage:** a read-only `pg_column_size(tool_calls)` median
      and p95 over recent assistant rows, if the architect provides staging read access.
      Otherwise the same statistics over the synthetic fixture below, labelled as synthetic.
- [ ] **Latency method.** The script `apps/api/scripts/bench-thread-get.ts` is committed so the
      numbers can be reproduced. It is not part of the test suite.
  - *Fixture:* a pglite thread of 50 messages (25 user, 25 assistant). Every assistant row
    carries Phase 1-shaped `tool_calls`: 1–3 tool rounds and 5–10 results per call across the
    four tools. The results use realistic Arabic and English text lengths, sized so the median
    `tool_calls` is about 7 KB and matches the spec's accepted figure. This is asserted by the
    script before timing, so an empty or trivial derivation path cannot be measured by
    accident. About a third of the rows include a notice or a legacy (no `citations`) record.
  - *Baseline:* the pre-change thread-GET handler, defined as the GET logic at the Phase 2
    commit, which has no derivation call. It is run in the same process on the same fixture.
    The script imports a frozen copy of the pre-change GET mapping, kept in the script, beside
    the real post-change handler.
  - *Sampling:* 20 warm-up requests per variant, then 200 measured requests alternated between
    variants to cancel drift. Report median and p95 for each variant and the ratio.
  - The script also asserts that the post-change variant actually returned `documents` on the
    expected messages, which proves the derivation path ran.

#### Acceptance Criteria

- [ ] A grep for the old wording returns zero hits. The grep is negative-tested by running it
      against the pre-change text, where it must hit.
- [ ] `arch-critical.md` stays within its cap (≤10 facts, ≤35 lines).
- [ ] The cost bound is evaluated. If the median exceeds 14 KB/row, or latency exceeds 2× the
      baseline, `afx send architect` is sent before the PR is marked ready, and the PR body says
      so.

#### Test Plan

- Doc-only phase. Verification is the grep audit, the cap check and the recorded measurements.
  The full suite runs once more before the PR.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Existing exact-record tests break when `citations` is added | High (expected) | Low | Updated deliberately in Phase 1, and the commit message lists them. No test is weakened. |
| A `vi.mock` factory lacks the new module or export, and a route's try/catch swallows the error | Medium | High | Grep every factory mock of the touched modules in Phase 3. The serving tests run through real modules on pglite. |
| The byte-identity fixture is captured after the change and pins the wrong bytes | Low | High | Captured in Phase 1, before any serving code exists. |
| Key scans pass vacuously | Medium | Medium | Documents-bearing seed in the scan, plus negative tests of the pattern. |
| Malformed legacy jsonb causes a 500 | Low | Medium | Runtime validation with `unknown` input. Phase 2 and 3 tests cover each shape. |
| The benchmark measures a trivial path | Medium | Medium | The script asserts the fixture's median `tool_calls` size (~7 KB) and that `documents` were actually returned before it reports any timing. |
| No staging access for the cost measurement | Medium | Low | Synthetic fallback, stated in the PR. The architect is asked for read access in Phase 4. |
| The Gemini payload drifts | Low | High | `formatToolResultForGemini` untouched. The payload-freeze test is negative-tested. |

## Documentation Updates

- `codev/resources/arch-critical.md`: amended invariant (owner ruling condition 3).
- `codev/resources/arch.md`: tool-call persistence and citable documents paragraphs.
- In-code invariant comments in `db/schema/messages.ts`, `lib/db/threads.ts` and
  `lib/db/shares.ts`.
- `codev/resources/lessons-learned.md` / `lessons-critical.md`: decided in the Review phase.
- `codev/reviews/168-serve-citable-documents-derive.md`: written in the Review phase, with the
  negative-test counts and cost numbers.
