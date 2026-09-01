# PIR Review: Render the streamed answer incrementally (ansari-expo prototype)

Fixes #65

## Summary

**Problem.** `apps/api` streams the chat answer token-by-token over SSE, but #63 deliberately
shipped the prototype as **buffer-until-done**: it collected every `{type:"text"}` frame and only
painted the answer after `{type:"done"}`, so the reader watched a 10–30 s spinner and then the
whole answer popped in. That was accepted for #63 only on the condition it be documented as a
prototype limitation — it teaches frontend devs the wrong thing about a backend that streams.

**Fix (RENDER only, client-side).** The transport (`lib/api/streaming.ts` reader/parser from #63)
was reused untouched; this issue adds the missing screen surface. Each `{type:"text"}` delta is now
appended to an in-progress assistant bubble (the same `AnswerMessage` component a persisted answer
uses) as it arrives; on `done` the bubble hands off **in place** to the refetched persisted message
so the final answer carries the server's ids/timestamps/citations with no flicker; on error the
partial text stays on screen. While the model searches, a transient **retrieval trace** replaces
the old static "Searching the sources…" copy with one live line per tool call. **No backend
changes.**

## Files Changed

(vs `develop` merge-base `1428edd`)

- `prototypes/ansari-expo/app/chat/[id].tsx` (+197 / -46 region) — incremental render, synthetic
  in-progress bubble with per-turn identity reconciliation, live retrieval trace, keep-partial-on-error
- `prototypes/ansari-expo/lib/chat-trace.ts` (+107 / -0, new) — pure `traceReducer` /
  `formatTraceLine` / `displayTool` for the transient trace
- `prototypes/ansari-expo/lib/api/chat-stream.ts` (+18) — `sawText` flag + zero-text loud-fail guard
- `prototypes/ansari-expo/lib/api/hooks.ts` (+17) — `onEvent` progress seam on `useSendMessage`
- `prototypes/ansari-expo/lib/api/index.ts` (+2) — barrel exports `ChatStreamEvent` / `ChatStreamError`
- `prototypes/ansari-expo/README.md` (±40) — limitation section → incremental behaviour
- `prototypes/ansari-expo/lib/chat-trace.test.ts` (+134, new)
- `prototypes/ansari-expo/lib/api/chat-stream.test.ts` (+37)
- `prototypes/ansari-expo/lib/api/streaming.test.ts` (+67)
- `prototypes/ansari-expo/components/AnswerMessage.test.tsx` (+23)

## Commits

- `d062f25` [PIR #65] Progress channel: onEvent seam, zero-text guard, trace helper
- `3426ce4` [PIR #65] Render the streamed answer incrementally + live retrieval trace
- `29a6909` [PIR #65] Trace: map backend search_* tool ids to bare inline labels

(plus builder-thread + porch bookkeeping commits)

## Test Results

- `pnpm typecheck` (tsc --noEmit): ✓ pass
- `pnpm test` (vitest): ✓ **93 passed** (13 new). No `lint` script exists in the prototype.

**Negative / loud-failure tests** (the character carried over from #63):

- `chat-stream.test.ts`: stream ends without `done` → throws (truncation guard); non-JSON frame →
  throws; text frame with non-string `content` → throws; **zero-text stream (`[done]`) → throws
  "empty answer"**; a done stream whose only text frame is empty → throws; error frame → throws
  with its message.
- `streaming.test.ts`: **zero-text streaming body → rejects "empty answer"**; the two existing
  one-request guards (streaming body + buffered `.text()` fallback, no second POST via fetch or XHR)
  still green.

**Progressive-render tests:**

- `chat-stream.test.ts`: `onEvent` receives text deltas progressively **and in order, before**
  `done`.
- `streaming.test.ts`: a `text` frame **split across two reads** with a heartbeat between frames is
  reassembled and delivered as progressive `onEvent` deltas, resolving the full answer in one request.
- `chat-trace.test.ts`: `traceReducer` open/complete/earliest-pending; `formatTraceLine` incl.
  `resultCount: 0` → "no hadith found" (never "0 results") and singular/plural; `displayTool`
  mapping incl. an **unknown** tool id.
- `AnswerMessage.test.tsx`: the synthetic in-progress bubble (no citations, `createdAt: ''`) renders
  the partial text with **no timestamp artifact**.

**Hard-constraint checks** (issue requirement):

```
$ turbo ls
7 packages (pnpm9)                      # prototype is outside the workspace; graph unchanged

$ git diff --stat <merge-base> HEAD -- pnpm-lock.yaml
(empty)                                 # root lockfile byte-identical / untouched

$ git diff --stat <merge-base> HEAD -- prototypes/ansari-expo/pnpm-lock.yaml prototypes/ansari-expo/package.json
(empty)                                 # prototype's own lockfile + manifest untouched (no install-driven changes)

$ git diff --name-only <merge-base> HEAD
# every code path under prototypes/ansari-expo/ (+ codev docs); nothing in apps/ or packages/
```

**Manual verification — reviewer-vs-builder split:**

- *Proved by the builder (headless):* the parser / progress-channel behaviour via the unit tests
  above; the account-switch path reviewed **statically** (`lib/auth/context.tsx` `applySession()`
  clears the react-query cache on every principal transition; `AuthGate` blocks rendering during
  loading/redirect so no protected screen flashes).
- *Proved by the reviewer (architect, interactive, staging, web + iOS):* tokens appear
  progressively; the live trace reads "Searching quran for …" on a real answer (verified by the
  architect against staging); heartbeat gaps don't flicker; the final bubble matches the refetched
  message with no jump; error mid-stream keeps the partial text; and the guest → register-different-
  account → logout → login walk shows no stale threads and no protected-screen flash.

## Architecture Updates

No arch changes. This is a client-only render change inside the `prototypes/ansari-expo` prototype
(deliberately outside the workspace/Turborepo graph) — it introduces no new module boundary, service
edge, or persistent-state rule for the production system, so neither `arch-critical.md` (hot) nor
`arch.md` (cold) applies.

## Lessons Learned Updates

Routed to **COLD** `codev/resources/lessons-learned.md` (new section "Incremental streaming render —
prototype (issue #65)") and the hot-tier map in `lessons-critical.md` updated to match — three
durable, reusable lessons: (1) "it streams" is a transport claim, verify the render separately;
(2) a seamless synthetic→persisted hand-off needs a shared, per-turn stable list key (and count-based
"did this turn's answer land" detection); (3) a callback fired before validation (SSE `consume()`
calls `onEvent` before type-checking) can leak a pre-error artifact, so re-check in the consumer.
Nothing rose to the capped hot tier — these are render-layer recipes, not system-shape invariants.

## Things to Look At During PR Review

- **The hand-off in `app/chat/[id].tsx`.** The synthetic in-progress bubble is keyed per-turn
  (`STREAM_KEY_PREFIX`); on `done` the refetched persisted message inherits that same key via
  `keyOverrides` so the row updates in place. To avoid a one-frame duplicate, the memo suppresses the
  just-landed server answer *while streaming* (distinguished by message count at send, not "last is
  assistant" — which would misfire on a follow-up whose prior answer is still the last message), and
  the hand-off effect clears `streamingText` + sets the key override atomically.
- **Trace visibility rule.** The trace is hidden once the first `text` frame lands (the issue's
  explicit "keep the indicator only until the first text frame" rule). Tool calls interleaved *after*
  text begins therefore don't re-show it — a documented prototype simplification, not an oversight.
- **`displayTool` wording.** Backend ids (`search_hadith`, `search_tafsir_encyclopedia`, …) are
  mapped to bare inline labels ("hadith", "tafsir encyclopedia") so a line reads "Searching hadith
  for …" — matching the issue's own example — rather than the backend's `TOOL_LABELS` noun phrases
  ("Hadith search"), which don't fit the "Searching X for …" sentence. Unknown/unprefixed ids pass
  through; absent ids keep the generic "the sources" path.
- **Loud-failure guard placement.** The zero-text guard lives in the React-free core
  (`chat-stream.ts` `assertComplete`) so it holds even if the API omits its `{type:"error"}` frame,
  and is unit-testable without React.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder `pir-65` → **Review Diff**.
- **Run dev**: VSCode sidebar → **Run Dev**, or `afx dev pir-65`; or from the repo root
  `pnpm prototype`, or `cd prototypes/ansari-expo && pnpm start` (targets staging — nothing else to run).
- **Automated**: `cd prototypes/ansari-expo && pnpm install --ignore-workspace && pnpm typecheck && pnpm test`.
- **What to verify** (maps to the plan's Test Plan):
  - Ask a question → tokens appear progressively (no long blocking spinner).
  - Before the first text, the trace shows live per-tool lines; a 0-result search reads "no <tool>
    found"; the trace disappears once text starts and does not return on reload.
  - Heartbeat gaps don't flicker; on completion the final bubble matches the refetched message with
    no jump/duplicate/gap.
  - Error mid-stream keeps partial text + error notice; a zero-text answer shows the error with no
    empty bubble; "Try again" re-sends.
  - Account-switch walk: guest → register a different account → logout → login → no stale threads, no
    protected-screen flash.
