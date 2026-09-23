# Plan: Persist and return retrieved source documents

**Specification**: [codev/specs/66-apps-api-discards-retrieved-so.md](../specs/66-apps-api-discards-retrieved-so.md)

## Executive Summary

This plan implements the spec's **Approach 2**, which the architect confirmed on 2026-09-22. It
adds a dedicated nullable `messages.documents` jsonb column whose elements use the existing
`document` ContentBlock shape. `messages.content` is not touched. The work follows the data from
where it is created to where it is served:

1. **The facilitator collects the citable documents** (`citations.enabled === true`, in dispatch
   order, deduped, with the `citations` flag stripped) across every tool dispatch in the turn. It
   reports them on the `done` event. Nothing the model sees changes.
2. **The two in-scope persist sites write them** to the new column. The migration is generated
   after merging `develop`, reviewed, and applied by a human. Replay never selects the column.
3. **The read surfaces return them**: thread GET, share snapshot creation and share GET. Each
   returns them as a sibling `documents` key, omitted when there are none, so `content` and
   every document-less response stay byte-identical.

Each phase is one commit that can be tested on its own. The order makes sure no phase writes
data that nothing produces yet, or reads a column that doesn't exist yet. All phases ship in a
single PR.

**What already exists** (confirmed in the code on this branch; `develop` has no changes in the
touched areas since the branch point):

- `DocumentBlock` (`lib/tools/types.ts`) carries `citations?: { enabled }`. Real sources set
  `true`. Every notice sets `false`: no-results, unavailable, limit-refused and unknown-tool
  (`agent.ts` ~L200–238), and budget-skipped calls have `documents: []`.
- Terminal events: the normal `done` (~L868) and the synthesis `done` inside `runSynthesis`
  (~L665). The `error` events (~L1054, ~L1065) write no assistant row and stay unchanged.
- `toolCallsOrNull` in `db/schema/messages.ts` is the pattern to copy for the NULL-never-`[]`
  normalizer.
- `findMessagesByThread` (the replay read, also used by `thread-naming`) and
  `getThreadWithMessages` (the thread-GET read) currently share `messageReadColumns`. They must
  **split**: replay keeps today's projection and thread GET gets a wider one.
- `createThreadSnapshot` uses an explicit `{role, content, createdAt}` projection.
- Latest migration: `0008_model_provenance`. The new one is expected to be `0009_*`, numbered
  after merging `develop`.

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "Facilitator collects citable documents on the done event"},
    {"id": "phase_2", "title": "documents column, migration, and persistence at both chat routes"},
    {"id": "phase_3", "title": "Thread GET and share return documents additively"}
  ]
}
```

## Phase Breakdown

### Phase 1: Facilitator collects citable documents on the done event

**Dependencies**: None

#### Objective

Make the retrieved sources available to callers. Every successful turn's terminal `done` event
carries the turn's citable documents in the persisted shape. The model's inputs, the SSE frames
and the `tool_calls` records stay exactly as they are.

#### Files to Create / Modify

- `apps/api/db/schema/messages.ts`: export
  `type DocumentContentBlock = Extract<ContentBlock, { type: 'document' }>` so the facilitator,
  persistence and read paths share one element type. This is a type-only addition, with no
  column yet.
- `apps/api/lib/facilitator/citable-documents.ts` (new): a small pure accumulator,
  `createCitableDocumentCollector()`, with `add(docs: DocumentBlock[])` and
  `collected(): DocumentContentBlock[] | undefined`:
  - keeps only `doc.citations?.enabled === true` (fail closed: a missing flag is not citable);
  - dedupes on `title` + `context` + `source.data`, keeping the first occurrence at its
    original position. The key is a collision-safe tuple,
    `JSON.stringify([title, context ?? null, source.data])`, never a separator-joined string,
    since all three are free text. A missing `context` and `context: undefined` are the same
    key;
  - projects to exactly `{ type: 'document', source: { type, media_type, data }, title,
    context? }`, dropping `citations` and any other field. `context` is included only when
    it is present;
  - `collected()` returns `undefined` when nothing was collected, never `[]`.
- `apps/api/lib/facilitator/agent.ts`:
  - `FacilitatorStreamEvent` gains `documents?: DocumentContentBlock[]`, documented as "set on
    `done` only; absent when the turn has no citable documents".
  - One collector per `runFacilitator` call, next to `toolCallRecords`. The loop calls
    `add(result.documents)` right after `processToolCall` returns, for every executed dispatch.
    Budget-skipped calls have no documents and are not fed in.
  - Both `done` yields (the normal path and `runSynthesis`) add documents with a
    **conditional spread**, `...(docs ? { documents: docs } : {})` where
    `docs = collected()`. The key is then genuinely absent when empty, not present as
    `undefined`. `error` yields do not carry documents.
  - `formatToolResultForGemini`, `buildToolResultRecord`, the `tool_result` frame, `onMessage`
    and all prompts are **unchanged**. `onMessage` is not used by either in-scope route, so it
    is out of scope.

#### Deliverables

- [ ] `DocumentContentBlock` type export
- [ ] `citable-documents.ts` collector
- [ ] `documents` on both `done` events
- [ ] Tests for this phase

#### Acceptance Criteria

- [ ] A turn whose tools return citable documents yields `done.documents` in dispatch order.
      This covers multi-round loops and the synthesis path, for both the T1 and T2 triggers.
- [ ] Each notice kind (no results, degraded/unavailable, limit-refused, unknown tool) and
      budget-skipped calls contribute nothing. A mixed turn keeps only the successful tool's
      documents.
- [ ] Exact duplicates (same title, context and data) across rounds appear once, at the first
      position. A near-duplicate that differs in any one of the three fields is kept.
- [ ] A no-tool turn's `done` has no `documents` key (`'documents' in event === false`, which
      holds because of the conditional spread).
- [ ] Each element has exactly the keys `type`, `source`, `title` and, when present,
      `context`. There is no `citations` key.
- [ ] `formatToolResultForGemini` output, the `tool_calls` records and the `tool_result` frame
      data are identical to before for the same tool results. This is asserted against the
      existing facilitator test expectations, which must pass unmodified.
- [ ] `pnpm --filter ansari-api test`, `typecheck` and `lint` are green (the package is `ansari-api`; `--filter api` matches nothing).

#### Test Plan

- **Unit** (`tests/citable-documents.test.ts`): filter (true / false / missing flag), dedupe
  (exact duplicate dropped, a near-miss in each of the three fields kept, first position
  preserved), key projection, and `undefined` when empty.
- **Facilitator** (`tests/facilitator-documents.test.ts`, following
  `facilitator-toolcalls.test.ts`'s mocked-Gemini/mocked-tool harness): single tool;
  multi-round with a cross-round duplicate; parallel calls in one round; the T1 synthesis path;
  the T2 synthesis path; each notice kind; the mixed degraded + success case; no-tool; and an
  error terminal event that carries no `documents`.
- The existing `facilitator-*.test.ts` suites pass with no edits. That is the regression proof
  that the Gemini inputs and `tool_calls` are unchanged.

### Phase 2: documents column, migration, and persistence at both chat routes

**Dependencies**: Phase 1

#### Objective

Persist each assistant answer's citable documents on its own `messages` row, in both
user-facing chat routes. NULL is stored when there are none. Replay stays isolated.

#### Files to Create / Modify

- **First, merge `origin/develop`** into the branch, then re-check
  `drizzle/meta/_journal.json` so the migration number follows whatever has landed (spec-73
  lesson).
- `apps/api/db/schema/messages.ts`:
  - `documents: jsonb('documents').$type<DocumentContentBlock[]>()`: nullable, no default,
    with a comment in the style of `toolCalls` (NULL never `[]`, excluded from the replay
    projection);
  - `documentsOrNull(docs)`, which mirrors `toolCallsOrNull`, so absent and empty both map to
    `null`.
- `apps/api/drizzle/0009_*.sql` + `drizzle/meta/*`, produced by `drizzle-kit generate`. The
  SQL must be exactly one `ALTER TABLE "messages" ADD COLUMN "documents" jsonb;`. **Never
  `db:push`, and never applied to any shared DB.**
- `apps/api/lib/db/threads.ts`: `MessageRow`'s `Omit<…>` adds `'documents'`, and
  `messageReadColumns` stays as it is. The replay helper structurally cannot return documents.
  The projection comment is updated to name `documents` alongside `toolCalls`. That includes
  the note that the full-row lookups (`findMessageById` / `findMessageInOwnedThread`, bare
  `select()`) now also return `documents`. They feed feedback ownership checks and are never
  serialized, which has been checked in the feedback route.
- `apps/api/src/app/api/v2/threads/[id]/route.ts` and `…/[id]/chat/route.ts`: the `done`
  branch's `createMessage` gains `documents: documentsOrNull(event.documents)`. Nothing else in
  the routes changes. The empty-final and error branches still write no assistant row.
- **pglite DDL:** add `documents jsonb` to every hand-written `CREATE TABLE messages`. The
  current grep hits 10 files: model-provenance, route-persistence-rollback, attribution-schema,
  feedback-idor, executor-threads-feedback, thread-get-contract, toolcalls-routes,
  rawpayload-persistence, feedback-upsert and toolcalls-persistence. **Re-grep after the
  develop merge**, and record the final hit count in the review.
- **Mock hygiene:** re-grep the `vi.mock` factories of `@/lib/db/threads`,
  `@/db/schema/messages` and `@/db/schema`. Today no factory mocks the schema module, which is
  why `documentsOrNull` lives there. Confirm that no route now calls an export that a factory
  lacks.

#### Deliverables

- [ ] Column + normalizer + generated, reviewed migration
- [ ] Both routes persist `documents`
- [ ] Every pglite DDL updated
- [ ] Tests for this phase, including negative tests

#### Acceptance Criteria

- [ ] With pglite and the real `createMessage`, a documents array round-trips verbatim, and a
      no-document write stores SQL `NULL` (not `'[]'::jsonb`).
- [ ] Through the real route handlers with a stubbed `runFacilitator`, for **both** routes:
      a `done` with documents persists them on the assistant row, and a `done` without them (or
      with `[]`) persists NULL. `content`, `raw_payload`, `tool_calls` and the SSE wire output
      are identical to the same turn without documents.
- [ ] Replay isolation: `findMessagesByThread` returns no `documents` key. On turn 2, the
      history passed to `runFacilitator` carries no document text, on both the raw-payload path
      and the text-only fallback path (a row with `raw_payload` NULL).
- [ ] Error and empty-final turns write no assistant row and no documents. Orphan behavior is
      unchanged (the existing spec-73 tests pass).
- [ ] **Negative test:** with `documents:` deleted from a route's `createMessage` call, the
      persistence assertion fails. Restored, it passes. The review records both runs.
- [ ] The migration SQL has been reviewed: one additive nullable column and nothing else.
- [ ] `pnpm --filter ansari-api test`, `typecheck` and `lint` are green (the package is `ansari-api`; `--filter api` matches nothing).

#### Test Plan

- **Real DB** (`tests/documents-persistence.test.ts`, pglite, following
  `toolcalls-persistence.test.ts`): round-trip, NULL-not-`[]`, and the `findMessagesByThread`
  projection.
- **Routes** (`tests/documents-routes.test.ts`, following `toolcalls-routes.test.ts`): both
  routes, the with/without/empty cases, turn-2 replay isolation on both history paths, and
  error/empty-final.
- **Negative test** run by hand, as described above. The output is captured for the review.

### Phase 3: Thread GET and share return documents additively

**Dependencies**: Phase 2

#### Objective

Return the persisted documents to clients as a sibling `documents` key on the owning message,
from `GET /api/v2/threads/{id}` and from share snapshots and `GET /api/v2/share/{id}`. Every
message's `content` and every document-less response stay byte-identical to today's.

#### Files to Create / Modify

- `apps/api/lib/db/threads.ts`: a separate `threadViewColumns = { ...messageReadColumns,
  documents: messages.documents }` used **only** by `getThreadWithMessages` (through a
  dedicated select, not `findMessagesByThread`). Its return type is
  `MessageRow & { documents: DocumentContentBlock[] | null }`. `findMessagesByThread`, which
  serves replay and thread naming, stays as it is.
- `apps/api/src/app/api/v2/threads/[id]/route.ts` (GET): after the existing keys, spread
  `...(m.documents && m.documents.length > 0 ? { documents: m.documents } : {})`. Key order,
  `formatMessageContent` and every other field stay as they are.
- `apps/api/db/schema/shares.ts`: the `ThreadSnapshot` message type gains optional
  `documents?: DocumentContentBlock[]`.
- `apps/api/lib/db/shares.ts`: the `createThreadSnapshot` projection adds
  `documents: messages.documents`, and the key is set on a snapshot message only when it is
  non-empty. The explicit projection still excludes `tool_calls` and `raw_payload`.
- `apps/api/src/app/api/v2/share/[id]/route.ts`: the same conditional spread when mapping
  snapshot messages. Old snapshots have no key, so they emit none.
- **Client check** (spec assumption). The real consumers of these endpoints are in the repo
  after the phase-2 `develop` merge:
  - `prototypes/ansari-expo`: already non-strict by design (`wire-schemas.ts:14`,
    "intentionally NOT `.strict()`"). Cite it.
  - `legacy/frontend-web` and `legacy/frontend-app` (the production web and mobile clients,
    imported in 73173ae): grep their thread-GET and share parsing, and confirm they tolerate an
    unknown key.
  - `apps/frontend` does not call these endpoints yet (no hits for `threads`, `share` or
    `thread_name`). Note that it is not affected.

  Record the file paths and findings in the review. If a strict parser turns up, stop and
  `afx send architect`.

#### Deliverables

- [ ] Thread GET emits `documents`
- [ ] Share snapshot records them and share GET emits them
- [ ] Client-parser confirmation
- [ ] Tests for this phase, including negative tests

#### Acceptance Criteria

- [ ] Thread GET on a thread with a documented answer returns `documents` on that assistant
      message only, with exactly the persisted elements, in order. `content` is still a bare
      string for a single-text answer.
- [ ] Thread GET on a thread with no documents (no-tool answers, user messages and legacy
      NULL rows) produces a response whose `JSON.stringify` equals the one the pre-change
      handler produces. This is asserted against a fixture captured from the unmodified
      formatter, with `'documents'` appearing nowhere.
- [ ] Share created after the change: the share GET returns `documents` on the same message
      and `content` is unchanged. A hand-inserted pre-change snapshot (no key) returns no
      `documents` key.
- [ ] The existing contract scans still pass: `TOOL_KEY_PATTERN` and `PROVENANCE_KEY_PATTERN`
      find nothing, and `raw_payload`/`tool_calls` are never serialized.
- [ ] **The existing exact-key assertions in `tests/thread-get-contract.test.ts` stay
      unmodified**: `Object.keys(m)).toEqual(MESSAGE_KEYS)` (~L194) and the snapshot key list
      `['role','content','createdAt']` (~L241). They are the frozen-contract guard for
      `tool_calls`, `raw_payload` and provenance, and they are also the byte-identity proof for
      document-less rows. They must never be loosened to `arrayContaining`. Document-bearing
      cases get their own pinned lists, `[...MESSAGE_KEYS, 'documents']` and
      `['role','content','createdAt','documents']`, which pins key order too.
- [ ] Returned strings equal the persisted strings exactly. No escaping or transformation is
      applied. This is asserted with a source text containing `<`, `&` and quotes.
- [ ] **Negative tests:** with the thread-GET spread removed, the returned-documents assertion
      fails. With the snapshot projection's `documents` removed, the share assertion fails.
      Each passes once restored. The review records the runs.
- [ ] `pnpm --filter ansari-api test`, `typecheck` and `lint` are green (the package is `ansari-api`; `--filter api` matches nothing). The full suite is green.

#### Test Plan

- **Contract** (extend `tests/thread-get-contract.test.ts`, which already uses pglite and the
  real GET handler): the documents-present case, the byte-identical no-documents case, the
  mixed thread (a documented answer next to a no-tool answer and user messages), and the
  share-with/without-documents cases, including a legacy snapshot row.
- **Projection**: extend `toolcalls-persistence.test.ts` or the phase-2 file. It checks that
  `getThreadWithMessages` returns `documents` while `findMessagesByThread` still does not.
- **Negative tests** by hand, as described above.
- **Manual**: run `pnpm --filter ansari-api test`, `typecheck` and `lint` in full.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Replay starts selecting `documents` (sent to Gemini, or growing history loads) | Low | High | Separate `threadViewColumns`. `messageReadColumns` stays as it is. Projection test plus turn-2 replay test on both history paths. |
| Migration number collides with a concurrently merged migration | Medium | Medium | Merge `develop` before `drizzle-kit generate`. Re-check the journal before the PR. |
| pglite DDL drift: a test file missing the column passes quietly or fails confusingly | Medium | Low | Re-grep after the merge. Whole-row selects fail loudly on unknown columns. Record the hit count in the review. |
| Mock factory lacks a new export and the failure is swallowed in a streaming route | Low | Medium | `documentsOrNull` lives in the schema module, which no factory mocks. Re-grep the factories in phases 2 and 3. |
| Notices persisted as citations | Low | Medium | Fail-closed filter. Unit test and facilitator test for each notice kind. |
| A strict client parser rejects the new key | Low | High | Phase-3 check of the parsers. Stop and escalate if a strict parser turns up. Mobile confirmation goes to the architect. |
| Deploying before the migration fails every assistant insert | Low | High | PR description and review state the order: migration → deploy. |

## Documentation Updates

These land in the **Phase 3 commit**, since that is when the documented behavior is complete.
Lessons are added in the review phase.

- `codev/resources/arch.md`, "Gemini facilitator & message history": describe the
  `messages.documents` column (citable sources only, NULL never `[]`, excluded from the replay
  projection, returned only by thread GET and share as a sibling key).
- `codev/resources/arch-critical.md`: extend the existing frozen-contract fact in place (no new
  fact, to stay within the cap) so that it notes `documents` as the one allowed additive
  sibling key and that replay must not select it.
- `codev/resources/lessons-learned.md`: add lessons at review time.
- Any other doc that describes the thread GET or share response shape, found by grepping for
  `thread_name`/`formatMessageContent` at implementation time, gets the `documents` key too
  (the "fix a doc defect everywhere" lesson).
- PR description: migration-first deploy order, the generated SQL, and the client-parser
  findings.
