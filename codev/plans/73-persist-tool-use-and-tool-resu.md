# Plan: Persist tool_use and tool_result

**Specification**: `codev/specs/73-persist-tool-use-and-tool-resu.md`

## Executive Summary

Implements the spec's Approach 1: the facilitator accumulates an ordered array
of tool records across all loop iterations and hands it to callers on the
terminal event, mirroring how `usage` and `rawPayload` already travel; routes
pass it through to persistence. Records for assistant turns land in a new
nullable `messages.tool_calls` jsonb column (baked decision).

**Error-turn mechanism (the spec's open plan question) — separate side table,
not invisible message rows.** Turns that end in `error`/empty persist their
records to a new `tool_call_orphans` table (thread-scoped, jsonb payload,
reason tag). Rationale: invisibility to thread GET, share snapshots, and
history replay is then true **by construction** — no existing query touches
the new table — instead of by filtering added to every current and future
`messages` consumer (thread GET, share snapshot, both chat routes' history
loads, admin stats counts, feedback lookups), where one forgotten filter is a
frozen-contract leak or a skewed metric. The cost is that reliability
analytics union two homes (`messages.tool_calls` + `tool_call_orphans`), which
is a query-side concern only. Invisible-marker message rows were considered
and rejected: they inflate `messages`-based admin stats, require a filter at
every consumer (the quiet-check failure mode `lessons-critical.md` warns
about), and put contract safety behind convention rather than structure.

**PR #76 coherence:** `ToolFetchError.attempts` (2 on a retried timeout) and
`errorClass` currently reach only Sentry via `reportDegradedTool` and are
discarded before the `ToolResult`. The plan extends `ToolResult` with an
optional degradation-detail field so persisted `tool_result` records carry
`attempts`/`error_class`, keeping the new data coherent with #76's retry
semantics.

Record shape (internal column, no wire contract): interleaved
`{type:'tool_use', id, name, input}` /
`{type:'tool_result', tool_use_id, content, status, duration_ms, error_class?,
attempts?, skip_trigger?}` blocks; `status ∈ ok | degraded | budget_skipped |
limit_refused | unknown_tool`; `content` is the full
`formatToolResultForGemini` output; `duration_ms` is `null` for never-executed
calls; ids minted at loop level. `error_class`/`attempts` are optional even on
degraded results (non-`ToolFetchError` degrades and the agent backstop carry
no detail); `skip_trigger: 'T1' | 'T2'` on budget-skipped records preserves
the provider-down vs. out-of-time distinction at zero cost.

**Read-path projection (structural contract safety + hot-path cost):**
`findMessagesByThread`, `getThreadWithMessages`, and `createThreadSnapshot`
currently `select()` whole rows and run on every chat turn / snapshot; without
a change they would detoast ~7 KB median (up to ~70 KB) of `tool_calls` jsonb
per assistant row only to discard it. They switch to explicit column
projection that **omits `tool_calls`** (keeping `raw_payload` in
`findMessagesByThread` — history replay needs it). This also upgrades the
frozen-contract guarantee from ".map() discipline" to "the column is never
selected on any serializing path" — structural, complementing the regression
tests.

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "Schema, migration 0005, and DB helpers"},
    {"id": "phase_2", "title": "Facilitator tool-record accumulation"},
    {"id": "phase_3", "title": "Route persistence and frozen-contract regression tests"}
  ]
}
```

## Phase Breakdown

### Phase 1: Schema, migration 0005, and DB helpers

**Dependencies**: None

#### Objective

The durable storage exists and round-trips: `messages.tool_calls` column, the
`tool_call_orphans` table, typed record shapes, DB helpers, and the additive
migration — with real-DB (pglite) proof.

#### Files to Create / Modify

- `apps/api/db/schema/messages.ts` — add `toolCalls: jsonb('tool_calls')`
  (nullable, `$type<ToolCallRecord[]>`); define and export the
  `ToolCallRecord` union (`tool_use` / `tool_result` blocks with `status`,
  `duration_ms`, `error_class?`, `attempts?`) and the status constants.
- `apps/api/db/schema/tool-call-orphans.ts` (new) — `tool_call_orphans`:
  `id` uuid PK default random, `threadId` uuid FK → threads cascade NOT NULL,
  `reason` text NOT NULL (`'error' | 'empty_final'`), `source` text,
  `client` text, `toolCalls` jsonb NOT NULL `$type<ToolCallRecord[]>`,
  `createdAt` timestamptz defaultNow; index on `(threadId, createdAt)`.
- `apps/api/db/schema/index.ts` — export the new table.
- `apps/api/drizzle/0005_*.sql` — generated via `pnpm db:generate`
  (drizzle-kit generate), reviewed by eye: one additive nullable
  `ALTER TABLE messages ADD COLUMN tool_calls jsonb` + `CREATE TABLE
  tool_call_orphans …`. NEVER `db:push`.
- `apps/api/lib/db/threads.ts` — `createToolCallOrphan(data, exec = db)`
  helper taking the `exec` executor param like `createMessage`, but — unlike
  `createMessage` — it must **NOT** update `threads.updatedAt`: an orphan
  write is bookkeeping for a failed turn and must be invisible in thread
  metadata too (a bumped `updated_at` would change the thread GET response
  after a failed turn). `createMessage` itself needs no signature change
  (`NewMessage` picks up the column). Read-path projection: change
  `findMessagesByThread` and `getThreadWithMessages` to explicit column lists
  omitting `tool_calls` (keeping `raw_payload` — replay needs it).
- `apps/api/lib/db/shares.ts` — `createThreadSnapshot`'s message select gets
  the same explicit projection (it only uses role/content/createdAt).
- pglite test DDL updates — every `CREATE TABLE messages` block gains
  `tool_calls jsonb`: `apps/api/tests/attribution-schema.test.ts`,
  `executor-threads-feedback.test.ts`, `feedback-idor.test.ts`,
  `rawpayload-persistence.test.ts`, `route-persistence-rollback.test.ts`
  (and any other hit of a fresh grep, so schema and tests cannot drift).
- `apps/api/tests/toolcalls-persistence.test.ts` (new) — pglite round-trip
  suite.

#### Deliverables

- [ ] Schema changes + generated migration 0005 (additive, nullable only)
- [ ] `ToolCallRecord` types exported from the schema module
- [ ] `createToolCallOrphan` helper with `exec` param
- [ ] All pglite test DDL blocks updated in the same commit
- [ ] Tests for this phase

#### Acceptance Criteria

- [ ] Migration file contains exactly the additive column + new table (no
      drops, no alters of existing columns).
- [ ] pglite round-trip: `createMessage` with a populated `toolCalls` array →
      read back via a direct `db.select().from(messages)` (the analytics-side
      read; the app-facing helpers deliberately project the column OUT in
      this same phase) → deep-equal (spec Test Scenario 2).
- [ ] Projection test: `findMessagesByThread` / `getThreadWithMessages` /
      `createThreadSnapshot` results contain NO `toolCalls` key even when the
      column is populated, and `findMessagesByThread` still returns
      `rawPayload`.
- [ ] Negative test: `createMessage` without `toolCalls` reads back `NULL`,
      not `[]` (spec Test Scenario 3).
- [ ] `createToolCallOrphan` does NOT change `threads.updated_at` (asserted
      against a real pglite thread row).
- [ ] Orphan round-trip: `createToolCallOrphan` → select → deep-equal,
      including `reason`; thread delete cascades the orphan rows.
- [ ] `pnpm typecheck` and full `pnpm test` green.

#### Test Plan

pglite (real DB, no mocks) round-trips as above, driven through the actual
helpers; grep-verified DDL coverage (the fresh-grep hit list is recorded in
the test file header so a reviewer can re-run it).

### Phase 2: Facilitator tool-record accumulation

**Dependencies**: Phase 1

#### Objective

`runFacilitator` produces a complete, ordered `toolCalls` array covering every
dispatch path — executed (ok/degraded), budget-skipped, limit-refused,
unknown-tool — and delivers it on **both** terminal event kinds (`done` and
`error`), with #76-coherent degradation detail.

#### Files to Create / Modify

- `apps/api/lib/tools/types.ts` — `ToolResult` gains optional
  `degradation?: { errorClass?: ToolFetchErrorClass; attempts?: number;
  status?: number }` (populated only when `isDegraded`; every field optional —
  a non-`ToolFetchError` degrade and the agent backstop carry partial or no
  detail). Reference `ToolFetchErrorClass` via `import type` from
  `./resilience` — resilience already type-imports `ToolResult` from
  `./types`, and a type-only cycle is erased at runtime (no runtime circular
  dependency is introduced).
- `apps/api/lib/tools/resilience.ts` — `unavailableResult` accepts optional
  degradation detail and attaches it.
- `apps/api/lib/tools/search-quran.ts`, `search-hadith.ts`,
  `search-mawsuah.ts`, `search-tafsir.ts` — pass the already-constructed
  `{status, attempts, errorClass}` (currently Sentry-only) into
  `unavailableResult`.
- `apps/api/lib/facilitator/agent.ts` —
  - `processToolCall` returns `{ result, outcome }` where
    `outcome ∈ 'ok' | 'limit_refused' | 'unknown_tool' | 'backstop_error'`
    (no string-matching on `content`, per the #54 lesson);
  - loop-level accumulator `toolCallRecords: ToolCallRecord[]`: mints the id,
    records `tool_use` before dispatch, times execution
    (`duration_ms`, `null` when never executed), and records `tool_result`
    with status derived from outcome + `isDegraded` + short-circuit state;
    T1/T2-skipped calls are recorded at the skip site with
    `skip_trigger: 'T1' | 'T2'` from the existing `shortCircuitTrigger`;
  - `FacilitatorStreamEvent` gains `toolCalls?: ToolCallRecord[]`, attached to
    every terminal yield: both `done` yields (normal + synthesis), every
    terminal `error` yield (degenerate-final fail, synthesis failure,
    catch-all, max-iterations), and passed through `onMessage`;
  - the wire-facing `tool_use`/`tool_result` stream events are UNCHANGED
    (lossy `{name}` / `{tool, query, resultCount}`) — no new data crosses the
    SSE surface.
- `apps/api/tests/facilitator-toolcalls.test.ts` (new).

#### Deliverables

- [ ] `ToolResult.degradation` populated by all four tools on degrade
- [ ] Outcome-tagged `processToolCall`, loop-level accumulator, id minting,
      timing
- [ ] `toolCalls` on every terminal event + `onMessage`
- [ ] Tests for this phase

#### Acceptance Criteria

- [ ] Happy path: two calls in one round → ordered use₁,result₁,use₂,result₂
      with correlating ids, args, full `formatToolResultForGemini` content
      (spec Scenario 4).
- [ ] Degraded call carries `status: 'degraded'`, and — when the underlying
      failure was a `ToolFetchError` — its `error_class`, with `attempts: 2`
      for a retried timeout (#76 coherence); a degrade with no
      `ToolFetchError` detail (e.g. the agent backstop) still carries
      `status: 'degraded'` with the detail fields absent; a sibling ok call
      carries `status: 'ok'` (spec Scenario 5).
- [ ] T2 short-circuit: skipped calls recorded with `status:
      'budget_skipped'`, `skip_trigger: 'T2'`, `duration_ms: null`; a T1 run
      records `skip_trigger: 'T1'`; synthesis `done` still carries the
      earlier rounds' records (spec Scenario 6).
- [ ] Limit-refused and unknown-tool calls recorded with their statuses.
- [ ] Multi-round loop → one flat ordered array (spec Scenario 7).
- [ ] Terminal `error` yields carry the accumulated records.
- [ ] No-tool run → `toolCalls` absent/empty on `done` (routes will map to
      NULL).
- [ ] Full suite green.

#### Test Plan

Unit tests with mocked Gemini streams (existing facilitator test harness
patterns: `facilitator-t1`, `facilitator-budget`, `facilitator-continuation`)
asserting the accumulated array per path; a resilience-level test that a
retried-timeout degrade yields `degradation.attempts === 2` end-to-end into
the record.

### Phase 3: Route persistence and frozen-contract regression tests

**Dependencies**: Phase 1, Phase 2

#### Objective

All three persist sites write `tool_calls` (NULL when unused); error/empty
turns write `tool_call_orphans`; and the frozen API contract is pinned
byte-identical by regression tests on both serializing surfaces.

#### Files to Create / Modify

- `apps/api/src/app/api/v2/threads/[id]/route.ts` — `done`: pass
  `toolCalls`(non-empty → array, else null) to `createMessage`; empty-final
  branch and `error` event: `createToolCallOrphan` with reason
  `empty_final`/`error` when records exist. On streaming error paths the
  orphan write happens **after** `safeClose()` — bookkeeping must never delay
  the client's error delivery.
- `apps/api/src/app/api/v2/threads/[id]/chat/route.ts` — same wiring, same
  after-`safeClose()` ordering.
- `apps/api/src/app/api/v2/mcp-complete/route.ts` —
  `collectFacilitatorResponse` returns `toolCalls` and exposes records on the
  error path (return-based, not throw-losing); assistant persist passes
  `toolCalls`; the empty-answer 502 and facilitator-error paths write an
  orphan row before returning.
- `apps/api/tests/toolcalls-routes.test.ts` (new) — route integration tests
  (mocked facilitator, real pglite persistence per existing
  `route-persistence-rollback` pattern).
- `apps/api/tests/thread-get-contract.test.ts` (new or extend existing GET
  tests) — frozen-contract regression.

#### Deliverables

- [ ] Three routes wired for `tool_calls` + orphan writes on error/empty
- [ ] Frozen-contract regression tests (thread GET + share snapshot)
- [ ] Tests for this phase

#### Acceptance Criteria

- [ ] Thread GET regression: message with single text block + populated
      `tool_calls` → response `content` is a bare string
      (`typeof === 'string'`); serialized response contains no
      `tool_use`/`tool_result`/`tool_calls` keys; message key set exactly
      today's (spec Scenario 1).
- [ ] Share snapshot: `createThreadSnapshot` on the same thread → no tool
      keys anywhere in the snapshot (spec Scenario 1).
- [ ] Web POST, SSE chat, and mcp-complete each: tool run → row with
      populated `tool_calls`; no-tool run → `NULL` (spec Scenarios 3, 8).
- [ ] Error-turn capture: facilitator `error` after executed tools → orphan
      row with records and reason `error`; no assistant message row; thread
      GET response — **including `updated_at`** — and next-turn history
      replay unchanged. Same for empty-final and mcp-complete 502 (spec
      Scenario 9).
- [ ] mcp-complete error contract unchanged: a facilitator `error` event
      still produces the same status code and body as today (currently a 500
      via the route's catch) after the throw→return refactor of
      `collectFacilitatorResponse` — pinned by extending the existing
      mcp-complete tests.
- [ ] SSE wire output byte-identical for a given mocked event sequence
      (heartbeats and event JSON unchanged).
- [ ] Full suite green with only `.env.ci`.

#### Test Plan

Integration tests through the real route handlers against pglite; contract
tests assert on the serialized JSON string (key enumeration + typeof), not on
parsed convenience views; replay test drives a second turn and asserts the
Gemini history builder receives the same inputs as before the change.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| A `messages` consumer is missed and orphan data leaks | Low | High | Orphans live in a table no existing query reads — leak requires new code, not a missed filter; contract tests on both serializing surfaces |
| Terminal-yield coverage gaps (an `error` path forgets `toolCalls`) | Medium | Medium (silent undercount again) | Phase 2 enumerates every terminal yield; dedicated test per path (degenerate-final, synthesis, catch-all, max-iterations) |
| Outcome tagging drifts from `processToolCall` internals | Low | Medium | Tagging is return-typed (compiler-enforced), not string-matched |
| Orphan writes add a failure mode to error handling (write throws inside catch) | Medium | Medium | Orphan write wrapped so a DB failure logs `{name, code}` and never masks the original stream error path |
| drizzle-kit generates unexpected SQL for the two-object migration | Low | Medium | Human review of 0005 before commit; acceptance criterion pins additive-only content |
| pglite DDL drift (issue #70 lesson) | Medium | Medium | Fresh grep for `CREATE TABLE messages` at Phase 1 time; hit list recorded in the test file |

## Documentation Updates

- `codev/resources/arch.md` (Gemini facilitator & message history section):
  document `tool_calls` column semantics, the record/status taxonomy, and the
  `tool_call_orphans` table + invisibility rationale (done in review phase via
  the normal arch-doc flow).
- No env vars, no `turbo.json`, no deploy-config changes. Migration 0005 noted
  for the human-applied deploy step (migration → deploy order per
  arch-critical).
