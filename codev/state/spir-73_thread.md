# spir-73 thread — persist tool_use and tool_result

## 2026-08-30 — Specify phase

Spawned in strict mode. No pre-existing spec; drafted
`codev/specs/73-persist-tool-use-and-tool-resu.md` from issue #73 after code
exploration.

Key findings that shaped the spec:

- Three persist sites write assistant messages: `v2/threads/[id]` POST (web),
  `v2/threads/[id]/chat` (SSE), `v2/mcp-complete` (ai-skill). All included in
  scope; `v1/chat/completions` doesn't persist and stays out.
- Facilitator already has all the data in-process: `tracker.callsWithArgs`
  ({tool, args, generated id}) and `processToolCall`'s full `ToolResult`
  (content, documents, `isDegraded`). The streamed events are deliberately
  lossy ({name} / {tool, query, resultCount}) and the SSE route forwards them
  to clients — so enriching events would risk a wire leak. Recommended design:
  accumulate records in the loop and deliver on the `done` event + `onMessage`,
  mirroring how `usage`/`rawPayload` already travel.
- Completeness trap identified: T1/T2 short-circuit skipped calls and
  tool-limit refusals never reach `processToolCall`'s tracker push — they must
  be recorded at the loop level or the denominator undercounts (the exact bug
  class this issue exists to fix). Spec makes distinguishable recording of
  those a success criterion.
- Issue's "Required design" treated as baked (separate nullable `tool_calls`
  jsonb column, migration 0005 via drizzle-kit generate, NOT in `content`).
  No contradictions found.
- pglite test DDL (`CREATE TABLE messages` in ~5 test files) must gain the
  column in the same change — lesson from issue #70.

3-way consultation: gemini APPROVE; claude + codex REQUEST_CHANGES. All
points verified against code and accepted (no contest): error-path turns
persist no assistant row so the degradation rate is a floor over persisted
turns (now stated explicitly, error-path capture flagged as architect
follow-on); ids must be minted at loop level (tracker misses limit-refusals
and T1/T2 skips); status taxonomy (success/degraded/budget-skipped/
limit-refused/unknown-tool) promoted to success criterion; duration is new
instrumentation, ms, NULL for never-executed calls; share snapshot
(`lib/db/shares.ts`) added as second leak-test surface; SSE route added to
integration tests. Rebuttal at
`codev/projects/73-persist-tool-use-and-tool-resu/73-specify-iter1-rebuttals.md`.

Spec-review feedback from Waleed (via architect): (1) error turns are IN
scope — every completed tool dispatch must be recorded regardless of turn
outcome, invisible to GET/replay (mechanism left to the plan); (2) storage
estimate added (~4.2–4.4 GB/yr raw, ~1.5–2.5 GB/yr after TOAST, vs 47 GB
headroom). Spec updated accordingly.

Spec approved (Waleed via architect). Merged develop (PR #76 timeout retry)
into branch before planning.

## 2026-08-30 — Plan phase

Plan drafted: 3 phases (schema/migration/helpers → facilitator accumulation →
route wiring + contract tests). Big design choice: error-turn records go to a
separate `tool_call_orphans` table, NOT invisible message rows — invisibility
by construction (no existing query reads it), avoids filters in 5+ messages
consumers and admin-stats skew. PR #76 coherence: ToolResult gains optional
`degradation` ({errorClass?, attempts?, status?}) so persisted records carry
attempts=2 on retried timeouts (today that detail dies at reportDegradedTool).

3-way plan review: gemini APPROVE, claude+codex COMMENT. All folded in:
read-path projection omitting tool_calls (findMessagesByThread /
getThreadWithMessages / createThreadSnapshot — structural contract safety,
avoids ~7KB/row detoast per turn; raw_payload kept for replay);
createToolCallOrphan must NOT bump threads.updatedAt (createMessage does —
verified); mcp-complete facilitator-error 500 contract pinned across the
throw→return refactor; skip_trigger T1/T2 field; degradation fields optional
even when degraded; orphan writes after safeClose(); ToolFetchErrorClass via
type-only import (resilience already type-imports types.ts).

Plan approved (Waleed via architect, 2026-08-31). Coordination note: PR #88
took journal idx 5 / file 0006 — my migration is idx 6, named 0007_*.

## 2026-08-31 — Implement Phase 1 (schema, migration, helpers)

Done: messages.tool_calls + ToolCallRecord types/status taxonomy;
tool_call_orphans table; createToolCallOrphan (no updatedAt bump);
read-path projections (findMessagesByThread/getThreadWithMessages via a
shared column map; createThreadSnapshot selects only role/content/createdAt);
5 test DDLs updated; toolcalls-persistence.test.ts (8 tests).

Merged develop (PR #88) BEFORE generating the migration. drizzle-kit produced
`0006_tool_calls_persistence` (idx 6) — renamed file + journal tag to
`0007_tool_calls_persistence`; snapshot stays `0006_snapshot.json` (snapshots
are idx-named). SQL reviewed: additive only.

Surprise worth knowing: PR #88's new `feedback-upsert.test.ts` carried its own
messages DDL without tool_calls — post-merge, `findMessageInOwnedThread`'s
whole-row select failed with unknown column → 11 tests 500'd. Fixed by adding
the column (now 6 DDL sites). Re-grep DDL sites AFTER every develop merge, not
just once — the issue #70 lesson has a merge-timing corollary.

Full suite: 70 files / 667 pass / 3 pre-existing skips; typecheck clean.

Phase 1 review: 3x APPROVE. Claude's minor notes: (a) migration file prefix
0007 sits one ahead of journal idx 6, so the NEXT `drizzle-kit generate` will
emit another `0007_*.sql` — whoever writes migration idx 7 should name it
0008_* (handoff note for the review doc); (b) single-message lookups
(findMessageById / findMessageInOwnedThread) still select whole rows — they
feed feedback ownership checks, not serialization; comment tightened.

## 2026-08-31 — Implement Phase 2 (facilitator accumulation)

Done: ToolResult.degradation + unavailableResult(label, detail) + 4 tools
pass their existing meta; processToolCall → {result, outcome} with the id
minted by the loop; loop-level accumulator covers executed / T1 / T2 /
limit-refused / unknown-tool; toolCalls on every terminal yield (done x2,
error x5) and via onMessage; wire events unchanged. 16 new tests.

Gotcha: the catch-all error path calls isInklingConfigured(), which reads
validated config — in a facilitator unit test without env that throws inside
the catch block. Mock `@/lib/ai/inkling-client` (as facilitator-inkling-rung
does) whenever a test drives the terminal-error path.

Full suite: 71 files / 683 pass / 3 skips; typecheck clean.

Phase 2 review: gemini APPROVE; claude + codex REQUEST_CHANGES on the same two
test gaps — (1) ToolResult.degradation never asserted through a real tool
(only via mocked unavailableResult), (2) degenerate-final and max-iterations
error paths untested. Both fixed: usul-retry + kalemat-resilience now assert
`degradation` end-to-end from real ToolFetchErrors (all four tools, timeout
attempts=2 and http_5xx shapes); facilitator-toolcalls gains the two terminal
paths (6/6 covered). Also made tool ids structurally unique (per-request seq).
Second harness gotcha: the degenerate-final path lazily reads
config.gemini.model → mock `@/lib/config` too. 71 files / 685 pass.

Phase 2 iter 2: 3x APPROVE (added the degenerate-synthesis error-yield test
Claude noted as the one uncovered sibling).

## 2026-08-31 — Implement Phase 3 (routes + frozen-contract tests)

Done: `persistOrphanToolCalls` wrapper in lib/db/threads (no-op without
records, never throws, logs {name, code} only); web POST + SSE chat routes
pass `toolCalls ?? null` to createMessage on done and write orphans AFTER
safeClose() on error / empty-final; mcp-complete's collector returns the
error instead of throwing (records survive), handler persists the orphan then
re-throws so the 500 contract is byte-identical; 502 path writes empty_final.
Tests: toolcalls-routes (14: all three sites × tool/no-tool/error/empty,
replay unaffected, SSE wire bytes identical, mcp 500 body pinned) and
thread-get-contract (4: bare-string content + exact key sets on serialized
JSON, multi-block array branch unchanged, orphan invisibility byte-for-byte,
share snapshot key sets).

Gotcha: four existing route tests factory-mock `@/lib/db/threads` without
the new export; vitest throws on the missing export INSIDE the stream's
try/catch, which swallows it — the suite stayed green while masking a
TypeError. Added `persistOrphanToolCalls: vi.fn()` to each. Lesson: when
adding an export a route calls on an error path, grep every factory mock of
that module — a green suite is not evidence the path ran cleanly.

Phase 3 review iter 1: gemini + claude APPROVE, codex REQUEST_CHANGES —
`toolCalls ?? null` would persist `[]` if a terminal event ever carried an
empty array (contract says "absent/empty"). Fixed with `toolCallsOrNull()`
in db/schema/messages (pure helper → no mock churn), empty-array regression
cases at all three sites. Also took Claude's non-blocking: Sentry warning on
orphan-write failure. Claude's other note (post-close async DB work on the
streaming routes relies on the runtime keeping the request context alive —
true on Railway's Node runtime) is documented in the rebuttal for the review
doc. 73 files / 708 pass.

Phase 3 iter 2: 3x APPROVE. All three plan phases complete; opening the PR
against develop.
