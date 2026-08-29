# Iteration-1 consultation rebuttals — PIR #70

Verdicts: gemini APPROVE, codex REQUEST_CHANGES, claude REQUEST_CHANGES.

## Claude — REQUEST_CHANGES

### 1. Persisted payload is the last streamed chunk, not the full turn (BLOCKING)

**Accepted — real defect, fixed in code.** Verified: streamed chunks are deltas,
`finalContent = candidate.content` is last-chunk-wins, and `streamRawPayload` returns it
whenever no functionCall was dropped — always true for a final answer turn. A multi-chunk
answer would therefore have persisted only its final text delta, and turn 2+ would have
replayed a fragment (worse than the text-only fallback).

Fix (commit "Persist the complete turn (allParts)…"): `GeminiResponse` now exposes
`allParts` — every part of every chunk in exact arrival order, signatures attached to
their original part objects (`parseResponse` and inkling-client populate it too). The
facilitator's `buildPersistablePayload` constructs the persisted Content from `allParts`,
NOT `rawPayload`. **In-request `rawPayload` semantics are byte-identical to before** (the
#83 identity-return is untouched — pinned by the existing `gemini-rawpayload.test.ts`
identity assertions, which still pass), so no live in-request Vertex behavior changes; the
only shape change is on the new persist path, which the dev-approval live checks already
validated for signature-bearing model turns. Regression tests added:
`gemini-rawpayload.test.ts` ("allParts carries the COMPLETE multi-chunk turn while
rawPayload stays last-chunk") and `facilitator-rawpayload-guard.test.ts` ("persists the
COMPLETE multi-chunk turn, not the last-chunk rawPayload fragment") — the latter fails
against the pre-fix code.

### 2. Thought-summary text can be persisted (policy violation)

**Accepted — fixed.** `buildPersistablePayload` filters `thought === true` parts before
persisting, enforcing the policy stated in `inkling-client.ts` ("reasoning_content …
must never be persisted"). With `includeThoughts: false` such parts should not arrive at
all; the filter is the enforcement. If a filtered-out part carried a signature it is
dropped with the part — a deliberate trade (policy over signature) for a case the config
prevents. Test: "never persists thought parts".

### 3. Desync tripwire has no fires-on-mismatch test

**Rebutted, with the reviewer's offered alternative taken.** Post-fix the mismatch is
structurally unreachable through the public API: `toolCalls` gains exactly one entry per
`functionCall` part processed, `finalContent`'s parts are a subset of processed parts, and
`streamRawPayload` returns either `finalContent` (only when its call count ≤ `allParts`'
count, which processing makes equal) or `allParts` itself — both sides derive from the
same part stream. The tripwire exists precisely for *unknown* paths (SDK behavior changes,
future edits reintroducing an early exit). The load-bearing check that protects the DB —
`buildPersistablePayload`'s orphan-functionCall guard — HAS a fires-test ("guard: nulls a
final payload carrying functionCall parts"). Documented in the review file's "Things to
Look At" as the reviewer suggested.

### 4. No realistic multi-chunk fixture end-to-end

**Accepted — covered by the fix's tests** (multi-chunk fixtures now exist at both the
gemini-client and facilitator layers; the pglite round-trip persists a two-part payload
with a signature).

### Minor: empty-parts payload

**Accepted** — `buildPersistablePayload` returns null when no parts remain after
filtering ("persists null when nothing remains" test).

## Codex — REQUEST_CHANGES

### 1. Tripwire fires-on-mismatch test missing

Same as Claude #3 — structurally unreachable post-fix; rebutted and documented; the
persist-path guard (the check with teeth) has a positive test.

### 2. Repetition-cut regression covers streamGemini only

**Accepted — fixed.** Added the mirrored regression on `continueWithToolResult`
(`gemini-repetition.test.ts`: "keeps the same invariant on the continueWithToolResult
path"). The multi-chunk invariant on the #83 scenarios is asserted by the existing
`gemini-rawpayload.test.ts` cases (calls present in payload on both paths) plus the new
allParts test.

### 3. "16 new tests" count wrong

**Accepted — corrected.** The review file now reports the recount: **15 new tests**
(2 repetition, 1 rawpayload/allParts, 7 facilitator guard/replay, 5 pglite persistence);
suite total 638 passed / 3 pre-existing skips. (The earlier "16" figure was relayed from
the gate review before the iteration-1 additions; recounted from the diff.)

## Gemini — APPROVE

No issues raised.
