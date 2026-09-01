# PIR Plan: Render the streamed answer incrementally (removes #63's buffer-until-done)

## Understanding

`prototypes/ansari-expo` streams the assistant's answer from `apps/api`
(`POST /api/v2/threads/{id}/chat`, `text/event-stream`), but #63 deliberately shipped
**buffer-until-done**: `useSendMessage` calls `streamChat()`, which reads the whole stream and
resolves only on `{type:"done"}`; the chat screen ignores the return value, invalidates the detail
query, and re-renders from the refetched thread. So the reader watches a spinner
("Searching the sources…") for 10–30 s and then the whole answer pops in at once. #63's human
accepted this **only** on the condition it is documented as a prototype limitation, because the
audience is frontend devs deciding how the real app should behave.

This issue removes the limitation. It is a **RENDER** problem, not a transport one — the transport
seam already exists:

- `streamChat()` (`lib/api/streaming.ts:41`) issues exactly ONE POST and delivers **every** typed
  event (`text` | `tool_call` | `tool_result` | `error` | `done`) to an `onEvent` callback as it
  arrives (`lib/api/chat-stream.ts:52`). The one-request property (buffer `.text()` when
  `response.body` is absent, never a second POST) is asserted by `streaming.test.ts` and must be
  preserved.
- What is missing is **screen surface** for a partial answer: `app/chat/[id].tsx` never reads the
  mutation's progress and only re-renders on the post-`done` refetch.

An **amendment** (human decision, 2026-08-28, in scope) adds a transient **retrieval trace**: carry
`tool_call`/`tool_result` through the same progress channel and replace the static
"Searching the sources…" copy with live per-tool lines
(`Searching hadith for "patience" — 12 results`; `resultCount:0` → `no hadith found`). The trace is
transient — shown only while awaiting the answer, never persisted or replayed on reload — and must
**not** become chips/footnotes or sit near the citation UI.

## Proposed Change

### 1. Progress channel: thread `onEvent` from `useSendMessage` into `streamChat`

`useSendMessage` (`lib/api/hooks.ts:147`) currently calls `streamChat` without `onEvent`. Add an
optional `onEvent?: (event: ChatStreamEvent) => void` to the hook's options and pass it straight
into `streamChat({ …, onEvent })`. This is the whole transport-side change — the parser already
forwards events. The chat screen owns the derived state (partial text + trace) and updates it from
the callback, keeping the hook thin and the mutation's `MessageExchange` contract unchanged.

### 2. Zero-text loud failure in the parser core (unit-testable, React-free)

Add a `sawText: boolean` to `StreamState` (`lib/api/chat-stream.ts`), set it in the `text` branch of
`consume()`, and in `assertComplete()` throw a `ChatStreamError`
("The assistant returned an empty answer.") when the stream reached `done` but **no** `text` frame
was ever seen. This makes the loud-failure guarantee — "a stream that yields zero `text` frames
before `done` surfaces as an error, never an empty bubble" — hold even if the API omits its
`{type:"error"}` frame, and it is testable without React (the API's own empty-answer error frame
already throws via the existing `error`-frame path; this is the belt-and-braces guard the issue
asks for).

### 3. Trace formatting: a tiny pure helper (unit-testable copy)

New `lib/chat-trace.ts`: a pure reducer + formatter over `ChatStreamEvent`s that produces the
transient trace lines.

- `traceReducer(entries, event)` → next entries: `tool_call{name}` appends a pending entry
  `{ tool, pending: true }`; `tool_result{tool,query,resultCount}` completes the earliest pending
  entry of that tool (or appends a completed one) with `query`/`resultCount`.
- `formatTraceLine(entry)` → string:
  - pending → `Searching {tool}…`
  - completed, `resultCount > 0` → `Searching {tool} for "{query}" — {n} result[s]`
  - completed, `resultCount === 0` → `no {tool} found`
  - missing `tool`/`query` degrade gracefully (fall back to "the sources").

Keeping the copy logic pure means the amendment's honesty rule (`resultCount:0`) gets a unit test
without rendering React Native.

### 4. Chat screen: incremental render (`app/chat/[id].tsx`)

- **State:** `streamingText: string` and `trace: TraceEntry[]`, both reset at the start of each
  `send()` (before `mutate`) and on retry.
- **Wire the callback:** pass `onEvent` to `useSendMessage`. On `text` → append `content` to
  `streamingText`. On `tool_call`/`tool_result` → `setTrace(t => traceReducer(t, event))`. (`error`
  and `done` are handled by react-query's `isError`/`onSuccess`; the partial `streamingText` is left
  intact on error.)
- **In-progress answer as a synthetic message, reconciled by identity** (mirrors the existing
  `ECHO_ID` pattern, which is why that pattern exists): while `streamingText` is non-empty and the
  persisted assistant reply for this turn has not yet arrived, append a synthetic assistant
  `Message` keyed `STREAM_ID` (`{ id: STREAM_ID, role:'assistant', content: streamingText,
  citations: [], createdAt: '' }`) to `messages`. It renders through **`AnswerMessage`** unchanged
  (its markdown parser already tolerates partial syntax and is memoized per content string, so an
  in-flight answer re-parses without remounting — see its header comment). Reconciliation by
  identity avoids the flip-side flaws of a header swap: no gap (answer vanishing between
  `isPending:false` and refetch landing) and no double-render (streaming bubble + persisted bubble
  both visible for a frame).
- **Hand-off on `done`:** on success the existing `invalidateQueries` triggers the refetch; when the
  refetched thread's last message is the assistant reply, clear `streamingText`/`trace`. The
  server's persisted assistant message then carries the real ids/timestamps/citations. (Detail: to
  keep the swap seamless, the newest persisted assistant message inherits `STREAM_ID` as its key on
  the turn it replaces the synthetic one, so the row updates in place rather than remounting and
  re-animating — same trick as the echo.)
- **Indicator vs. trace vs. answer (issue point 2 + amendment):** while `awaitingAnswer` and
  `streamingText` is still empty, `ThinkingIndicator` shows the **live trace** — one line per
  `traceReducer` entry via `formatTraceLine`, in the same component/text style — falling back to the
  existing "Searching the sources…" line when no tool events have arrived yet. Once the first `text`
  frame lands, `streamingText` is non-empty, the synthetic answer bubble takes over, and the trace
  is hidden (transient). The trace is never added to `messages`, never persisted, and absent on
  reload.
- **Error mid-stream:** on `sendMessage.isError`, keep the synthetic streaming bubble visible if
  `streamingText` is non-empty (do **not** blank it) and show the existing `SendErrorNotice`; the
  `ThinkingIndicator` is gone (`awaitingAnswer` is false). A **zero-text** error leaves
  `streamingText` empty → no synthetic bubble → only `SendErrorNotice` (never an empty bubble).
  Retry resets state and re-sends `lastSent.current`.

### 5. README (`prototypes/ansari-expo/README.md`)

Replace the "Streaming chat — a known PROTOTYPE LIMITATION" section (lines ~92–102) with a section
describing the incremental behaviour: tokens render as `text` events arrive; a transient retrieval
trace replaces the spinner while the model searches; heartbeat gaps don't flicker the UI; on `done`
the in-progress bubble is replaced by the refetched persisted message; an error mid-stream keeps the
partial text on screen; a zero-text stream surfaces as an error. Keep the note that
`lib/api/streaming.ts`'s `onEvent` is the seam. Fix the one-line forward-reference at README:5
("watch the answer stream back") is already accurate; the block at README:24 ("the answer streams")
stays. Ensure no other paragraph still calls the buffering a limitation (fix the doc defect
everywhere, per lessons-critical).

## Files to Change

- `lib/api/hooks.ts:147-197` — add optional `onEvent` to `useSendMessage` options; pass into
  `streamChat`. (Re-export `ChatStreamEvent` type via the barrel if needed for the screen's import.)
- `lib/api/chat-stream.ts` — add `sawText` to `StreamState` + `createStreamState`; set it in the
  `text` branch of `consume()`; extend `assertComplete()` with the zero-text guard.
- `lib/chat-trace.ts` — NEW. `TraceEntry` type, `traceReducer`, `formatTraceLine` (pure).
- `app/chat/[id].tsx` — `streamingText`/`trace` state; wire `onEvent`; synthetic `STREAM_ID`
  assistant message + identity reconciliation and hand-off; live trace lines in `ThinkingIndicator`;
  keep-partial-on-error. (Import `AnswerMessage` reused as-is.)
- `lib/api/index.ts` — export `ChatStreamEvent` (already re-exported from `streaming.ts`; confirm the
  barrel surfaces it for the screen).
- `prototypes/ansari-expo/README.md` — replace the limitation section with the incremental
  description.

Tests:

- `lib/api/chat-stream.test.ts` — add: (a) **zero-text** stream (`[done]`) throws `ChatStreamError`;
  (b) a done stream **with** text still passes; (c) `onEvent` receives `text` deltas **progressively
  and in order** before `done` (progress channel).
- `lib/api/streaming.test.ts` — add: a **chunk-split** streaming body (a `text` frame split across
  two `read()` calls, plus a heartbeat between frames) delivers text deltas via `onEvent`
  progressively and resolves the full answer; a zero-text streaming body **rejects**. Preserve the
  existing one-request assertions.
- `lib/chat-trace.test.ts` — NEW (node env). `traceReducer` builds/completes entries;
  `formatTraceLine` renders the four cases including `resultCount:0` → "no {tool} found" and
  singular/plural "result(s)".

## Risks & Alternatives Considered

- **Flicker on `done` hand-off.** Risk: answer momentarily disappears (gap) or shows twice
  (duplicate) when the streaming bubble is replaced by the refetched one. Mitigation: identity
  reconciliation (`STREAM_ID`) — the persisted assistant message inherits the synthetic row's key so
  it updates in place; `streamingText` is cleared only once the persisted assistant reply is present.
  This is the same technique #63 used for the user echo.
- **Heartbeat/`: ping` gaps flickering the UI.** The `SSEParser` already skips heartbeats and holds
  partial frames until `\n\n`; no state changes on a ping, so no re-render. The chunk-split test
  covers a heartbeat between frames.
- **Tool calls interleaved with text (facilitator loops: search → text → search again).** The
  issue's rule is "keep the indicator only until the first `text` frame," so once text starts the
  trace is hidden even if later tool calls occur. Chosen for fidelity to the issue and simplicity;
  documented as a prototype simplification in the review. Alternative — keep the trace pinned above
  the streaming answer for the whole turn — rejected: it contradicts the issue's explicit rule and
  risks the trace drifting toward looking like persistent metadata.
- **Citations during stream.** The partial bubble has no citations until the refetch; inline `[1]`
  markers render as literal text mid-stream, resolving to chips once the persisted message lands.
  Acceptable for a prototype and self-correcting on `done`; noted in the README.
- **Testing the React hook directly** (jsdom + QueryClientProvider + mocking `streamChat`) is heavy
  and `hooks.ts` pulls Expo runtime. Chosen instead: test the progress channel at the `streamChat`
  `onEvent` seam (the exact seam the hook forwards) and the pure `chat-trace`/parser logic — the same
  split `vitest.config.ts` already documents. If a light hook render proves clean it can be added,
  but it is not the primary evidence.
- **Hard constraints.** All edits stay inside `prototypes/ansari-expo`, which is OUTSIDE the
  7-package turbo workspace (`turbo ls` = 7; prototype not listed) and installs with
  `--ignore-workspace`, so the turbo graph and root `pnpm-lock.yaml` are untouched by construction.
  Verified in the Test Plan.

## Test Plan

**Automated (`cd prototypes/ansari-expo && pnpm test`):**
- `chat-stream.test.ts`: zero-text `[done]` → throws; done-with-text → passes; `onEvent` text deltas
  arrive progressively and in order before `done`.
- `streaming.test.ts`: chunk-split streaming body → progressive `onEvent` text + full answer; zero-
  text body → rejects; existing one-request (streaming + buffered) assertions still green.
- `chat-trace.test.ts`: reducer + all four `formatTraceLine` cases (incl. `resultCount:0`, plural).
- `pnpm typecheck` and `pnpm lint` clean.

**Manual (reviewer, at dev-approval, against staging — web and iOS):**
- Ask a question → **tokens appear progressively** (not a single pop after a long spinner).
- While the model searches, the indicator shows **live trace lines** ("Searching hadith for … — N
  results"; a `0`-result search reads "no hadith found"); the trace disappears once text starts and
  does not reappear on reload.
- Heartbeat gaps do **not** flicker the UI.
- On completion the final bubble matches the refetched persisted message (real citations/timestamps)
  with no visible jump/duplicate/gap.
- Force an error mid-stream (or a zero-text answer): partial text stays on screen with the error
  notice; a zero-text answer shows the error with **no empty bubble**; "Try again" re-sends.
- **Account-switch smoke test (architect ask, do this early):** guest → register a *different*
  account → logout → login → confirm no stale threads render and no protected screen flashes; report
  anything off to the architect before building further.

**Hard-constraint checks (paste in PR):**
- `cd prototypes/ansari-expo && pnpm install --ignore-workspace` (prototype's own lockfile only).
- From repo root: `turbo ls` → **7 packages** (prototype absent).
- `git status -- pnpm-lock.yaml` / `git diff --stat -- pnpm-lock.yaml` → root lockfile **byte-
  identical** (untouched).
- `git diff --name-only <base>..HEAD` → every path under `prototypes/ansari-expo/`.
