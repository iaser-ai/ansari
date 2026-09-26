# PIR Plan: Paced reveal of the streamed answer (prototypes/ansari-expo)

## Understanding

Right now the streaming bubble shows text in whatever sizes and at whatever times the SSE `text`
deltas arrive:

- `app/chat/[id].tsx:287-293`: `onEvent` appends each delta to `rawStreamText` and immediately
  calls `setStreamingText(stripStreamingCitations(raw))`.
- `app/chat/[id].tsx:350-366`: `reconcileThread` turns `streamingText` into the synthetic assistant
  bubble. `AnswerMessage` renders it through `AnswerProse`, and `parseAnswer` re-parses the whole
  string on every change.

Every chunk therefore lands in one piece, and when that happens depends on how the backend
batches its output. The issue asks for a local reveal that doesn't depend on network timing:
buffer the cleaned text and show a "revealed so far" slice that moves forward steadily.

Constraints from the issue and the code:

1. **Downstream of `stripStreamingCitations`.** The reveal consumes `streamingText` (already
   cleaned, with its unfinished tail held back) and never the raw text.
2. **The cleaned text is not append-only.** Once a `[1]` is complete, the `Citations:` heading is
   known, or a held tail turns out to be prose, `stripStreamingCitations` can *remove* or *change*
   characters behind the end of the previous output (`lib/citations.ts:26-53`). So the reveal can't
   just track a length. It has to clamp to the longest common prefix of what it has shown and the
   new target.
3. **Partial markdown.** `lib/markdown.ts:32-36` already guarantees that any unclosed construct
   degrades to literal text. That guarantee covers any prefix, so an arbitrary local slice is safe.
   The only extra care needed: never cut through a UTF-16 surrogate pair (emoji), because the
   half-character would render as a replacement glyph for one frame.
4. **No lag at `done`.** The hand-off effect (`app/chat/[id].tsx:403-420`) swaps in the persisted
   message as soon as `landedAnswer` appears. If the reveal is still behind at that moment, the rest
   of the answer pops in all at once, which is the exact jump this issue wants gone.
5. **Reduced motion** follows the app's convention (`useReducedMotion()` from reanimated,
   `ReduceMotion.System` in configs). With it on, no pacing happens and the text shows as it
   arrives, which is today's behaviour.

**Architect's direction (merge queue: #128 / PR #188 and #161 touch the same files):** add a new
hook layered on top of `streamingText`. The `onEvent` handler is not rewritten, and the changes to
`[id].tsx` stay small and local. Before opening the PR, merge `develop` and re-verify.

## Proposed Change

### 1. `lib/reveal.ts`: pure pacing core (new, RN-free, unit-tested)

```ts
export const REVEAL = {
  baseCps: 90,          // steady typing speed when the buffer is small
  catchUpSeconds: 0.5,  // backlog is drained within ~this long while streaming
  settleSeconds: 0.15,  // …and within ~this long once the stream has finished
} as const;

/** Longest common prefix of the shown slice and the (possibly revised) target. */
export function commonPrefixLength(a: string, b: string): number;

/**
 * Next revealed length. The rate is max(baseCps, backlog / window), where the
 * window is catchUpSeconds while streaming and settleSeconds once `settled`.
 * The result is clamped to [0, target.length], always advances by at least one
 * character when behind, and never ends between the two halves of a surrogate pair.
 */
export function nextRevealLength(shown: number, target: string, dtMs: number, settled: boolean): number;
```

Why the lag stays bounded: when the backlog is large, the rate is `backlog / window`, so the lag
can't grow past roughly `arrivalRate × window`. At about 150 cps of model output that's around
75 characters (half a second of reading), and it never accumulates over a long answer. When the
backlog is small, the base rate keeps the reveal steady and typewriter-like instead of ending each
chunk on a slow exponential tail.

### 2. `hooks/useRevealedText.ts`: the React shell (new)

`useRevealedText(target: string, settled: boolean): string`

- Stores the shown length in a ref and commits it to state on a `requestAnimationFrame` loop
  throttled to about 30 Hz (≥32 ms between commits). Each commit re-parses the answer through
  `parseAnswer`, and 30 Hz is enough for smooth text while halving the re-render load compared with
  60 Hz. The loop runs only while `shown < target.length` and is cancelled on unmount or when
  caught up.
- When `target` changes, the shown length is clamped to `commonPrefixLength(shownSlice, target)`,
  which handles revisions from citation stripping.
- `target === ''` resets to 0 immediately (new send, hand-off clear, failure reset).
- With `useReducedMotion()` on, it returns `target` unchanged.
- It returns `target.slice(0, shown)`.

### 3. `app/chat/[id].tsx`: additive wiring only (about 3 small edits)

- After the `sendMessage` declaration:
  `const revealedText = useRevealedText(streamingText, !sendMessage.isPending);`
  The `settled` flag makes the reveal speed up to finish once the stream ends (on success or on
  error).
- Pass `revealedText` to `reconcileThread` where `streamingText` goes now, and update the `useMemo`
  deps. The synthetic bubble then shows the revealed slice. `streamingText` keeps its meaning as
  "the cleaned text received so far" everywhere else: the footer, `generating`, the failure path,
  and the hand-off.
  - One detail to settle during implementation: while `revealedText` is still `''` (the first
    frame after the first delta), the footer would already have swapped the ThinkingLine for the
    GeneratingMark with no bubble above it. The first chunk is revealed on the next tick (about one
    frame, since the hook always advances at least one character), so this should be invisible. If
    it isn't, the footer conditions switch to `revealedText`.
- Hand-off gate (`[id].tsx:409`): `if (streamingText && landedAnswer)` becomes
  `if (streamingText && landedAnswer && revealedText === streamingText)`, with `revealedText` added
  to the deps. The persisted answer then swaps in only after the reveal has caught up, so there's no
  leftover text to pop in. Because the reveal speeds up to the settle window as soon as the stream
  finishes, the hand-off is delayed by at most about 150 ms, and usually not at all: the refetch
  that brings in `landedAnswer` is itself a network round-trip, during which the reveal finishes.
  `reconcileThread` already holds back the landed message while the synthetic bubble is up
  (`chat-reconcile.ts:67-68`), so waiting a few extra frames can't show the answer twice.
- The `onEvent` handler, `rawStreamText`, `send`, and the error path are not touched.

### 4. `AnswerMessage` / `AnswerProse`: no change expected

They already render whatever string they're given, so none of their logic changes. The
architect's merge-queue note mentions these files in case the display logic moved there, but this
design leaves them untouched, which also stays clear of #161.

## Files to Change

- `prototypes/ansari-expo/lib/reveal.ts` (new): the pure pacing functions above.
- `prototypes/ansari-expo/lib/reveal.test.ts` (new): unit tests for them.
- `prototypes/ansari-expo/hooks/useRevealedText.ts` (new): the rAF/reduced-motion hook.
- `prototypes/ansari-expo/app/chat/[id].tsx`: the hook call near `:268`, `reconcileThread` input
  and deps at `:350-366`, and the hand-off condition and deps at `:409-420`.
- `codev/resources/arch.md` (Prototype chat display section): one short paragraph describing the
  reveal stage (raw → `stripStreamingCitations` → reveal → bubble) and the hand-off-waits-for-reveal
  rule.

## Risks & Alternatives Considered

- **Risk: per-frame re-parse cost on long answers.** Mitigated by the 30 Hz throttle and by
  committing only when the length actually changed. During dev-approval I'll check that a long
  answer streams without jank on web. If it doesn't, I'll drop to about 20 Hz. Memoizing parsed
  blocks is out of scope.
- **Risk: the hand-off never fires if the reveal never catches up.** It can't happen: the reveal
  always advances at least one character when behind, and once settled it drains within about
  150 ms. A test covers `nextRevealLength` converging to `target.length` within a bounded number of
  ticks for both the settled and unsettled windows.
- **Risk: error mid-stream.** `streamingText` is left on screen above the failure notice. Since
  `settled` becomes true, the reveal finishes showing the partial text quickly, and nothing waits on
  a hand-off.
- **Risk: merge conflicts with #128 and #161.** The `[id].tsx` changes are three small hunks, and
  the new logic lives in new files. I'll merge `develop` before the PR and re-verify.
- **Alternative: reanimated/CSS opacity fade on newly arrived spans.** Rejected. It needs span-level
  diffing inside `AnswerProse`, which is a bigger change touching files other PRs are editing, and
  it still pops in at chunk boundaries (fading them in, but not pacing them).
- **Alternative: a fixed characters-per-tick rate.** Rejected. It either lags far behind a fast
  model or looks sluggish, and it breaks the "never falls behind indefinitely" acceptance.
- **Alternative: pacing inside `onEvent`.** Rejected, per the architect's direction to keep the
  handler untouched.

## Test Plan

- **Unit (`lib/reveal.test.ts`, vitest):**
  - Advances at about the base rate for a small backlog; `dt` scales the step.
  - A large backlog drains within about `catchUpSeconds`; with `settled` it drains within about
    `settleSeconds`.
  - Always advances at least 1 when behind; never exceeds `target.length`; handles `dt = 0` and
    very large `dt` (a background tab).
  - Never ends between the two halves of a surrogate pair (emoji at the boundary).
  - `commonPrefixLength` handles a revised target (a `[1]` stripped behind the cursor, a
    `Citations:` cut, an empty target).
  - A simulated bursty stream (large chunks at irregular intervals) keeps the lag bounded
    throughout and reaches full length shortly after the last chunk.
- **Existing suites:** `pnpm vitest run` in `prototypes/ansari-expo` (chat-reconcile, citations,
  and markdown stay green), plus the typecheck.
- **Manual (web, `afx dev`):**
  - Ask a question and watch the answer: it should type out steadily rather than jumping in chunks,
    including when the backend sends large chunks.
  - On a long answer, the reveal should finish at most a moment after the stream does, with no
    growing lag.
  - At `done`, no jump or flicker as the persisted message replaces the bubble, and Copy/Share
    appear once.
  - With reduced motion on (macOS System Settings → Accessibility → Display → Reduce motion), text
    appears as it arrives, as it does today.
  - Failure mid-stream: the partial text finishes revealing and the retry notice appears below it.
- **Cross-platform:** iOS simulator smoke test if available; the logic is platform-independent
  (rAF is available in RN).
