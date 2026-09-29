# Specification: Serve citable documents derived from `tool_calls`

## Problem Statement

`apps/api` retrieves source documents (Qur'an, hadith, tafsir, mawsuah) for most answers. It
records what the model saw in `messages.tool_calls`, but it gives clients none of it. #161 (the
Expo prototype's citation UI) is waiting for the sources behind each answer. The issue
originally specified them as an additive `documents` key on assistant messages in
`GET /api/v2/threads/{id}` and `GET /api/v2/share/{id}`. At the plan gate (2026-09-24) the owner
redirected serving to **dedicated `/documents` endpoints**, so that those two endpoints stay
exactly as they are today (see Constraints → Owner direction).

#66 (PR #162) delivered that key by copying the documents into a new `messages.documents` column.
That column was reverted in #165. The revert followed a staging outage (the migration was never
applied), and the column had also been criticised: it duplicated text that `tool_calls` already
stores, at about 7 KB per assistant message (~4 GB/year raw), and it copied the same text
permanently into public share snapshots.

This spec serves the same document shape by **deriving** it from `tool_calls`. That creates two
problems:

1. **Citability is lost before storage.** `formatToolResultForGemini` keeps `title`, `context`
   and the document text, but it drops `citations.enabled`. That flag is the only thing that
   separates a real source from a system notice. A search that ran and found nothing records
   `status: 'ok'`, and its result entry is `{ title: 'No Results', context: 'Quran Search',
   content: 'No results found.' }`. That entry has the same structure as a real verse. If we
   derived from today's rows, clients would receive "No Results" as a citable source for an
   Islamic answer.
2. **The read path must now load a column that a documented invariant keeps out of it.** The
   owner ruled on this (issue #168, "Owner ruling — approved, Option C") under conditions this
   spec adopts as constraints.

Affected: prototype and future mobile users, who get real, openable sources; released mobile
builds, which parse the frozen thread and share contract and must see no change. They would
otherwise download source texts they cannot use. The owner pays the storage cost.

## Current State

- **Tools** return `ToolResult { content, documents: DocumentBlock[], isDegraded? }`. Each
  `DocumentBlock` carries `source { type: 'text', media_type: 'text/plain', data }`, `title`,
  `context?`, and `citations?.enabled`. Real hits set `enabled: true`. Every notice sets
  `enabled: false`: no results (all four tools), "temporarily unavailable" (`unavailableResult`),
  the tool limit, and unknown tools.
- **The facilitator** turns each `ToolResult` into `{ results: [{title, context, content}],
  summary }` using `formatToolResultForGemini`. That object is sent to Gemini as the
  `functionResponse`. It is also persisted verbatim as `ToolCallRecord.content` on the
  `tool_result` record, alongside `status`, `duration_ms` and the degradation detail.
  `citations.enabled`, `source.type` and `source.media_type` are not persisted anywhere.
- **Why the flag was lost.** `DocumentBlock` has the shape of Anthropic's document block, where
  `citations.enabled` switches on Claude's built-in citations. Gemini has no such feature, so
  `formatToolResultForGemini` sends only what Gemini uses. Spec 73 then persisted that output
  as "the ground truth of what the model received", so the dropped flag was never stored.
  Neither step was a decision about citability. Nothing needed the flag until this spec.
- **Budget-skipped calls** persist `{ results: [], summary }` with `status: 'budget_skipped'`.
- **Turns without an assistant row** (error, empty final, mcp-complete 502) persist their records
  to `tool_call_orphans`, not to `messages`.
- **Read paths** use explicit projections. `messageReadColumns` (used by `findMessagesByThread`
  and `getThreadWithMessages`) omits `tool_calls` and provenance, and keeps `raw_payload` for
  history replay. `createThreadSnapshot` selects only `role`, `content` and `createdAt`.
- **Thread GET and share GET** emit `content` through `formatMessageContent`. A message with a
  single text block returns a bare string. Any other message returns the block array. Neither
  endpoint emits `documents`.
- **`arch-critical.md`** says the thread read helpers project `tool_calls` out, and that no API
  response may serialize it or `raw_payload`.
- **Share snapshots** are copies in `shares.content` (`ThreadSnapshot`). They carry no message
  ids.

## Desired State

- **Two new read endpoints serve the documents. Thread GET and share GET do not change at all.**
  - `GET /api/v2/threads/{id}/documents` (authenticated, owner-scoped) derives documents live
    from `tool_calls`.
  - `GET /api/v2/share/{id}/documents` (public) reads the documents copied into the share
    snapshot when it was created. It never touches `tool_calls`.
- Both return the same shape, and both list only assistant messages that have at least one
  citable document:
  ```ts
  // GET /api/v2/threads/{id}/documents
  { thread_id: string,
    messages: Array<{ message_id: string, message_index: number, documents: DocumentBlock[] }> }
  // GET /api/v2/share/{id}/documents
  { id: string,
    messages: Array<{ message_index: number, documents: DocumentBlock[] }> }
  // DocumentBlock, identical in both:
  { type: 'document', source: { type: 'text', media_type: 'text/plain', data: string },
    title: string, context?: string }
  ```
  - `message_index` is the zero-based position of that message in the corresponding GET's
    `messages` array (thread GET or share GET). It is the join key a client uses to attach
    documents to messages. Share GET exposes no message ids, so the index is the only key both
    endpoints can share. The thread endpoint also carries `message_id`.
  - A thread or share with no citable documents returns `messages: []`.
- Documents are listed in dispatch order and deduplicated on `(title, context, source.data)`. The
  first occurrence keeps its position.
- System notices never appear, whatever the record's `status` is.
- **Thread GET and share GET are byte-identical to today for every thread,** including threads
  with citable documents. `content`, key sets and key order do not move. Released mobile builds
  download nothing new.
- **Share snapshots keep the documents built in (C1).** `createThreadSnapshot` derives each
  message's documents at creation and stores them in `shares.content`. Share GET's explicit
  projection does not emit them. The share `/documents` endpoint does.
- The Gemini `functionResponse` and `formatToolResultForGemini` output are byte-identical to
  today's. `raw_payload` is unchanged. History replay never sees document text through this
  change.
- The persisted `tool_result` record carries each result entry's own `citations.enabled`, beside
  the Gemini result, not inside it. Derivation reads that flag and never infers citability.
- Raw `ToolCallRecord`s never leave a dedicated derivation helper. No route, serializer or
  shared read projection receives them.
- `arch-critical.md` (and `arch.md`) state the amended read posture accurately.

## Success Criteria

- [ ] `GET /api/v2/threads/{id}/documents` returns `{ thread_id, messages: [{ message_id,
      message_index, documents }] }` for each assistant message with citable retrieval, in thread
      order. Documents use the `{ type, source { type, media_type, data }, title, context? }`
      shape, in dispatch order, with duplicates removed and the first occurrence kept.
- [ ] Authorization matches thread GET exactly. A missing token or a bad token gets the same
      response thread GET gives. A thread that does not exist or belongs to another user returns
      the same 404 `Thread not found`, so the endpoint is not an existence oracle.
- [ ] `GET /api/v2/share/{id}/documents` returns `{ id, messages: [{ message_index, documents }]
      }` from the snapshot. An unknown share returns the same 404 `Share not found` as share GET.
      It never reads `messages` or `tool_calls`.
- [ ] **The two endpoints return the same documents field.** The element shape, the rules and the
      derivation helper are all shared. For a share created after this change, each entry's
      `documents` deep-equals the thread endpoint's `documents` for the same message, and the
      `message_index` values match. A pglite test asserts this through the real handlers for a
      thread mixing citable, notice-only and no-tool messages.
- [ ] `message_index` is correct. On both endpoints, `GET(...).messages[message_index]` is the
      message the documents belong to. A test checks this against the real thread GET and share
      GET responses.
- [ ] Notices are **never** returned as documents: "No Results" from each of the four tools,
      "temporarily unavailable" (degraded and backstop), tool limit, unknown tool, and budget
      skip. A zero-result search that records `status: 'ok'` is included. A test covers this and
      fails if citability were inferred from `status` alone.
- [ ] Messages with no citable retrieval are absent from `messages`. A thread with none returns
      `messages: []`, and so does a pre-change share snapshot.
- [ ] **Thread GET and share GET are byte-identical to today**, including for a thread whose
      messages do have citable documents. This is pinned by fixtures captured from the unmodified
      handlers. The existing `tests/thread-get-contract.test.ts` assertions stay unmodified. Share
      GET's output carries no `documents` key even though the snapshot stores one.
- [ ] `formatToolResultForGemini` output and the `functionResponse` sent to Gemini are
      byte-identical to today's, pinned by a test. `raw_payload` is unaffected.
- [ ] No new column and no migration. The flag lives inside the existing `tool_calls` jsonb, and
      snapshot documents live inside the existing `shares.content` jsonb. The migration-parity
      test (`DEPLOYED_THROUGH`) needs no bump.
- [ ] Rows persisted before this change, which lack the per-entry metadata, yield no documents
      (fail closed). A record whose metadata does not align with its results yields none from
      that record.
- [ ] Malformed stored data fails closed **per record**, and never fails the request. Examples:
      `tool_calls` is not an array; `content` or `results` is missing or not the expected type; a
      result entry is missing a string `title` or `content`; `context` is present but not a
      string; a `citations` element is not an object with a boolean `enabled`.
      The affected record contributes no documents. Well-formed records in the same message and
      thread still derive. The thread documents endpoint and share creation return their normal
      response, never a 500. Malformed data is logged only by `{messageId, reason}`, never with
      record content.
- [ ] The derivation helper is reached only after the caller has authorized the thread. On the
      thread documents endpoint, that means after the owner-scoped thread lookup succeeds. On
      share creation, it means after `createThreadSnapshot`'s ownership check. The helper
      performs no authorization of its own, and no route calls it on an unverified id.
- [ ] **Read cost is measured and reported against a concrete bound.** The PR reports two
      numbers. (a) The median and p95 `pg_column_size(tool_calls)` for assistant rows, measured
      on staging with a read-only query. An initial run on 2026-09-24 gave a median of 5.6 KB and
      a p95 of 14.1 KB. (b) The thread documents endpoint's latency beside thread GET's, on the
      same 50-message pglite fixture. The owner's "materially worse" condition trips, and the PR
      must flag it to the architect before merge, if the median exceeds **14 KB/row** (2× the
      accepted ~7 KB) or the documents endpoint's median latency exceeds **2×** thread GET's.
      Thread GET's own cost does not change.
- [ ] Raw `ToolCallRecord`s cannot reach a serializer. The derivation helper's return type
      contains only derived document blocks, and `messageReadColumns` / `MessageRow` still
      exclude `tool_calls`.
- [ ] History replay (`findMessagesByThread` → `convertToGeminiHistory`) loads neither
      `tool_calls` nor derived documents.
- [ ] Negative-tested: the returned-documents assertions fail when derivation is disabled (and
      when the citability filter is removed), and pass again when restored. The review records
      the counts.
- [ ] Real-DB (pglite) coverage: records are persisted through the real route or helper, then
      read back through the real `/documents` handlers, thread GET and share GET.
- [ ] `arch-critical.md` is updated. Only the dedicated derivation helper may load `tool_calls`
      for serving, and it is reached from the thread `/documents` endpoint and share creation.
      No API response may serialize the raw records. Thread GET and share GET carry no
      documents. `raw_payload` is never serialized in any response. `raw_payload` stays in
      `messageReadColumns` because history replay needs it, and the derivation helper never
      selects it. `arch.md` is updated to match. The in-code comments that make the old absolute
      claim are corrected in the same PR, with no stale copy left behind: `db/schema/messages.ts`
      (the `toolCalls` column comment), `lib/db/threads.ts` (the `MessageRow` and projection
      doc) and `lib/db/shares.ts` (the snapshot projection comment).

## Constraints

**Owner ruling on issue #168 (fixed; adopted verbatim in substance):**

1. Derivation lives in its own helper. That helper selects `tool_calls`, returns ONLY derived
   document blocks, and never hands raw `ToolCallRecord`s back to a caller. The raw records must
   not reach a serializer even in memory. This must hold structurally, not through a filter a
   reviewer has to remember.
2. **The API signature must not break (paramount).** `content` stays exactly as it is.
   `documents` is an additive sibling key, omitted when empty. Nothing else in the response
   shape moves. Released mobile builds parse this contract.
3. `arch-critical.md` is amended in this PR, and the old absolute wording must not remain beside
   contradicting code.
4. The thread-read cost has been accepted: about 7 KB of jsonb detoasted per assistant row. If it
   turns out materially worse, report it; do not absorb it quietly.

**Owner direction at the plan gate (2026-09-24, builder session). This amends condition 2's
serving mechanism:**

- Documents are served by dedicated endpoints, `GET /api/v2/threads/{id}/documents` and
  `GET /api/v2/share/{id}/documents`, **not** as a sibling key on thread GET and share GET.
  Condition 2's paramount goal, not breaking the API, is met more strongly: those two endpoints
  do not change at all. Condition 4's read cost moves off thread GET onto the new endpoint, and
  is paid only when a client asks for sources.
- Share snapshots keep the documents built in (C1): they are copied at creation, and the share
  `/documents` endpoint reads them from there.
- The `documents` element shape and the field name are unchanged.
- #161 (the prototype consumer) must switch from a per-message sibling key to a second fetch
  joined by `message_index`. This needs the prototypes architect's agreement, which the
  architect arranges.

**From the issue:**

- `formatToolResultForGemini` output and the Gemini `functionResponse` stay byte-identical. The
  #66 spec froze them.
- Citability must not be inferred from `status`, and must not be found by string-matching
  notice text (`lib/tools/types.ts`).
- Dedup key is `(title, context, source.data)`, with the first occurrence kept at its position.
- Out of scope: inline `[N]` markers (these need a prompt change and their own sign-off), the
  prototype mapping (#161), backfilling historical rows, and sources in the streaming responses
  (SSE `tool_result` / `done` frames; see #109).

**Existing system:**

- DB schema changes follow `drizzle-kit generate` → human-applied, and never `db:push`. This
  design avoids a schema change altogether.
- DB helpers take a trailing `exec` parameter.
- Log only `{name, code}` from driver errors.
- `ToolCallRecord.content` is documented as "the ground truth of what the model received". It
  must remain exactly the Gemini payload, so nothing may be added inside it.

## Assumptions

- `tool_calls` rows are write-once. Nothing updates a message's `tool_calls` after insert.
- `tool_result` records are built at two sites in the facilitator: `buildToolResultRecord`
  (executed, limit-refused and unknown-tool calls) and the inline budget-skip record. Both must
  carry `citations`. The budget-skip record's is `[]`, because its `results` is `[]`. A
  record's `citations` is present exactly when it was written after this change.
- Each `tool_result` record's `content.results` has one entry per `ToolResult.documents` entry,
  in the same order. `formatToolResultForGemini` is a 1:1 `map`, which makes positional
  alignment reliable at write time.
- Every tool today emits `source.type: 'text'` and `media_type: 'text/plain'`. The
  `DocumentBlock` TS type pins both as literals, so a tool cannot emit anything else without
  widening that type.
- The routes that persist `tool_calls` on assistant messages are `v2/threads/{id}` POST,
  `v2/threads/{id}/chat` and `v2/mcp-complete`. All three write the facilitator's records
  verbatim, so they gain `citations` without changes to the routes. **`v1/chat/completions` is
  out of scope.** It drops `event.toolCalls` and stores no `tool_calls` on the messages it
  creates, so those messages derive no documents, which fails closed. This spec does not change
  that route's persistence.
- Messages are append-only. Nothing deletes or reorders a thread's messages (verified: no
  `delete(messages)` or `update(messages)` in `apps/api`). A thread GET `messages` index is
  therefore stable, and a snapshot's messages are exactly the thread's first N messages. Thread
  deletion cascades to its shares.
- Snapshot `message_index` is the message's position in the snapshot's `messages` array, which
  share GET emits in the same order.
- #165 (the column revert) is merged. `develop` has no `messages.documents` column and no
  collector.

## Solution Approaches

### A. Where citability is persisted

**A1: Save the tool's own `citations.enabled`, per result, beside the Gemini result (decided).**
Add one optional sibling field to the persisted `tool_result` record: `citations`, an array
aligned index-for-index with `content.results`. Each element is `{ enabled: boolean }`, copied
from the same `ToolResult.documents[i].citations` that `formatToolResultForGemini` maps, with a
missing flag saved as `false`. Nothing else is added.
- Pros: it uses the value each tool already sets, and derivation reads it without inferring
  anything. `content` and the Gemini payload are untouched. It is per-entry, so a tool that ever
  mixes hits and notices is handled. **It is not a database change:** there is no new column, no
  table and no migration. It is one extra key inside the JSON already written to the existing
  `tool_calls` column, and code that does not know about it ignores it.
- Cons: the alignment invariant must hold, so derivation fails closed when the lengths differ. It
  adds about 20 bytes per result entry.

**A2: Record-level `citable` boolean.** One flag per `tool_result`.
- Rejected. It assumes a tool never mixes hits and notices in one result. That is true today, but
  nothing enforces it.

**A3: Store the flag inside `content.results[i]`.**
- Rejected. It changes the "ground truth of what the model received", and either changes the
  Gemini payload or makes the persisted `content` stop matching it.

**A4: Decide at read time from the tool's identity or the document's wording, with nothing
saved.**
- Rejected. A zero-result search records `status: 'ok'`, and its entry has the same structure as
  a real hit from the same tool. So telling them apart means either matching on display text,
  which `lib/tools/types.ts` forbids and which breaks silently when the wording changes, or
  changing the tools' zero-result output, which changes the frozen Gemini payload.

**Source typing (fidelity caveat).** `source.type` and `source.media_type` are not saved.
Derivation fills them in as `'text'` and `'text/plain'`. The guard is compile-time: derivation
takes those values from the `DocumentBlock['source']` literal types, not from free-standing
strings. A future tool that emits another media type has to widen `DocumentBlock`, and that
widening must break the build at the derivation site until someone decides how to serve it. A
test pins this behaviour.

### B. Where derivation runs

**B1: Dedicated TypeScript helper in the DB layer (recommended).** A new read helper selects
`id` and `tool_calls` for a thread's assistant messages. It derives inside the function and
returns only a per-message-id map of derived document blocks. A pure derivation function
(records → documents) sits beside it for unit testing, and its input type is internal to the
module. The thread `/documents` route maps the result to its response entries.
`messageReadColumns`, `MessageRow` and history replay are untouched.
- Pros: meets the owner's condition 1 directly. The raw records exist only inside the helper's
  scope. It is easy to test with pure unit tests plus pglite. Dedup semantics are explicit.
- Cons: the documents endpoint detoasts raw jsonb into Node memory. The owner accepted this cost,
  and thread GET no longer pays it.

**B2: Derive in SQL** (`jsonb_array_elements` over `tool_calls` joined to `citations`,
filtered on `citable`, and ordered). Only derived rows cross the wire.
- Pros: raw records never reach Node.
- Cons: the dedup and first-occurrence ordering logic is hard to read, hard to test, and has to
  be verified on pglite and Postgres. Future changes to the derivation rule land in SQL strings.
  The detoast cost is the same. Not recommended. Revisit only if read cost becomes a problem.

**B3: Widen `getThreadWithMessages`'s projection with `tool_calls`.**
- Rejected. The raw records would reach the route, which is the filter-not-structure posture the
  owner ruled out.

### C. Share snapshots

**C1: Derive at snapshot creation and copy into the snapshot (decided; owner-confirmed
2026-09-24).** `createThreadSnapshot` calls the same derivation helper and writes each message's
non-empty `documents` into `ThreadSnapshot`. The share `/documents` endpoint reads them from the
snapshot. Share GET's explicit projection keeps emitting only `role`, `content` and `created_at`.
- Pros: snapshots stay immutable. The **public, unauthenticated** endpoints never load
  `tool_calls`. Old snapshots naturally have no documents.
- Cons: document text is duplicated into `shares.content` for shared threads. The cost scales
  with shares created, not with messages.

**C2: Derive at share read** from `shares.thread_id`, matching snapshot messages to thread
messages by position.
- Considered and not chosen by the owner. It would avoid the duplication and give older shares
  documents, but the public endpoint would read `tool_calls`, and a share's output could change
  whenever the derivation code changes.

### F. Serving surface

**F1: Additive `documents` sibling key on thread GET and share GET** (the issue's original
contract).
- Not chosen by the owner. Every thread load, including those from released mobile builds that
  cannot use the data, would pay for reading and sending the source texts.

**F2: Dedicated `/documents` endpoints (decided; owner direction 2026-09-24).**
- Pros: thread GET and share GET don't change at all. Released clients pay nothing. Sources load
  only when a client wants them, for example when the user opens them. Only one authenticated
  route reads `tool_calls`.
- Cons: #161 must change to a second request plus a join, and needs the prototypes architect's
  agreement. There is one more round trip for clients that show sources, and two more routes to
  secure (one of them public).

### D. Historical rows and orphans

- **Historical rows: fail closed.** A record without `citations` contributes no documents. No
  heuristic and no string matching. This matches #66, which did not backfill either.
- **`tool_call_orphans`: no documents.** These turns have no assistant message to attach
  documents to, and the user saw an error. This is acceptable.

### E. #109 (one source of truth)

The per-entry citability computed in the facilitator is the same fact #109's SSE `tool_result`
frame lacks. This spec does not change the SSE frame, but the plan should compute citability in
one place so #109 can reuse it.

## Open Questions

**Critical (block progress):**
- None open. The invariant question is resolved by the owner ruling.

**Important (shape design): decided.** This spec's design is **A1 + B1 + C1 + F2 + fail closed**,
and the rest of the spec is written against it. The plan does not re-decide.
1. Share snapshot timing: **C1**, copy at creation.
2. Persisted shape: **A1**, per-entry `citations: [{ enabled }]`, beside the Gemini result.
3. Historical rows: **fail closed**.
4. Serving: **F2**, dedicated `/documents` endpoints joined by `message_index`.

**Pending outside this repo:** the prototypes architect's agreement to the F2 contract for #161.
It does not block the API work, but it does block #161.

**Nice-to-know:**
- Whether the derivation helper should cap the number of documents per message. Not proposed:
  #66 shipped uncapped.

## Test Scenarios

1. **Happy path (pglite, real handlers):** an assistant turn with two citable Quran verses and
   one hadith. The thread `/documents` endpoint returns them in dispatch order, with the exact
   shape, the right `message_id`, and a `message_index` that points at that message in thread
   GET.
2. **Notices under an `ok` status:** a zero-result search (`status: 'ok'`, "No Results" entry)
   alongside a real hit. Only the real hit is returned. This test must fail if the filter keyed
   on `status`.
3. **All notice kinds:** each tool's "No Results", degraded "temporarily unavailable", backstop,
   tool limit, unknown tool and budget skip. None of them is returned. A message containing only
   notices is absent from `messages`.
4. **Dedup:** the same `(title, context, data)` retrieved by two calls appears once, at its first
   position. Documents that differ only in `context` (including absent versus present) are both
   kept.
5. **`context` absent:** the key is omitted from the document, never set to `null` or
   `undefined`.
6. **Historical row:** a `tool_calls` record without `citations` yields nothing. A misaligned
   `citations` length yields nothing from that record.
6a. **Malformed jsonb (pglite, real handler):** each malformed shape from Success Criteria is
    stored beside one well-formed citable record. The documents endpoint returns 200 with only
    the well-formed record's documents, and share creation succeeds. A v1-created message (no
    `tool_calls`) yields nothing.
7. **Byte-identity:** thread GET and share GET, for a thread that **does** have citable
   documents, serialize identically to fixtures captured from the unmodified handlers.
8. **Gemini payload frozen:** `formatToolResultForGemini` output and the `functionResponse` parts
   are unchanged for a representative result, and the persisted `content` equals the payload
   sent.
9. **Structural safety:** the `/documents` responses, thread GET, share GET and the stored
   snapshot contain no `tool_calls`, `citations`, `raw_payload`, `status` or provenance keys,
   even with every column populated. The existing contract scan is extended to cover
   `citations`, and runs over a documents-bearing seed so it cannot pass vacuously. The scan
   pattern is itself negative-tested against a known-bad and a known-near-miss line.
10. **Replay untouched:** `findMessagesByThread` rows carry no `tool_calls` or `documents`, and
    turn-2+ history contains no document text.
11. **Share parity:** for a share created after the change, the share `/documents` endpoint's
    entries deep-equal the thread endpoint's `documents` and `message_index`. A pre-change
    snapshot returns `messages: []`. A message added to the thread after the share was created
    does not appear on the share endpoint.
12. **Auth:** the thread endpoint returns a missing-token or bad-token response identical to
    thread GET's, and the same 404 for a foreign thread and a nonexistent one. The share endpoint
    returns 404 for an unknown share.
13. **Orphans:** a thread with orphan rows returns the same documents response.
14. **Negative test:** disabling derivation, or removing the citability filter, fails scenarios
    1–3 and 11. Restoring makes them pass.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| A notice is served as a citable source for an Islamic answer | Low (after fix) | High | Fail closed on `citable !== true`. A test fails under a status-based filter. Historical rows are excluded. |
| The contract breaks for released mobile builds | Very low | High | Thread GET and share GET are not modified. A byte-identity fixture on a documents-bearing thread and the unmodified existing contract tests guard it. |
| `message_index` points at the wrong message | Low | Medium | Messages are append-only, and both indices come from the same `created_at` order as the GETs. A test asserts that `GET.messages[message_index]` is the right message on both endpoints. |
| #161 is built against the old sibling-key contract | Medium | Medium | The architect coordinates with the prototypes architect before #161 proceeds. The PR body states the new contract. |
| Raw records leak into a response | Low | High | Dedicated helper whose return type holds only derived blocks. `MessageRow` unchanged. Extended key scan. |
| Malformed or hand-edited jsonb causes a 500 on thread GET or share creation | Low | Medium | Per-record shape validation fails closed. A pglite test covers each malformed shape. |
| `citations` misaligns with `results` (future change to `formatToolResultForGemini`) | Low | Medium | Both are built from the same `documents` array at one site. Derivation drops a record whose lengths differ. |
| Documents-endpoint latency or memory from detoasting `tool_calls` | Medium | Low | Paid only on request. Staging median is 5.6 KB/row. The PR must flag it past the concrete bound (median > 14 KB/row, or latency > 2× thread GET). |
| A future tool emits a non-text media type | Low | Medium | Derivation takes `'text'`/`'text/plain'` from the `DocumentBlock` literal types, so widening the type breaks the build at the derivation site. |
| Document text rendered unsafely by a client, including on public shares | Low | Medium | Plain JSON strings, unchanged from #66's contract. Clients render them as text. |
| Snapshot duplication grows `shares` | Low | Low | It scales with shares only. Revisit with C2 if shares prove large. |
| The public share `/documents` endpoint is abused or leaks | Low | Medium | It reads only the snapshot the share already made public. It gets the same 404 behaviour as share GET, and its exposure matches share GET (neither is rate limited today). |

## References

- Issue #168 and the owner ruling comment ("Owner ruling — approved, Option C")
- #161: consumer (prototype citation mapping)
- #66 / PR #162: the duplicate-storage approach. Spec `codev/specs/66-apps-api-discards-retrieved-so.md`. The collector's dedup semantics are carried over.
- #165 / PR #173: the column revert, and the `migration-schema-parity` test
- #109: SSE `tool_result` frame lacking the citable/notice distinction
- Spec 73: tool-call persistence (`codev/specs/73-persist-tool-use-and-tool-resu.md`)
- `apps/api/lib/facilitator/agent.ts` (`formatToolResultForGemini`, `buildToolResultRecord`, budget-skip record)
- `apps/api/lib/tools/types.ts` (`DocumentBlock`, `isDegraded` contract), `lib/tools/search-*.ts`, `lib/tools/resilience.ts`
- `apps/api/lib/db/threads.ts`, `apps/api/lib/db/shares.ts`, `apps/api/db/schema/{messages,shares}.ts`
- `codev/resources/arch-critical.md`, `codev/resources/arch.md` (Gemini facilitator & message history)
