# pir-65 — render streamed answer incrementally (removes #63's buffer-until-done)

## Phase: PLAN (iteration 1)

### Context gathered
- #63 is MERGED (closed). Transport + parser already shipped:
  - `lib/api/streaming.ts` — `streamChat()` opens ONE POST via `expo/fetch`, reads the
    streaming body, and delivers every typed event to an `onEvent` callback. XHR fallback was
    REMOVED; when `response.body` is absent it buffers the in-hand `.text()` (one-request
    property; `streaming.test.ts` asserts it — must preserve).
  - `lib/api/chat-stream.ts` — RN-free core: `consume()` folds SSE payloads into state, forwards
    each event to `onEvent`, loud-fails on error frame / non-JSON / non-string content;
    `assertComplete()` loud-fails on missing `done`. `ChatStreamEvent`: text | tool_call{name} |
    tool_result{tool,query,resultCount} | error | done.
  - `lib/api/sse.ts` — `\n\n`-framed, heartbeat-skipping, multi-chunk-tolerant parser.
- The GAP is RENDER, not transport (architect + issue both stress this).
- `app/chat/[id].tsx` today: `useSendMessage` mutation ignores the return; `ThinkingIndicator`
  (static "Searching the sources…") shows while `awaitingAnswer`; on success it invalidates the
  detail query and re-renders from the refetched thread. `ECHO_ID` reconciliation-by-identity
  pattern already exists for the user question (reuse this pattern for the streaming bubble).
- `useSendMessage` (`lib/api/hooks.ts:147`) calls `streamChat` WITHOUT `onEvent`.
- AMENDMENT (2026-08-28, in scope): carry `tool_call`/`tool_result` through the progress channel
  and replace the static indicator copy with live per-tool lines
  ("Searching hadith for \"patience\" — 12 results"; resultCount:0 → "no hadith found").
  Transient: shown only while awaiting, never persisted/replayed. NOT chips/citations.
- Hard constraints: all work inside `prototypes/ansari-expo` (OUTSIDE the 7-package turbo graph —
  confirmed `turbo ls` = 7 packages, prototype not listed); root `pnpm-lock.yaml` byte-identical;
  install with `pnpm install --ignore-workspace`; merge commit (never squash); never `git add -A`.
- Architect extra ask: manual account-switch smoke test (guest → register diff account → logout →
  login; no stale threads, no protected-screen flash) early in dev; report anomalies before building.

### Decisions
- Streaming answer rendered as a SYNTHETIC assistant message reconciled by identity (STREAM_ID),
  mirroring ECHO_ID — avoids the gap/duplicate flicker a header-swap would cause on `done`→refetch.
- Zero-text loud failure enforced in the parser core (`assertComplete`) via a `sawText` flag, so
  it is unit-testable without React and independent of whether the API emits an error frame.
- Trace copy logic extracted to a tiny pure helper so the "resultCount:0" wording is unit-tested.

Next: write plan to codev/plans/65-prototypes-ansari-expo-render-.md, commit, porch done, gate.
