# Specification: Persist and return retrieved source documents

<!--
SPEC vs PLAN BOUNDARY:
This spec defines WHAT and WHY. The plan defines HOW and WHEN.
-->

## Problem Statement

Ansari's value is cited answers, and `apps/api` drops the citations at the last step. For
every answer it retrieves source documents (Qur'an, hadith, tafsir, mawsuah), passes them to
the model, and then throws them away. No client can see which sources an answer was built on,
either while it streams or when the thread is reloaded.

Who this affects:

- **End users.** Answers arrive with no inspectable sources, even though the model had them.
- **Frontends.** `prototypes/ansari-expo` (#63) already ships `AnswerMessage` chips,
  `CitationChip` and `CitationSheet`, and they render empty every time. The production
  frontend will need the same data. No client can work around this, because the documents are
  not sent in any form. The only retrieval information a client gets today is the tool name,
  the query and a result count.

The retrieval, the document structures and a storage type all exist already. What is missing
is the step that connects them.

## Current State

- **Documents are built and then dropped.** Each search tool (`lib/tools/search-*.ts`)
  returns a `ToolResult` whose `documents` are `DocumentBlock`s: `title`, `context`,
  `source.data` (the actual text) and `citations: { enabled }`. Real retrieved sources carry
  `citations.enabled: true`. System notices (no results, source temporarily unavailable, tool
  limit reached, unknown tool) carry `citations.enabled: false`.
- **Only a count leaves the facilitator.** The `tool_result` stream event is
  `{ tool, query, resultCount }` (`lib/facilitator/agent.ts`). The documents go only into the
  Gemini `functionResponse` and into the spec-73 `tool_calls` telemetry record.
- **Persisted assistant content is text only.** Every persist site writes
  `content: [{ type: 'text', text }]`.
- **The storage type exists but nothing writes it.** `ContentBlock` in
  `db/schema/messages.ts` already declares
  `{ type: 'document'; source: {type, media_type, data}; title; context? }`, left over from the
  legacy backend (whose Mongo export has 120 `document` blocks in a 200-thread sample).
  Nothing writes it today.
- **The document text is already in the database, but it can't be served.** Spec 73
  persists each tool result's Gemini-formatted output, including each document's text, in
  `messages.tool_calls`. `arch-critical.md` forbids any API response from serializing
  `tool_calls`, and that record mixes real sources with system notices and telemetry fields.
  It is not a citation store.
- **The response contract is frozen.** `GET /api/v2/threads/{id}` and `GET /api/v2/share/{id}`
  return a message's `content` as a **bare string** when it holds exactly one text block, and
  as an array otherwise. `apps/frontend`, the mobile app and the prototype all parse this.
  Adding a `document` block to an answer's `content` would turn today's bare string into an
  array for every answer that used a tool. That breaks the contract for every client.

## Desired State

- Every assistant answer produced by a user-facing chat path persists the **citable source
  documents** retrieved during that turn. These are the documents with
  `citations.enabled: true`, in dispatch order, with duplicates collapsed (see the definition
  under Success Criteria). They are
  stored with the existing `document` ContentBlock shape, on the assistant message's own row.
- `GET /api/v2/threads/{id}` returns them on each assistant message as a new sibling field
  `documents`, next to the existing fields. `content` keeps exactly its current value and form
  (bare string stays a bare string).
- A message with no citable documents (no-tool answers, answers where every tool degraded or
  found nothing, user messages, legacy rows) omits the `documents` key. A thread with no
  retrieval therefore gets a response that is **byte-identical** to today's.
- System notices are never shown as citations.
- The answer text, the prompts, the Gemini function responses and the SSE/stream frames do
  not change.
- `raw_payload`, `tool_calls`, `tool_call_orphans` and history replay are untouched. Documents
  never enter the model's history.

## Success Criteria

- [ ] An assistant answer whose turn ran at least one tool that returned citable documents
      persists those documents on the same `messages` row, using the existing `document`
      ContentBlock shape (`type`, `source {type, media_type, data}`, `title`, `context`).
- [ ] Only `citations.enabled: true` documents are persisted. "No results", "temporarily
      unavailable", "tool limit" and "unknown tool" notices are not.
- [ ] Documents from every tool dispatch in the turn are included (all loop iterations and the
      synthesis path), in dispatch order. **Deduplication:** two documents are duplicates when
      their `title`, `context` and `source.data` are all equal. The first occurrence is kept at
      its original position and later ones are dropped. `source.type`/`media_type` are constant
      today and are not compared.
- [ ] Each persisted document has exactly the fields `type`, `source {type, media_type,
      data}`, `title` and `context` (when present). The in-process `citations` flag is not
      persisted or returned; every persisted document is citable by definition.
- [ ] `GET /api/v2/threads/{id}` returns them as `documents` on the owning assistant message.
- [ ] Share snapshots created after the change record each message's documents.
      `GET /api/v2/share/{id}` returns them as `documents`. Older snapshots omit the key.
- [ ] Documents live in a new nullable `messages.documents` column. `messages.content` is
      unchanged. The migration is generated, reviewed and left for a human to apply (never
      `db:push`).
- [ ] **Additive:** for every message, `content` is identical to what the pre-change code
      returns for the same row, including the bare-string form. A thread without documents gets
      a response byte-identical to today's (no `documents` key anywhere).
- [ ] A no-tool answer persists and returns no documents.
- [ ] **Negative-tested:** the persisted-documents assertion and the returned-documents
      assertion are each shown to **fail** when documents are dropped (persist site omits them;
      GET omits them; share omits them), and to pass again once restored. The review records this.
- [ ] The persisted documents are covered by a real-DB (pglite) test, not only mocks.
- [ ] The new documents store never feeds Gemini history on a later turn (raw-payload path and
      text-only fallback path) and never adds `document` blocks to `raw_payload`. `raw_payload`
      and `tool_calls` are written exactly as before this change. `tool_calls` already contains
      tool-result text through `formatToolResultForGemini` (spec 73), and that stays as it is.
      The model's own answer text may quote a source as it does today.
- [ ] Answer text unchanged. No edits under `lib/ai/prompts/`. `formatToolResultForGemini`
      output unchanged.
- [ ] Returned document fields are plain JSON strings, never HTML or markup the API
      interprets. Clients must render them as untrusted plain text. The API adds no escaping
      or transformation that would alter the source text.
- [ ] Existing suite green (`pnpm` test, typecheck and lint for `apps/api`).

## Constraints

- **Frozen response contract** (`arch-critical.md`): single-text `content` stays a bare string.
  `tool_calls` and `raw_payload` are never serialized. Only additive keys are allowed.
- **Vertex history contract** (`arch-critical.md`): `raw_payload` holds only the final model
  turn with zero `functionCall` parts. Nothing here may write into it or change what replay
  sends.
- **Schema changes** follow `drizzle-kit generate`, then SQL review, then a human applies the
  migration at deploy. Never `db:push`. Deploy order: migration first, then deploy.
- **No prompt changes.** Islamic-content prompt edits need their own cited justification
  (`CONTRIBUTING.md`).
- **Out of scope:**
  - the inline `[1] [2]` marker convention (separate issue, higher scrutiny)
  - enriching the `tool_result` stream frame (rejected in the issue)
  - the prototype-side documents → `Citation` mapping (follow-up issue)
  - backfilling historical rows

## Assumptions

- `citations.enabled` is a reliable signal for telling real sources from notices, since every
  tool and system notice sets it explicitly today. A future tool that omits it is treated as
  **not citable** (fail closed).
- Clients ignore unknown JSON keys. The prototype's zod schemas are documented as non-strict.
  `apps/frontend` and the mobile app do not validate strictly (to confirm during
  implementation).
- Storage and payload growth is acceptable. From spec 73's figures (~7 KB median per tool
  result, ~1.08 dispatches per assistant turn, ~1,486 assistant messages/day), citable
  documents add at most ~4 GB/year raw, before TOAST compression. That duplicates text
  already in `tool_calls`, and is small against a 50 GB volume at 5% used. Each assistant
  message in a thread GET response grows by about the same ~7 KB.

## Solution Approaches

### Approach 1: Document blocks in `content`, filtered at every serializer

Append the documents to the assistant row's `content` array after the text block. Change the
thread GET and share GET formatters to compute `content` from non-document blocks and emit
documents separately. Audit every other `content` reader (share snapshot creation, stats
preview, history-replay fallback, future readers).

- **Pros:** no migration, and it matches the issue's literal suggestion.
- **Cons:** keeping the contract depends on filtering, not structure. Any reader that forgets
  the filter, now or later, returns an array where clients expect a string, and that failure
  is silent. This is the exact failure mode spec 73's lesson warns against ("make invisibility
  structural, not a filter"). Documents also come back in every turn's history load
  (`findMessagesByThread` selects `content`), which spec 73's projection was designed to avoid.
- **Risk:** medium. The contract is only as safe as the least careful `content` reader.

### Approach 2: A dedicated nullable `documents` column holding `document` ContentBlocks (recommended)

Add a nullable jsonb column on `messages` whose element type is the existing `document`
ContentBlock. Store NULL, never `[]`, when a turn has no citable documents. `content` is not
touched. The thread GET read path selects the column explicitly and emits `documents`. The
history-replay helper does not select it.

- **Pros:** the contract holds by construction. No existing `content` reader changes, and
  nothing that doesn't select the column can leak it. It follows the pattern already used for
  `raw_payload` and `tool_calls`. History loads stay as cheap as today. It still uses the
  existing type, stored with the assistant message.
- **Cons:** needs a small additive migration (one nullable column, no backfill), applied by a
  human before deploy. Hand-written pglite test DDL for `messages` must gain the column.
- **Risk:** low. The migration is additive, and legacy rows read as NULL, which means no key
  in the response.

### Approach 3: Derive documents from `tool_calls` at read time

No write-path change. Thread GET reads `tool_calls` and rebuilds documents from the stored
Gemini-formatted results.

- **Rejected.** It violates the arch fact that no API response may serialize `tool_calls`. It
  also ties the public contract to a telemetry record, and those records don't keep
  `citations.enabled`, so notices can't be reliably told apart from sources.

### Approach 4: Stream-only (enrich the `tool_result` frame)

- **Rejected by the issue.** Citations would disappear on reload.

**Recommendation: Approach 2 (confirmed by the architect).** The issue asks to "use the existing `document` ContentBlock
type" and to "confirm" that no migration is needed. The finding: no migration is needed only
under Approach 1, and Approach 1 breaks the frozen contract unless every `content` reader
filters. A one-column additive migration buys structural safety. It also keeps the architect's
constraint: documents stay on the assistant's own row and out of `raw_payload` and the
tool-call machinery. This departs from the issue's no-migration expectation. The architect
accepted the departure on 2026-09-22.

## Open Questions

**Resolved by the architect (2026-09-22)**
- **Storage: Approach 2.** A sibling nullable `documents` jsonb column, not
  `messages.content`. This departs from the issue's "no migration" expectation, and the
  departure is accepted.
- **Share endpoint: included.** `GET /api/v2/share/{id}` also carries `documents`. The share
  snapshot records them at share time. Snapshots taken before the change have none and omit
  the key. Share `content` stays exactly as today.
- **Persist sites.** In scope: `POST /api/v2/threads/{id}` and `POST /api/v2/threads/{id}/chat`.
  Out of scope: `mcp-complete` and `v1/chat/completions`, which write system-account threads
  that no UI reads.
- **Empty vs omitted.** `documents` is omitted when there are none. It is stored as NULL,
  never `[]`.

**Size bounds (decided in this spec).** There is no new cap or truncation. Document count
and size are bounded by the existing limits: each tool's own result limit and the
facilitator's tool-usage limit per turn. The CitationSheet needs the full text. Spec 73's
~7 KB median per tool result is accepted, and so are its tail sizes (large Usul/mawsuah
entries). That exposure already applies to `tool_calls`, and here it becomes client-visible,
including on public shares. The retrieved texts are published Islamic sources, not user data.
Revisit with a cap if thread-GET or share payloads prove large in practice.

## Migration (human-applied)

The new column is a schema change and follows the `arch-critical.md` DB rule:

1. The builder generates the migration with `drizzle-kit generate`, which produces one additive
   `ALTER TABLE messages ADD COLUMN documents jsonb` (nullable, no default, no backfill). The
   migration is numbered after merging `develop` (spec-73 lesson on journal-index collisions).
2. The generated SQL is reviewed in the PR. It must contain nothing beyond that one additive
   column.
3. **A human applies it at deploy.** The builder never runs `db:push` and never applies it to
   any shared database.
4. Deploy order: **migration → deploy.** The new code writes the column, so deploying before
   the migration would fail every assistant insert. The old code ignores the column, so
   applying the migration first is safe.
5. Rollback: the old code keeps working with the column present. Dropping the column is
   optional and loses only citation data.

## Test Scenarios

1. **Retrieval produces documents.** A facilitator turn with one or more tool dispatches
   returning citable documents persists those documents (pglite) and returns them via thread
   GET on that assistant message, in dispatch order.
2. **No-tool answer.** Nothing is persisted (NULL) and there is no `documents` key. The whole
   thread GET response is byte-identical to the pre-change shape.
3. **Notices excluded.** A turn whose tools returned only "no results", degraded
   "unavailable", limit-refused or unknown-tool documents persists nothing.
4. **Mixed turn.** One tool degraded and one succeeded: only the successful tool's documents
   are persisted.
5. **Multi-round and synthesis.** Documents from every loop iteration, including the
   short-circuit synthesis path, are included. Exact duplicates across rounds are persisted
   once.
6. **Contract preserved.** A single-text answer with documents still returns `content` as a
   bare string. Every message's `content` equals the pre-change formatter's output.
7. **Replay isolation.** On turn 2, Gemini history (raw-payload path and legacy text fallback)
   contains no document text. `raw_payload` and `tool_calls` are unchanged from before.
8. **Error and empty turns.** No assistant row is written (as today), so no documents are
   written. Orphan tool records behave exactly as in spec 73.
9. **Share.** A share snapshot of a thread with documents returns them on the share GET, with
   `content` unchanged. A pre-change snapshot returns no `documents` key.
10. **Legacy rows.** Rows written before the change read back with no `documents` key.
11. **Negative tests.** With the persist site's documents deliberately dropped, scenario 1's
    persistence assertion fails. With the GET mapping deliberately dropped, its response
    assertion fails. Both pass once restored.
12. **Answer text unchanged.** The streamed text and the persisted text block are identical
    to before for the same model output. `formatToolResultForGemini` is unchanged.
13. **Mock hygiene.** Every `vi.mock` factory of a module that gains an export used by a route
    carries that export (lessons-critical).

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| A client breaks on the new `documents` key | Low | High | Key is additive and omitted when empty. Confirm the frontend and mobile parsers are non-strict before merge. |
| System notices shown as citations | Medium | Medium | Persist only `citations.enabled === true` (fail closed). Test with each notice kind. |
| Documents leak into Gemini history, breaking or changing answers | Low | High | Separate column, not selected by the replay helper. Replay isolation test. |
| Migration not applied before deploy → insert fails on the new column | Low | High | Standard deploy order (migration → deploy), called out in the PR and review. |
| Tests pass without exercising the path (mock drift, swallowed errors) | Medium | Medium | pglite test for persistence. Negative tests. Grep factory mocks. |
| Payload growth slows thread GET for long threads | Low | Low | ~7 KB per retrieval answer. Revisit with pagination if it matters. |
| Provider text rendered unsafely by a client (markup injection), including on public shares | Low | Medium | API returns plain JSON strings, unchanged. Clients must render them as plain text. Stated in the contract. |

## References

- Issue #66 (this spec); prototype issue #63 (citation UI that surfaced the gap)
- Spec 73: `codev/specs/73-persist-tool-use-and-tool-resu.md` and review (tool-call
  persistence, read-path projections, orphan table)
- Issue #70: final-turn `raw_payload` and history fidelity
- `codev/resources/arch-critical.md`: frozen contract, Vertex history rule, migration discipline
- `codev/resources/lessons-learned.md`, "Tool-call persistence (spec 73)"
- `apps/api/db/schema/messages.ts`, `apps/api/lib/facilitator/agent.ts`,
  `apps/api/lib/tools/types.ts`, `apps/api/src/app/api/v2/threads/[id]/route.ts`,
  `apps/api/src/app/api/v2/share/[id]/route.ts`, `apps/api/lib/db/threads.ts`,
  `apps/api/lib/db/shares.ts`
