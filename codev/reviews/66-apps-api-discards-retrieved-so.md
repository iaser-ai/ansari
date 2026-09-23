# Review: apps/api discards retrieved source documents — persist and return them (issue #66)

## Summary

The facilitator now collects the citable documents (`citations.enabled === true`) from every
tool dispatch in a turn. Both v2 chat routes persist them in a new nullable `messages.documents`
jsonb column, and thread GET and share GET return them as a sibling `documents` key that appears
only when non-empty. The work landed in three phases: collect, then persist plus migration, then
return. Responses for messages without documents stay byte-identical, and Gemini replay
structurally cannot see the new column.

## Spec Compliance

- [x] A retrieval answer persists its citable documents on the same `messages` row, in the existing `document` ContentBlock shape (Phase 1 collector, Phase 2 persistence)
- [x] Only `citations.enabled: true` documents are kept. No-results, unavailable, limit and unknown-tool notices are excluded, and the filter fails closed (Phase 1)
- [x] Every dispatch is included (all loop iterations and the synthesis path) in dispatch order, deduplicated on `JSON.stringify([title, context ?? null, source.data])` with the first occurrence kept (Phase 1)
- [x] Persisted fields are exactly `type`, `source {type, media_type, data}`, `title` and `context` when present. The `citations` flag is dropped (Phase 1)
- [x] `GET /api/v2/threads/{id}` returns `documents` on the owning assistant message (Phase 3)
- [x] New share snapshots record documents, `GET /api/v2/share/{id}` returns them, and older snapshots omit the key (Phase 3)
- [x] New nullable `messages.documents` column with `messages.content` unchanged. Migration `apps/api/drizzle/0009_documents.sql` was generated and reviewed but **not applied anywhere** (Phase 2)
- [x] Additive: a fixture captured from the unmodified HEAD route proves that threads without documents are byte-identical. The existing exact-key contract asserts were left unmodified (Phase 3)
- [x] A no-tool answer persists NULL and returns no key (Phases 1–3)
- [x] Negative-tested at every site (see below)
- [x] Real-DB (pglite) coverage for persistence and GET (Phases 2–3)
- [x] Replay never reads documents: `messageReadColumns` and `MessageRow` exclude the column, and `raw_payload`/`tool_calls` writes are unchanged. The existing `facilitator-*.test.ts` suites pass without edits (Phases 1–2)
- [x] Answer text unchanged: no edits under `lib/ai/prompts/` and `formatToolResultForGemini` untouched (all phases)
- [x] Fields are plain JSON strings with no escaping or transformation (Phase 1)
- [x] Suite green: 813 passed / 3 skipped (pre-existing), typecheck clean, lint 0 errors (7 pre-existing warnings)

### Negative-test record

| Mutation | Result |
|---|---|
| Drop the collector `add` call in agent.ts | 7 tests fail |
| Drop the `citations.enabled` filter | 8 tests fail |
| Drop `documents:` from the web chat route's createMessage | 3 fail |
| Drop `documents:` from the chat route's createMessage | 3 fail |
| Add `documents` to `messageReadColumns` | projection test fails |
| Drop the thread-GET spread | 2 fail |
| Drop `documents` from the snapshot projection | 1 fails |
| Drop the share-GET spread | 1 fails |
| Make the key unconditional | 4 fail, including the original bare-string test and the byte-identity fixture |

The suite went green again after each mutation was restored.

## Deviations from Plan

- **Migration named by hand, `0009_documents.sql`.** `drizzle-kit generate` produced `0008_*`
  because it numbers files by journal index and `0005` is missing on disk. The file was renamed
  and the journal tag fixed, following the spec-73 convention. The **next** generate will emit
  `0009_*` again, so rename that one to `0010_*`.
- **pglite DDL sites: 9, not 10.** `model-provenance` only mentions `CREATE TABLE messages` in
  a comment.
- **Issue vs spec:** the issue suggested storing documents as `document` blocks inside
  `messages.content`, with no migration. The spec (architect-approved) uses a separate column,
  because blocks in `content` would turn every retrieval answer's bare-string `content` into an
  array and break the frozen mobile contract. That requires one additive migration.
- **No end-to-end POST→GET test in one file.** Phase 2 tests route persistence against pglite
  and Phase 3 tests GET from seeded rows. Both halves run the real handlers against a real DB.

## Consultation Feedback

The Gemini lane was skipped in every round (`agy` CLI not installed). Each Gemini file is a
non-blocking COMMENT skip notice with no content. There were no `CONSULT_ERROR`s.

### Specify Phase (Round 1)

#### Codex (REQUEST_CHANGES)
- **Concern**: the "documents never in `tool_calls`" criterion contradicts existing behaviour (`formatToolResultForGemini` text is already in `tool_calls`) → **Addressed**: the criterion was reworded to "written exactly as before" (7ed5124).
- **Concern**: the storage approach was left open → **Addressed**: the separate column is normative, confirmed by the architect (69ceb69).
- **Concern**: endpoint scope for share and routes → **Addressed**: share included; mcp-complete and v1 are out of scope.
- **Concern**: dedupe was defined imprecisely → **Addressed**: title+context+source.data, first occurrence wins.
- **Concern**: untrusted text and size bounds → **Addressed**: plain-text/untrusted requirement added; the current unbounded Usul result size is accepted explicitly.

#### Claude
- Still running when the human approved the spec. No output file was produced → **N/A**.

### Plan Phase (Round 1)

#### Codex (REQUEST_CHANGES)
- **Concern**: `documents: collected()` leaves the key present as `undefined` → **Addressed**: conditional spread (2444136).
- **Concern**: the package filter is `ansari-api`, not `api` (false green) → **Addressed**.
- **Concern**: doc updates were not assigned to a phase → **Addressed**: they landed in Phase 3.

#### Claude (COMMENT)
- **Concern**: the same `in`-vs-undefined issue → **Addressed** (conditional spread).
- **Concern**: Phase 3 might loosen the existing exact-key asserts → **Addressed**: kept unmodified; new pinned lists added.
- **Concern**: the client check targeted the wrong trees → **Addressed**: now covers `legacy/frontend-{web,app}` and the prototype.
- **Concern**: full-row lookups now return `documents` → **Addressed**: the threads.ts comment names them. The only consumer (feedback route) never serializes the message.
- **Concern**: dedupe key needed to be collision-safe → **Addressed**: JSON tuple key.

### Phase 1 (Round 1)

#### Codex — APPROVE, no concerns.
#### Claude (APPROVE)
- **Concern**: synthesis `done` with zero citable docs was untested → **Addressed** (5c1c295).
- **Concern**: `collected()` returns the live array → **Rebutted**: the generator returns immediately after the only yields, so no `add()` can follow. A copy would guard a state that cannot occur.
- **Concern**: mixed relative/alias imports → **N/A**: cosmetic only, left as is.

### Phase 2 (Round 1)

#### Codex — APPROVE, no concerns.
#### Claude (APPROVE)
- **Concern**: migration prefix drift → **Addressed**: recorded here, in the thread and in the PR (next generate → rename to `0010_*`).
- **Concern**: unused `shares` DDL in the test → **Addressed** (0eff8d9).
- **Concern**: the heartbeat strip used the SSE sentinel for both routes → **Addressed**: each route now strips its own sentinel (0eff8d9).

### Phase 3 (Round 1)

#### Codex — APPROVE, no concerns.
#### Claude (APPROVE)
- **Concern**: the inlined select in `getThreadWithMessages` duplicates `findMessagesByThread` → **Rebutted**: deliberate per plan. The separate projection is what makes replay isolation visible. Extract a helper if a third projection appears.
- **Concern**: share snapshots permanently copy ~7 KB/message of document text into `shares.content` → **Addressed**: recorded here and in the PR. The spec accepted the payload growth and public exposure.
- **Concern**: no single POST→GET test → **N/A**: recorded under Deviations. Both halves are tested against a real DB.

## Lessons Learned

### What Went Well
- Checking the issue's literal proposal against the frozen read contract before the spec was
  written. Storing blocks in `content` looked free ("the type already exists") but would have
  broken every bare-string client.
- The byte-identity fixture was captured by running a deterministic seed through the
  *unmodified* HEAD route (swapped in temporarily). This made "additive" a proven property
  rather than an asserted one.
- A separate read projection (`threadViewColumns`) that only the thread-view helper uses. This
  keeps replay and naming structurally blind to the column, following the spec-73 pattern.

### Challenges Encountered
- Both reviewers caught `'documents' in event` failing with `documents: undefined` at plan
  time. Absent and undefined-valued are different contracts. The conditional spread fixed it.
- The plan targeted the wrong client trees (`apps/frontend` consumes neither endpoint). The
  develop merge had brought `legacy/frontend-*` into the repo, so the stale "mobile app not in
  repo" assumption had to be dropped.
- Migration prefix drift, inherited from the missing `0005`, carried over again.

### What Would Be Done Differently
- Write one end-to-end POST→GET test to close the seam explicitly, even though both halves are
  real-DB tested.

### Methodology Improvements
- The Gemini lane was skipped in every round because the `agy` CLI is missing. Install it, or
  have porch surface the skip louder than a COMMENT verdict, since a skipped lane looks like a
  reviewer in the verdict list.
- The spec was approved while the Claude spec-review lane was still running, and its output was
  never produced. Porch could block the gate, or warn, while a lane is still in flight.

## Architecture Updates

- Routed: **hot** — `codev/resources/arch-critical.md` — the frozen-contract fact was extended in place with the one allowed additive key (sibling `documents`, only when non-empty, never selected by `messageReadColumns`). No new line, so the cap is unchanged (4268f10).
- Routed: **cold** — `codev/resources/arch.md` — new "Citable documents" paragraph under Gemini facilitator & message history (collector, column, `threadViewColumns`, share snapshot). Stale claims in the spec-73 paragraph about snapshot projection and migration numbering were also fixed (4268f10).

## Lessons Learned Updates

- Routed: **cold** — `codev/resources/lessons-learned.md` — new section **Citable documents (issue #66)**: check an issue's proposed storage shape against the frozen read contract; "absent" and "present-as-undefined" are different contracts; capture byte-identity fixtures from the unmodified route; give each read path its own projection. The migration-prefix corollary (next is `0010_*`) is folded in.
- Hot tier not changed: `lessons-critical.md` is at its 10-lesson cap, and these lessons are narrower than the incumbents. The map gets one entry for the new cold section (map cap 12, now 6).

## Flaky Tests

No flaky tests encountered. The 3 skipped tests were skipped before this project.

## Follow-up Items

- **Deploy order:** apply `0009_documents.sql` (`ALTER TABLE "messages" ADD COLUMN "documents" jsonb;`) **before** deploying. Every assistant insert now names the column.
- Prototype mapping (documents → `Citation`, adapter + zod) in `prototypes/ansari-expo`, the follow-up named in the issue.
- The inline `[1] [2]` marker convention is a prompt change that needs its own issue and justification.
- Optional: documents on `mcp-complete` / v1 completions (out of scope by architect decision).
- Next migration: rename drizzle's generated `0009_*` to `0010_*`.
