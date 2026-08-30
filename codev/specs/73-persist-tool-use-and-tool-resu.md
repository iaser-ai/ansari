# Specification: Persist tool_use and tool_result

<!--
SPEC vs PLAN BOUNDARY:
This spec defines WHAT and WHY. The plan defines HOW and WHEN.
-->

## Problem Statement

Tool calls and their results are not persisted. Every assistant message stores a
single `text` content block and nothing else, so the system cannot answer basic
questions about its own retrieval layer.

This is a **regression from the legacy Python/Mongo backend**, not a missing
feature. The legacy system persisted both block types — a 200-thread sample of
the Mongo export (`analysis/data-local-v3/threads`) contains 1,521 `text`
blocks, **1,649 `tool_use`**, **1,649 `tool_result`**, and 120 `document`
blocks. The TypeScript rewrite carried the *types* across (`ContentBlock` in
`apps/api/db/schema/messages.ts:7-9` still declares `tool_use` and
`tool_result`) but never the code that writes them: `git log -S "type:
'tool_use'"` returns only "Initial import of the Ansari backend". Those union
members have been dead since day one.

Who is affected and how:

- **Operations / reliability.** Sentry reports ~35 degraded `search_mawsuah`
  events/day, but there is no denominator — no record of how many mawsuah calls
  ran. Estimates during the issue #72 investigation ranged from ~1% to ~15%, a
  15x spread on a number that should be exact. The pending Usul support email
  (`tmp/usul-degradation-email.md`) cannot state a failure rate honestly.
- **Research.** The published Ansari-paper tool-usage analysis (Qur'an search in
  51.6% of threads, hadith 43.8%, fiqh encyclopedia 34.1%) came from legacy
  Mongo data and is unreproducible from any current data.
- **Product.** No per-tool latency, failure, or usage trends exist at all.

## Current State

The facilitator loop (`apps/api/lib/facilitator/agent.ts`) executes tool calls
and streams lossy notifications — `tool_use` events carry only `{name}`,
`tool_result` events only `{tool, query, resultCount}` — but nothing about tool
activity reaches the database:

- The three persist sites all write assistant messages whose `content` is a
  single `text` block:
  - `src/app/api/v2/threads/[id]/route.ts` (web chat POST, primary path)
  - `src/app/api/v2/threads/[id]/chat/route.ts` (SSE chat variant)
  - `src/app/api/v2/mcp-complete/route.ts` (ai-skill surface)
- The routes' `tool_use` / `tool_result` switch cases are no-ops (or forward a
  lossy notification to the client) and discard everything.
- Full tool data exists in-process during the request: the facilitator's
  `tracker.callsWithArgs` records `{tool, args, id}` per dispatched call, and
  `processToolCall` returns the complete `ToolResult` (summary text, documents,
  `isDegraded` marker). It is simply dropped at request end.
- `messages.raw_payload` (PR #71, issue #70) deliberately stores only the FINAL
  model turn — guard-checked to carry zero `functionCall` parts — so tool
  args/results are **not** recoverable from it either.

Workaround today: none. Sentry gives numerators only; the Mongo export covers
only the legacy era.

## Desired State

Every assistant turn that invoked tools has a durable, queryable record of each
tool call and its result, stored in a **new nullable `tool_calls` jsonb column**
on `messages` — deliberately outside `content`, mirroring the `raw_payload`
approach from PR #71, so no API-serialization code path can ever leak it to
clients.

After implementation:

- `SELECT` queries over `messages.tool_calls` can compute exact per-tool call
  counts, failure (degraded) rates, latency distributions, and thread-level
  usage percentages — restoring (and improving on) what the legacy Mongo data
  supported.
- The mawsuah degradation rate becomes exactly computable (degraded mawsuah
  results / total mawsuah calls dispatched) — **over every completed tool
  dispatch, including those in turns that end in error or empty**.
- Assistant turns with no tool activity store `NULL` (not `[]`), keeping the
  common case free and scans cheap.
- The mobile/web API response contract is **byte-identical** to today's.

**Error turns are in scope (operator decision at spec review).** Turns that
end in an `error` event, an empty final answer, or mcp-complete's empty-answer
502 persist **no assistant row at all** today (`chat/route.ts` skips
`createMessage` on empty `fullText`; mcp-complete returns 502 before
persisting; a failed synthesis yields `error`). Tool calls executed during
those turns are disproportionately the degraded ones — excluding them biases
exactly the reliability metric this feature exists to measure. The guarantee
therefore extends to **every completed tool dispatch regardless of turn
outcome**: tool records from error/empty turns must be durably persisted, and
they must be **invisible to thread GET responses and to history replay** (the
same invisibility discipline `raw_payload` already observes). The persistence
mechanism for record-bearing error turns (an assistant-less record row, a
separate sink, or another design) is a plan question, bounded by the
invisibility requirement and the frozen API contract.

### Storage estimate (full scope: both block types, all three sites, error turns)

Inputs: legacy medians of 144 B per `tool_use` and ~7 KB per `tool_result`;
~1,486 assistant messages/day; the legacy sample's ratio of 1,649 tool calls
per 1,521 assistant text blocks ≈ **1.08 dispatches per assistant turn**;
error/empty turns ~1–3% of turns (production observation).

- Per dispatch: ~144 B + ~7 KB ≈ **~7.1 KB** (status/duration/id metadata adds
  tens of bytes — noise).
- Successful turns: 1,486 × 1.08 × 7.1 KB ≈ **~11.4 MB/day ≈ ~4.2 GB/year**
  raw.
- Error turns add ~1–3% on top: **~0.04–0.13 GB/year** — negligible; their
  inclusion changes the metric, not the storage picture.
- Total: **~4.2–4.4 GB/year raw**, before jsonb TOAST compression (tool
  results are compressible text; 2–4× reduction is typical, so on-disk growth
  plausibly ~1.5–2.5 GB/year).

Against the production volume of 50 GB with 2.58 GB (5%) used: even at the
uncompressed ~4.4 GB/year this is ~9% of the volume per year — **several years
of headroom**, consistent with the issue's own ~4–10 GB/year estimate that the
operator already accepted.

## Success Criteria

- [ ] `tool_calls` is populated for assistant turns that invoked tools, on all
      three persist sites (web chat POST, SSE chat route, mcp-complete); it is
      `NULL` otherwise.
- [ ] **Every completed tool dispatch is durably recorded regardless of turn
      outcome**: a turn that executes tools and then ends in an `error` event,
      an empty final answer, or mcp-complete's empty-answer 502 still persists
      its tool records. The mechanism is a plan decision; the guarantee is
      not.
- [ ] Tool records from error/empty turns are **invisible to thread GET
      responses and to history replay** — the same discipline `raw_payload`
      observes. No API surface changes shape or content because an error
      turn's records exist.
- [ ] Each persisted record captures, per tool call: a correlating id (minted
      at the loop level, since Gemini supplies none), the tool name, the input
      arguments, the result content the model actually received (the full
      `formatToolResultForGemini` output — this is definitive, not optional),
      and per-call duration in milliseconds (`NULL` for calls that never
      executed) — enough to compute usage, reliability, and latency trends.
- [ ] Every tool_result record carries an explicit **status** field with a
      fixed category set — success, degraded, budget-skipped, limit-refused,
      unknown-tool — so provider degradation is never conflated with budget
      cutoffs. The degraded marker is read off the `ToolResult.isDegraded`
      flag (it is NOT present in the model-facing payload, which is only
      `{results, summary}`). Exact field names are a plan detail; the category
      set is fixed here.
- [ ] Tool calls skipped by the budget/degradation short-circuits (T1/T2) and
      tool-limit refusals are still recorded (they are part of the reliability
      picture), distinguishable from successful results via the status field.
- [ ] **Regression test asserting the thread GET response shape is
      byte-identical before and after** — specifically that a message whose
      `content` is a single text block still returns a bare **string**, not an
      array, even when its `tool_calls` column is populated.
- [ ] Real-DB round-trip test (pglite) per `lessons-critical.md` — inserts via
      the actual `createMessage` helper, reads back through the actual query
      helpers; not mocks.
- [ ] Negative test: an assistant turn with no tool calls writes `NULL`, not
      `[]`.
- [ ] Migration `0005` is additive and nullable, generated via `drizzle-kit
      generate`, so old code ignores it and it is safe to apply ahead of
      deploy. NEVER `db:push`.
- [ ] Full existing test suite stays green with only the dummy `.env.ci` env.

## Constraints

Fixed decisions from the issue (operator-decided; treat as settled):

1. **Persist BOTH `tool_use` and `tool_result`.** Storage is not a constraint:
   legacy medians are 144 B per `tool_use` and ~7 KB per `tool_result`, ~4–10
   GB/year raw at current volume (~1,486 assistant messages/day) against a 50 GB
   production volume currently 5% used.
2. **Must NOT go into `content`.** `formatMessageContent`
   (`src/app/api/v2/threads/[id]/route.ts:22-28`) returns a bare string iff
   `content` is exactly one text block; appending tool blocks would silently
   flip the GET response to an array-of-blocks for every message. The mobile API
   contract is frozen and clients in the wild cannot be updated (see memory:
   no-api-changes-mobile-compat). The generated Expo client
   (`prototypes/ansari-expo/vendor/api-client-react/generated/api.schemas.ts`)
   declares no `tool_use`/`tool_result` types at all.
3. **Separate nullable `tool_calls` jsonb column**, migration `0005`, generated
   via `drizzle-kit generate`, human-reviewed, human-applied at deploy — the
   same pattern as `raw_payload` (migration `0004`). Never `db:push`
   (`codev/resources/arch-critical.md`).

Additional technical constraints:

- The `tool_calls` column must never be serialized into any API response —
  today's routes select whole rows, so response construction must remain an
  explicit field-by-field mapping (as it is today), and tests must pin this.
  This covers **both** serializing surfaces: the thread GET
  (`threads/[id]/route.ts`) and the share snapshot
  (`createThreadSnapshot`, `lib/db/shares.ts:36-44`), which also selects whole
  message rows and maps explicitly.
- The persisted tool_result content is the full `formatToolResultForGemini`
  output (documents included, ~7 KB median) — the ground truth of what the
  model saw, matching the legacy storage math the operator already accepted.
- The facilitator's `raw_payload` guard semantics (issue #70) are untouched:
  `raw_payload` still stores only the final model turn; `tool_calls` is the
  new, separate home for tool history. No duplication concern — `raw_payload`
  carries zero functionCall parts by construction.
- The full test suite must run without external services (dummy `.env.ci`).
- New persistence must not add failure modes to the user-facing chat path: a
  turn that used tools and streams fine today must not start erroring because
  of tool-record bookkeeping.

## Assumptions

- Current facilitator in-process data is sufficient for **executed** calls:
  `processToolCall`'s returned `ToolResult` (`content`, `documents`,
  `isDegraded`) plus the call's args capture everything worth persisting.
  Gemini does not supply tool-call ids, so ids must be minted by our code —
  and specifically **at the loop level**, not inside `processToolCall`:
  tool-limit refusals return before the tracker push (`agent.ts:176-197`) and
  T1/T2-skipped calls never reach `processToolCall` at all
  (`agent.ts:748-770`), so the existing `callsWithArgs` tracker alone does NOT
  cover the record set this spec requires. Duration is likewise new
  instrumentation (no timing exists in the loop today) and is `NULL` for
  skipped/refused calls, which never executed.
- Conveyance rides on the `done` event in practice: `onMessage` currently has
  no production callers (routes persist on `done`), so both channels carry the
  array but the `done` event is the one that matters. With error turns in
  scope, the accumulated records must also reach a durable write when the run
  terminates in an `error` event (today that event carries only a message
  string) — how is a plan decision.
- The result payload worth persisting is what the model actually received
  (`formatToolResultForGemini` output), since that is the ground truth for
  reliability/behavior analysis; full `documents` bodies are included in it
  (matching the ~7 KB legacy median the operator already accepted).
- No backfill is possible or expected: the data was never captured. Historical
  analysis continues to use the Mongo export for the legacy era.
- `v1/chat/completions` and other non-persisting surfaces stay non-persisting;
  this spec only enriches sites that already write assistant messages.
- The follow-on Usul email update (real degradation figure) is out of scope
  (issue: "do not implement here").

## Solution Approaches

### Approach 1: Separate `tool_calls` jsonb column, facilitator-accumulated (RECOMMENDED — and partially mandated)

The column itself is a baked decision. The open design surface is how tool data
reaches the persist sites. Recommended: the facilitator accumulates an ordered
array of tool records across all loop iterations of the request and hands the
finished array to callers on the terminal `done` event (and via the `onMessage`
callback), exactly mirroring how `usage` and `rawPayload` already travel.
Routes pass it through to `createMessage` unchanged; `NULL` when the array is
empty.

Record shape: an interleaved array of blocks in the legacy/Claude format —
`{type: 'tool_use', id, name, input}` followed by its
`{type: 'tool_result', tool_use_id, content, ...}` — augmented with the
measurement fields the issue motivates (`is_degraded`, duration, and a marker
for skipped/limit-refused calls). Staying close to the legacy block shape keeps
the published analysis re-runnable with minimal translation; the extra fields
live only in this internal column, so no wire contract constrains them.

- **Pros:** single accumulation point covers every loop path (normal rounds,
  T1/T2 short-circuits, synthesis, retries); persist sites change by one
  passthrough field each; mirrors two proven patterns (`raw_payload` column,
  `done`-event enrichment); impossible to leak into `content`.
- **Cons:** the facilitator function grows another piece of carried state; the
  `done` event gets a third payload field.
- **Risk/complexity:** low. The tricky part is completeness — recording
  skipped/short-circuited calls, which happen outside `processToolCall`.

### Approach 2: Enrich the stream events; routes assemble the records

Make the yielded `tool_use`/`tool_result` events carry full data (id, args,
complete result, timing) and have each route build the array it persists.

- **Pros:** no new `done` payload; routes stay in control.
- **Cons:** three routes duplicate assembly logic and can drift; today's lossy
  events are also *forwarded to clients* by the SSE route, so enriching them
  risks leaking full tool payloads onto the wire unless the event stream is
  split into "wire" and "bookkeeping" variants — exactly the kind of accidental
  serialization the separate-column design exists to prevent; mcp-complete's
  collector would need parallel changes.
- **Risk/complexity:** medium, with a real wire-leak footgun.

### Approach 3: Separate normalized `tool_events` table

One row per tool call (message_id FK, name, args, result, degraded, duration,
timestamps).

- **Pros:** cleanest analytics queries; no jsonb parsing; per-call indexing.
- **Cons:** contradicts the issue's stated design ("suggested `tool_calls`
  jsonb", "mirroring what PR #71 did"); requires two-phase writes or moving
  message persistence into a transaction across tables from inside a streaming
  closure; heavier migration; more code for the same measurement outcomes at
  current scale.
- **Risk/complexity:** medium-high, and relitigates an operator decision.

**Recommendation:** Approach 1. It honors the baked column decision, reuses the
`usage`/`rawPayload` conveyance pattern already proven in this exact loop, and
concentrates correctness (ordering, short-circuit coverage) in one place.

## Open Questions

Resolved during review (promoted out of Open Questions into Success
Criteria/Constraints): result payload fidelity (full
`formatToolResultForGemini` output is definitive) and skipped-call
representation (explicit status field with a fixed category set).

- **Important — error-turn persistence mechanism (plan question):**
  error-path capture is IN scope by operator decision at spec review (see
  Desired State). What remains open is the mechanism for persisting records
  when no ordinary assistant row exists — e.g. an assistant-less record row
  that GET/replay filter out, or a separate sink. Bounded by two fixed
  requirements: durable capture of every completed dispatch, and invisibility
  to thread GET and history replay. The plan decides; the spec does not.
- **Nice-to-know — retention/analytics indexing:** whether a partial index or
  generated columns for common queries (e.g. tool name extraction) is worth it.
  Defer until real queries exist; jsonb scans are fine at current volume.

Nothing here blocks planning: the recommended answers are stated and
consistent with the issue.

## Test Scenarios

1. **Frozen GET contract (the protective test).** Insert via real helpers a
   thread with an assistant message: single text block in `content`,
   `tool_calls` populated. GET the thread through the real route handler.
   Assert `content` in the response is the bare string (`typeof === 'string'`),
   the serialized response contains no `tool_use`/`tool_result`/`tool_calls`
   keys anywhere, and the message object's key set is exactly today's. Repeat
   the leak assertion for the share snapshot surface: `createThreadSnapshot`
   on the same thread produces a snapshot with no tool keys.
2. **pglite round-trip.** `createMessage` with a `tool_calls` array (tool_use +
   tool_result blocks, degraded flags, durations) → read back via
   `findMessagesByThread`/`getThreadWithMessages` → deep-equal.
3. **NULL negative test.** Assistant turn persisted with no tool activity →
   column reads back as `NULL` (not `[]`, not `undefined`-serialized).
4. **Facilitator accumulation — happy path.** Mocked Gemini stream emitting two
   tool calls in one round then a final text turn → the `done` event (and
   `onMessage` payload) carries an ordered array: tool_use₁, tool_result₁,
   tool_use₂, tool_result₂, with args and result content matching what the
   mocked tools returned, ids correlating use↔result pairs.
5. **Degraded result.** A tool returning `isDegraded: true` → its persisted
   tool_result record carries status `degraded` (this is the mawsuah
   denominator/numerator test), while a successful call in the same turn
   carries the success status — proving the flag is read off `ToolResult`,
   not the model-facing payload.
6. **Short-circuit coverage.** A T2 (budget) run where remaining calls are
   skipped → skipped calls appear in the persisted array with the
   skipped/distinguishable marker; a synthesis-path `done` still delivers the
   accumulated records from earlier rounds.
7. **Multi-round loop.** Tool calls across two loop iterations → one flat
   ordered array on the final `done`, not just the last round's.
8. **Route persistence integration — all three sites.** Web chat POST route
   with mocked facilitator emitting tool events + done → row written with
   `tool_calls` populated; same for a no-tool run writing `NULL`. Equivalent
   checks for the SSE `/threads/[id]/chat` route and mcp-complete.
9. **Error-turn capture and invisibility.** A run that executes tools (some
   degraded) and then ends in an `error` event → the tool records are durably
   persisted with their statuses; no ordinary assistant message appears in the
   thread GET response (byte-identical to today's error behavior on the wire);
   history replay for the thread's next turn is unaffected by the error-turn
   records. Same check for the empty-final path and mcp-complete's 502.
10. **Migration shape.** Generated `0005` migration is a single additive
    nullable `ALTER TABLE messages ADD COLUMN tool_calls jsonb` (reviewed by
    eye; asserted structurally in the schema test DDL updates — the pglite test
    DDL in `apps/api/tests/*.test.ts` gains the column so schema and tests
    cannot drift).

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Tool blocks leak into an API response via `content` or row-spread serialization | Low | High (breaks frozen mobile clients) | Separate column (baked); regression test #1 pins bare-string shape and absence of tool keys on both serializing surfaces (thread GET + share snapshot); routes keep explicit field mapping |
| Error-turn record persistence leaks into GET/replay or breaks error semantics | Medium | High (frozen contract; thread replay poisoning) | Invisibility is a hard success criterion with dedicated Test Scenario 9 covering GET shape, replay, and all three error paths |
| Result payloads bloat storage beyond estimate | Low | Low-Med | Issue already priced ~4–10 GB/yr vs 47 GB headroom; jsonb TOAST compresses; monitor volume post-deploy |
| Skipped/short-circuit paths silently unrecorded → denominator undercounts | Medium | Medium (wrong reliability rates again) | Explicit success criterion + tests #6; accumulation lives in the loop, not in `processToolCall` alone |
| New bookkeeping breaks the streaming chat path | Low | High | Accumulation is passive (no awaits added to hot path); full-suite green + route integration tests |
| pglite test DDL drifts from real schema (lesson: issue #70) | Medium | Medium | Update every `CREATE TABLE messages` test DDL in the same change; round-trip via real helpers |
| PII in persisted tool records | Low | Medium | Tool args/results are already model-visible retrieval content, stored same as legacy; no logging of contents (log `{count}` only), consistent with no-user-content-in-logs rule |

## References

- Issue #73 (this spec's source, incl. operator decisions on scope and storage)
- Issue #70 / PR #71 — `raw_payload` column: the pattern this mirrors
  (`codev/reviews/` PIR #70; migration `apps/api/drizzle/0004_ancient_mongu.sql`)
- Issue #72 — mawsuah degradation investigation (the 15x-spread motivation)
- Issue #54 — `isDegraded` machine-readable marker (`lib/tools/resilience.ts`)
- Spec 49 / issues #14, #66 — facilitator loop structure (T1/T2 short-circuits,
  synthesis) that the accumulation must cover
- `codev/resources/arch-critical.md` — migration discipline, raw_payload guard
- Ansari paper tool-usage stats (51.6% / 43.8% / 34.1%) — the unreproducible
  analysis this restores
- `tmp/usul-degradation-email.md` — follow-on consumer of the exact rate
