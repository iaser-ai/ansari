# Specification: Serve citable documents derived from `tool_calls`

## Problem Statement

`apps/api` retrieves source documents (Qur'an, hadith, tafsir, mawsuah) for most answers. It
records what the model saw in `messages.tool_calls`, but it gives clients none of it. #161 (the
Expo prototype's citation UI) is waiting on an additive `documents` key on assistant messages,
returned by `GET /api/v2/threads/{id}` and `GET /api/v2/share/{id}`.

#66 (PR #162) delivered that key by copying the documents into a new `messages.documents` column.
That column was reverted in #165. The revert followed a staging outage (the migration was never
applied), and the column had also been criticised: it duplicated text that `tool_calls` already
stores, at about 7 KB per assistant message (~4 GB/year raw), and it copied the same text
permanently into public share snapshots.

This spec serves the same wire contract by **deriving** the documents at read time from
`tool_calls`. That creates two problems:

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
builds, which parse the frozen thread and share contract and must see no change; the owner, who
pays the storage cost.

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

- Every assistant message whose turn retrieved at least one citable document returns a
  `documents` array on thread GET and share GET. The array is a sibling of `content`, and each
  element has this shape:
  `{ type: 'document', source: { type, media_type, data }, title, context? }`.
  This is the exact `document` ContentBlock shape #161's zod schema is written against.
- Documents are listed in dispatch order and deduplicated on `(title, context, source.data)`. The
  first occurrence keeps its position.
- System notices never appear, whatever the record's `status` is.
- The key is **omitted entirely** when a message has no citable document. That covers user
  messages, no-tool answers, all-notice turns, and historical rows. Such a response is
  byte-identical to today's.
- `content` does not change. A single-text message is still a bare string.
- The Gemini `functionResponse` and `formatToolResultForGemini` output are byte-identical to
  today's. `raw_payload` is unchanged. History replay never sees document text through this
  change.
- The persisted `tool_result` record carries citability and source typing for each result entry.
  Derivation reads them structurally and never infers them.
- Raw `ToolCallRecord`s never leave a dedicated derivation helper. No route, serializer or
  shared read projection receives them.
- `arch-critical.md` (and `arch.md`) state the amended read posture accurately.

## Success Criteria

- [ ] Thread GET returns `documents` on each assistant message that has citable retrieval, in the
      `{ type, source { type, media_type, data }, title, context? }` shape. Order is dispatch
      order, duplicates are removed, and the first occurrence wins.
- [ ] Share GET returns `documents` on the same messages for snapshots created after this change
      (see Solution Approaches → Share snapshots for the chosen timing).
- [ ] Notices are **never** returned as documents: "No Results" from each of the four tools,
      "temporarily unavailable" (degraded and backstop), tool limit, unknown tool, and budget
      skip. A zero-result search that records `status: 'ok'` is included. A test covers this and
      fails if citability were inferred from `status` alone.
- [ ] A message with no citable retrieval omits the `documents` key. A thread made only of such
      messages serializes byte-identically to the pre-change response, which is pinned by a
      fixture.
- [ ] `content` is unchanged, including the bare-string form.
- [ ] `formatToolResultForGemini` output and the `functionResponse` sent to Gemini are
      byte-identical to today's, pinned by a test. `raw_payload` is unaffected.
- [ ] No new column and no migration: the flag lives inside the existing `tool_calls` jsonb. The
      migration-parity test (`DEPLOYED_THROUGH`) needs no bump.
- [ ] Rows persisted before this change, which lack the per-entry metadata, yield no documents
      (fail closed). A record whose metadata does not align with its results yields none from
      that record.
- [ ] Raw `ToolCallRecord`s cannot reach a serializer. The derivation helper's return type
      contains only derived document blocks, and `messageReadColumns` / `MessageRow` still
      exclude `tool_calls`.
- [ ] History replay (`findMessagesByThread` → `convertToGeminiHistory`) loads neither
      `tool_calls` nor derived documents.
- [ ] Negative-tested: the returned-documents assertions fail when derivation is disabled (and
      when the citability filter is removed), and pass again when restored. The review records
      the counts.
- [ ] Real-DB (pglite) coverage: records are persisted through the real route or helper, then
      read back through the real thread GET and share GET handlers.
- [ ] `arch-critical.md` is updated to the owner-ruled wording: read helpers may load
      `tool_calls` for derivation, no API response may serialize the raw records, and
      `raw_payload` stays fully projected out. `arch.md` is updated to match.

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

**From the issue:**

- `formatToolResultForGemini` output and the Gemini `functionResponse` stay byte-identical. The
  #66 spec froze them.
- Citability must not be inferred from `status`, and must not be found by string-matching
  notice text (`lib/tools/types.ts`).
- Dedup key is `(title, context, source.data)`, with the first occurrence kept at its position.
- Out of scope: inline `[N]` markers (these need a prompt change and their own sign-off), the
  prototype mapping (#161), and backfilling historical rows.

**Existing system:**

- DB schema changes follow `drizzle-kit generate` → human-applied, and never `db:push`. This
  design avoids a schema change altogether.
- DB helpers take a trailing `exec` parameter.
- Log only `{name, code}` from driver errors.
- `ToolCallRecord.content` is documented as "the ground truth of what the model received". It
  must remain exactly the Gemini payload, so nothing may be added inside it.

## Assumptions

- `tool_calls` rows are write-once. Nothing updates a message's `tool_calls` after insert.
- Each `tool_result` record's `content.results` has one entry per `ToolResult.documents` entry,
  in the same order. `formatToolResultForGemini` is a 1:1 `map`, which makes positional
  alignment reliable at write time.
- Every tool today emits `source.type: 'text'` and `media_type: 'text/plain'`. The TS type pins
  both as literals.
- Assistant messages from `v2/mcp-complete` and `v1/chat/completions` persist through the same
  facilitator records. Anything visible on thread GET that has tool records gets documents by
  the same rule.
- #161 treats `documents` as optional and non-strict, as #66's prototype-side check found.
- #165 (the column revert) is merged. `develop` has no `messages.documents` column and no
  collector.

## Solution Approaches

### A. Where citability is persisted

**A1: Parallel per-entry metadata on the `tool_result` record (recommended).** Add an optional
sibling field to the persisted `tool_result` record, for example `result_meta`. It is an array
aligned index-for-index with `content.results`, and each element is `{ citable: boolean,
source_type, media_type }`. The facilitator builds it from the same `ToolResult.documents` that
`formatToolResultForGemini` maps.
- Pros: `content` and the Gemini payload stay untouched. It is structural and per-entry, so a
  tool that ever mixes hits and notices is handled. It persists `source_type` and `media_type`,
  so derivation copies instead of synthesizing, and the fidelity caveat goes away for every row
  that can produce documents. It needs no migration, because it lives in the existing jsonb.
- Cons: the alignment invariant must hold. Derivation must fail closed when the lengths differ.
  It adds roughly 60 bytes per result entry.

**A2: Record-level `citable` boolean.** One flag per `tool_result`.
- Pros: smallest change.
- Cons: it assumes a tool never mixes hits and notices in one result. That is true today but
  nothing enforces it. It also leaves `source.type`/`media_type` synthesized.

**A3: Store the flag inside `content.results[i]`.**
- Rejected. It changes the "ground truth of what the model received", and either changes the
  Gemini payload or makes the persisted `content` stop matching it.

**Source typing (fidelity caveat).** A1 persists the pair, so derivation never synthesizes it for
new rows. Historical rows fail closed, so synthesis is never needed. As belt and braces, the
facilitator should take the pair from the `DocumentBlock` it is recording, not from constants.

### B. Where derivation runs

**B1: Dedicated TypeScript helper in the DB layer (recommended).** A new read helper selects
`id` and `tool_calls` for a thread's assistant messages. It derives inside the function and
returns only a per-message-id map of derived document blocks. A pure derivation function
(records → documents) sits beside it for unit testing, and its input type is internal to the
module. The thread GET route merges the result into its response by message id.
`messageReadColumns`, `MessageRow` and history replay are untouched.
- Pros: meets the owner's condition 1 directly. The raw records exist only inside the helper's
  scope. It is easy to test with pure unit tests plus pglite. Dedup semantics are explicit.
- Cons: it adds a second query per thread GET (same index, `idx_messages_thread`), and raw jsonb
  is detoasted into Node memory. The owner accepted this cost.

**B2: Derive in SQL** (`jsonb_array_elements` over `tool_calls` joined to `result_meta`,
filtered on `citable`, and ordered). Only derived rows cross the wire.
- Pros: raw records never reach Node.
- Cons: the dedup and first-occurrence ordering logic is hard to read, hard to test, and has to
  be verified on pglite and Postgres. Future changes to the derivation rule land in SQL strings.
  The detoast cost is the same. Not recommended. Revisit only if read cost becomes a problem.

**B3: Widen `getThreadWithMessages`'s projection with `tool_calls`.**
- Rejected. The raw records would reach the route, which is the filter-not-structure posture the
  owner ruled out.

### C. Share snapshots

**C1: Derive at snapshot creation and copy into the snapshot (recommended).**
`createThreadSnapshot` calls the same derivation helper and writes each message's non-empty
`documents` into `ThreadSnapshot`. Share GET emits the key from the snapshot.
- Pros: snapshots stay immutable. The **public, unauthenticated** share GET never loads
  `tool_calls`, which confines the amended invariant to the authenticated thread path. Old
  snapshots naturally omit the key. Share GET adds no query.
- Cons: document text is duplicated into `shares.content` for shared threads, which is the #66
  criticism. The cost scales with shares created, not with messages, and shares are user-initiated
  and rare compared with messages.

**C2: Derive at share read.** Snapshots gain per-message ids, and share GET derives from the
live `tool_calls`.
- Pros: no duplication.
- Cons: the public endpoint loads raw tool records. The snapshot format changes (it needs
  message ids). Pre-change snapshots have no ids, so they can never gain documents. A snapshot's
  public output could change whenever the derivation code changes, so it is no longer truly a
  snapshot.

**Recommendation: C1.** The #66 duplication concern was mainly the per-message column, which
this spec removes. Keeping the public endpoint away from raw records is the stronger safety
property. **This needs explicit confirmation at spec approval** (see Open Questions).

### D. Historical rows and orphans

- **Historical rows: fail closed.** A record without `result_meta` contributes no documents. No
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

**Important (shape design, to be confirmed at spec approval):**
1. **Share snapshot timing: C1 (copy at creation) or C2 (derive at read)?** Recommended: C1.
2. **Persisted shape: A1 (per-entry `{citable, source_type, media_type}`) or A2 (record-level
   flag)?** Recommended: A1.
3. **Historical rows: fail closed?** Recommended: yes.

**Nice-to-know:**
- The real per-thread read cost on staging-sized threads. The plan will measure it against the
  ~7 KB/row figure and report it.
- Whether the derivation helper should cap the number of documents per message. Not proposed:
  #66 shipped uncapped.

## Test Scenarios

1. **Happy path (pglite, real handlers):** an assistant turn with two citable Quran verses and
   one hadith. Thread GET returns `documents` in dispatch order, with the exact shape and
   `content` still a bare string.
2. **Notices under an `ok` status:** a zero-result search (`status: 'ok'`, "No Results" entry)
   alongside a real hit. Only the real hit is returned. This test must fail if the filter keyed
   on `status`.
3. **All notice kinds:** each tool's "No Results", degraded "temporarily unavailable", backstop,
   tool limit, unknown tool and budget skip. None of them is returned. A message containing only
   notices has no `documents` key.
4. **Dedup:** the same `(title, context, data)` retrieved by two calls appears once, at its first
   position. Documents that differ only in `context` (including absent versus present) are both
   kept.
5. **`context` absent:** the key is omitted from the document, never set to `null` or
   `undefined`.
6. **Historical row:** a `tool_calls` record without `result_meta` yields no key. A misaligned
   `result_meta` length yields nothing from that record.
7. **Byte-identity:** a thread with no citable retrieval serializes identically to a fixture
   captured from the unmodified route.
8. **Gemini payload frozen:** `formatToolResultForGemini` output and the `functionResponse` parts
   are unchanged for a representative result, and the persisted `content` equals the payload
   sent.
9. **Structural safety:** the thread GET and share GET responses contain no `tool_calls`,
   `result_meta`, `raw_payload`, `status` or provenance keys, even with every column populated.
   The existing contract scan is extended to cover `result_meta`, and that scan is itself
   negative-tested.
10. **Replay untouched:** `findMessagesByThread` rows carry no `tool_calls` or `documents`, and
    turn-2+ history contains no document text.
11. **Share:** a snapshot created after the change returns the same documents as thread GET. A
    pre-change snapshot (no key) returns no key. A thread without citable documents produces a
    byte-identical share response.
12. **Orphans:** a thread with orphan rows returns the same messages and no additional documents.
13. **Negative test:** disabling derivation, or removing the citability filter, fails scenarios
    1–3 and 11. Restoring makes them pass.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| A notice is served as a citable source for an Islamic answer | Low (after fix) | High | Fail closed on `citable !== true`. A test fails under a status-based filter. Historical rows are excluded. |
| The contract breaks for released mobile builds | Low | High | Key is omitted when empty. Byte-identity fixture. `content` path untouched. Existing contract tests stay unmodified. |
| Raw records leak into a response | Low | High | Dedicated helper whose return type holds only derived blocks. `MessageRow` unchanged. Extended key scan. |
| `result_meta` misaligns with `results` (future change to `formatToolResultForGemini`) | Low | Medium | Both are built from the same `documents` array at one site. Derivation drops a record whose lengths differ. |
| Thread GET latency or memory from detoasting `tool_calls` | Medium | Low–Medium | Owner accepted about 7 KB/row. The plan measures it and the PR reports it if materially worse. |
| A future tool emits a non-text media type | Low | Medium | The pair is persisted per entry, never synthesized for new rows. |
| Document text rendered unsafely by a client, including on public shares | Low | Medium | Plain JSON strings, unchanged from #66's contract. Clients render them as text. |
| Snapshot duplication grows `shares` | Low | Low | It scales with shares only. Revisit with C2 if shares prove large. |

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
