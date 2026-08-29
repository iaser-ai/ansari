# PIR Review: Gemini history fidelity — repetition-cut desync fix + rawPayload persistence

Fixes #70

## Summary

Two history-fidelity fixes for the Gemini facilitator. **Bug 1**: the issue #51 repetition
guard's mid-chunk `break` could skip `functionCall` parts out of `toolCalls` while the
stored payload kept them, desyncing `functionCall`/`functionResponse` counts — the guard
now stops text *emission* only and always completes part processing, with a Sentry
tripwire on any residual divergence. **Bug 2**: `rawPayload` — the final model turn's
Content with thought signatures — was designed to be persisted but had nowhere to land;
this adds a nullable `messages.raw_payload` jsonb column, carries the payload on the
facilitator's `done` event behind a consistency guard, and persists/replays it in both
stateful thread routes, so turn 2+ rebuilds real history instead of a text-only fallback
(measured: 65.9% of questions are follow-ups, so this affected roughly two-thirds of
traffic).

**Scope framing (important):** Bug 1 is a **latent** defect. It does NOT change the
production Vertex-400 rate — production runs pre-#14 `main`, which malformes every
parallel tool round by construction (one single-part Content per call); that is fixed by
the develop→main promotion, not this PR. Success for Bug 1 is the new desync
instrumentation staying **silent**. See the correction comment on #70.

## Files Changed

- `apps/api/db/schema/messages.ts` (+7 / -0) — nullable `rawPayload` jsonb column
- `apps/api/drizzle/0004_ancient_mongu.sql` (+1 / -0) — the single `ALTER TABLE`
- `apps/api/drizzle/meta/*` (+684 / -0) — generated snapshot/journal
- `apps/api/lib/ai/gemini-client.ts` (+30 / -12 net 35/-12) — repetition-cut fix; desync tripwire; `payloadCallCount` in the cut summary
- `apps/api/lib/facilitator/agent.ts` (+40 / -4) — `done` event `rawPayload`; `guardFinalRawPayload`
- `apps/api/src/app/api/v2/threads/[id]/route.ts` (+6 / -2), `.../chat/route.ts` (+6 / -2) — persist + read back
- `apps/api/tests/gemini-repetition.test.ts` (+68) — regression: tripping chunk carrying functionCalls keeps counts equal
- `apps/api/tests/facilitator-rawpayload-guard.test.ts` (+230, new) — done-event hand-off, guard both directions, verbatim history replay
- `apps/api/tests/rawpayload-persistence.test.ts` (+227, new) — pglite round-trip through the real route handler
- `apps/api/tests/{route-persistence-rollback,executor-threads-feedback,attribution-schema,feedback-idor}.test.ts` (+1 each) — `raw_payload jsonb` added to hand-written DDL
- `codev/plans/70-…`, `codev/state/pir-70_thread.md`, this review — protocol artifacts

## Commits

- `7e86836` [PIR #70] Fix repetition-cut break orphaning functionCall parts; add desync tripwire
- `618c9b4` [PIR #70] Carry guarded rawPayload on the facilitator done event
- `daca340` [PIR #70] Add nullable messages.raw_payload jsonb column + migration 0004
- `0e12ca2` [PIR #70] Persist and replay rawPayload in the stateful thread routes
- `f18d79e` [PIR #70] Plan: prod migration lock_timeout runbook + follow-up traffic stats
- `a0789a2` [PIR #70] Plan: reframe Bug 1 as latent (prod 400s are pre-#14 main, per issue correction)
- `85a7984` [PIR #70] Tests: repetition-cut desync regression, rawPayload guard, pglite round-trip; add raw_payload to test DDLs
- `975b845` [PIR #70] Thread log: implement phase

## Test Results

- `pnpm build`: ✓ pass
- `pnpm typecheck`: ✓ pass
- `pnpm test`: ✓ pass — 68 files, 633 passed, 3 pre-existing skips; 16 new tests
- Manual verification (dev-approval gate, Waleed): suite re-run from a clean shell
  matched; all 16 new tests confirmed executing; **live Vertex checks** — a real
  final-turn rawPayload with a `thoughtSignature` replays as turn-2 history at HTTP 200
  (with tools declared, without tools, and after a jsonb round-trip), and the two history
  shapes reproduce as diagnosed (N single-part Contents → the production 400; one
  N-part Content → 200).

## Deploy Notes

Apply migration 0004 to production **by hand** (never `db:push`), before or with the
deploy (old code ignores the column). `messages` is ~680K rows; the ADD COLUMN is
catalog-only but wrap it so lock acquisition fails fast instead of queueing:

```sql
SET lock_timeout = '3s';
ALTER TABLE "messages" ADD COLUMN "raw_payload" jsonb;
```

If it times out, re-run once the blocking transaction finishes.

## Architecture Updates

Routed to both tiers this commit:

- **COLD** `codev/resources/arch.md`: new top-level section **"Gemini facilitator &
  message history"** — the Vertex functionCall/functionResponse parity contract, the
  final-turn-only rawPayload persistence design with its consistency guard, and the
  replay/fallback path.
- **HOT** `codev/resources/arch-critical.md`: one new fact (Vertex parity contract +
  final-turn-only `raw_payload` rule) — file is now at its 10-fact cap — and a map entry
  for the new cold section.

## Lessons Learned Updates

- **COLD** `codev/resources/lessons-learned.md`: new section **"Gemini history fidelity
  (issue #70)"** — validate invariants at persist time when the record replays forever;
  stop emitting, don't stop processing; hand-written test DDL is a schema copy that
  drifts.
- **HOT** `codev/resources/lessons-critical.md`: one new lesson — confirm which revision
  production actually runs before attributing a production symptom to the code you are
  reading (this issue's original diagnosis attributed `main`'s 400s to a `develop`-only
  code path; the real cause was pre-#14 code 317 commits behind).

## Things to Look At During PR Review

- **`guardFinalRawPayload` nulls instead of throwing** (`agent.ts`). Deliberate: a
  desynced final payload degrades that one message to today's text-only replay with a
  loud Sentry error, rather than failing the user's turn or poisoning the thread
  (a persisted orphan `functionCall` would 400 every later turn). Flagging because
  "fail fast, no fallbacks" is house policy — this is a guarded degradation with the
  failure surfaced, not a silent fallback.
- **Replay semantics change on turn 2+**: with a stored payload, the replayed model turn
  is the final call's parts (signatures intact) rather than the aggregate streamed text —
  preamble text from earlier tool iterations stays in the user-visible `content` but not
  in the replayed turn. This is the original design's intent; the persisted `content`
  column is byte-identical to before.
- **What is deliberately NOT stored**: intermediate tool-call rounds (tool args embed
  user query text; tool results embed retrieved documents). Bounded size, smaller
  signature-validation surface. If final-turn-only replay proves insufficient, storing
  the full round is a follow-up design.
- No API contract changes: SSE wire format, thread GET response, and mobile-facing
  shapes are untouched; the new column is additive.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder pir-70 → **Review Diff**
- **Run dev**: VSCode sidebar → **Run Dev**, or `afx dev pir-70` (apply migration 0004
  to the local dev DB first: `pnpm db:migrate` in `apps/api`)
- **What to verify**: ask a tool-triggering question, then a follow-up in the same
  thread; `select raw_payload from messages where role = 'assistant'` is populated; the
  follow-up answers with awareness of the earlier search and no Vertex 400; logs show no
  `desync` warning.
