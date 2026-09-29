# PIR Review: Paced reveal of the streamed answer (prototypes/ansari-expo)

Fixes #189

## Summary

The streaming answer bubble used to show each SSE `text` delta at the moment it arrived, so the
answer lurched forward in chunks whose size and timing the backend decided. It now types out at a
steady pace that doesn't depend on network arrival. A new hook, `useRevealedText`, walks a cursor
towards the cleaned `streamingText` at `max(90 cps, backlog / 0.5 s)`. That keeps it looking like
steady typing, and the lag can't grow past about half a second of text however long the answer
runs. Once the request settles, the reveal hurries through the remainder (~0.2 s typically), and the `done` hand-off
waits until it has caught up, so the persisted answer never lands with unrevealed text. With reduced
motion on, text appears as it arrives, unpaced.

The design is additive, per the architect's direction: #128 and #161 were editing the same files.
`onEvent`, `rawStreamText`, and `AnswerProse`/`AnswerMessage` are untouched. The reveal sits
downstream of `stripStreamingCitations`: raw → cleaned → revealed → `reconcileThread`.

## Files Changed

- `prototypes/ansari-expo/lib/reveal.ts` (+82 / -0): pure pacing core (`advanceReveal`, `revealSlice`, `commonPrefixLength`, `REVEAL` constants)
- `prototypes/ansari-expo/lib/reveal.test.ts` (+149 / -0)
- `prototypes/ansari-expo/hooks/useRevealedText.ts` (+88 / -0): rAF clock throttled to ~30 Hz, reduced motion, same-render clamp
- `prototypes/ansari-expo/hooks/useRevealedText.test.tsx` (+136 / -0)
- `prototypes/ansari-expo/app/chat/[id].tsx`: hook call, `reconcileThread` inputs, hand-off gate, footer conditions
- `prototypes/ansari-expo/lib/chat-reconcile.ts` / `.test.ts`: optional `revealedText` input, separate from `streamingText` (consult fix, below)
- `prototypes/ansari-expo/vitest.config.ts` (+5 / -1): `hooks/**/*.test.*` added to `include`
- `codev/resources/arch.md` (+3 / -1), `codev/resources/lessons-learned.md`, `codev/resources/lessons-critical.md` (map entry)
- `codev/plans/189-prototypes-ansari-expo-animate.md`, `codev/state/pir-189_thread.md`, this review

## Commits

- `6df3105` [PIR #189] Plan draft
- `b71d877` [PIR #189][Phase: implement] feat: pace the streamed answer reveal
- `34b6f9a` [PIR #189] thread: porch check notes
- merges of `origin/develop` (#128 / PR #188, then #161), plus porch bookkeeping commits
- [PIR #189] Review + retrospective
- [PIR #189] fix: consult findings (hand-off race, settle-time claims)

## Test Results

- `tsc --noEmit` (prototype): ✓
- `vitest run` (prototype): ✓ 310 tests after merging #161, 24 of them new (15 in `reveal.test.ts`, 6 in `useRevealedText.test.tsx`, 3 in `chat-reconcile.test.ts`)
- Porch `build` / `tests`: ✓, run with `apps/api/.env.ci` exported the way CI does, because this worktree has no real `apps/api/.env` (same as #128).
- Mutation checks:
  - Disabling catch-up (`catchUpSeconds: 1e9`) fails the backlog-drain and bursty-stream lag tests.
  - Removing the same-render clamp fails the pull-back test. The first version of that test did *not* catch this; see Lessons.
- Manual: the human approved the running code at `dev-approval`. Which platforms they exercised wasn't recorded. I did not exercise it against live staging myself (no credentials), and no iOS or Android run is known.

## Architecture Updates

`codev/resources/arch.md` (cold), "Prototype chat display":
- New **Paced reveal (issue #189)** paragraph covering the pipeline, the common-prefix clamp, the hand-off gated on `revealedText === streamingText`, the settle speed-up, and reduced motion.
- **Streaming bubble chrome** corrected: the footer's ThinkingLine → GeneratingMark switch now keys off `revealedText`.

Nothing goes into `arch-critical.md`: this is prototype display detail, not a cross-cutting invariant.

## Lessons Learned Updates

`codev/resources/lessons-learned.md` (cold) has a new section, "Paced streaming reveal — prototype (issue #189)". It covers:
- A cleaned stream isn't append-only, so a reveal cursor has to clamp to the common prefix in the same render.
- A backlog-proportional rate bounds lag where a fixed speed can't.
- A hand-off must wait for local pacing to catch up.
- `renderHook`'s `rerender` flushes effects, so a per-render invariant needs every render recorded.

`lessons-critical.md` gets only a map entry. No hot lesson was displaced; the closest general rule ("negative-test every check") is already in the hot tier, and this PR is another instance of it.

## Consultation (3-way, single pass)

- **Claude: APPROVE.** It traced the hand-off gate and agreed it can't stall. Minor notes are carried into the list below.
- **Codex: REQUEST_CHANGES.** Two findings, both valid, both addressed:
  1. **Hand-off race (real defect, fixed).** `revealedText` was the reconciler's only stream input. In the ~48 ms before the first tick it is `''`, so an answer that had already landed was not held back. A very fast turn could draw the full persisted answer and then replace it with the paced prefix. Fix: `reconcileThread` now takes `streamingText` (turn in flight, holdback) and `revealedText` (bubble content) separately, and the bubble appears only once something has been revealed. A regression test fails with the old holdback (mutation-checked).
  2. **Settle bound overstated (docs fixed).** The drain is exponential down to a floor rate, so it is logarithmic in the backlog, not a fixed ~150 ms: ~0.2 s for the ~75 characters a fast stream leaves behind, and ~0.7 s for a 2000-character final chunk. I kept the behaviour: a large final chunk revealing over 0.7 s is the smoothing the issue asks for. I corrected the claims in `reveal.ts`, `arch.md` and this review, and tested the logarithmic bound up to 20,000 characters.
- **Gemini: skipped.** The `agy` CLI isn't installed on this machine.

## Things to Look At During PR Review

- **Hand-off gate** (`app/chat/[id].tsx`, the `done` effect): `revealedText === streamingText` has to become true, or the bubble never swaps out. It can't stall:
  - the cursor always advances when `dt > 0`;
  - `settled` (`!sendMessage.isPending`) raises the floor to 360 cps;
  - the rAF loop restarts on every change to `target` or `settled`.
- **`settled` on error:** a failed request also settles, so the partial text finishes revealing above the retry notice. No hand-off happens in that case.
- **#161 interaction (pre-existing, not introduced here):** the stream strips `[N]` markers, but a persisted answer *with* real documents keeps them. The hand-off therefore still swaps in text with markers (and pills). The reveal only guarantees that no *unrevealed prose* lands at once.
- **Re-parse cost:** up to ~30 commits a second each re-parse the growing answer via `parseAnswer`. It hasn't been profiled on a very long answer or a low-end phone; drop `TICK_MS` to ~50 if it janks.
- **Backgrounded tab:** browsers pause rAF, so a hand-off pending while the tab is hidden waits until it returns. One large-`dt` tick then completes the reveal and the swap fires. It's invisible to the reader.
- **`generating` vs footer:** `generating` stays keyed on `streamingText` and the footer on `revealedText`. They differ only in the pre-first-tick window, when there is no bubble for `generating` to apply to.
- **Arabic shaping:** revealing character by character re-shapes a word's last letter as the next arrives. That's inherent to typing and reads fine, but it's worth a glance.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder pir-189 → **Review Diff**
- **Run dev**: VSCode sidebar → **Run Dev**, or `afx dev pir-189`
- **What to verify**:
  - Ask a question: the answer types out steadily and never jumps at chunk boundaries.
  - On a long answer, the reveal finishes a moment after the stream does, with no growing lag.
  - At `done`: no jump or flicker, and Copy/Share appear once.
  - Reduced motion on (macOS Accessibility → Display → Reduce motion): text appears as it arrives.
  - A failure mid-stream: the partial text finishes revealing, and the retry notice appears below it.

## Flaky Tests

- **`ansari-api` tests under full parallel turbo load:** the first porch `tests` run failed there. The same tests pass alone (854 passed) and on a forced turbo run, and the porch retry passed. I didn't capture which test failed, so it isn't skipped or annotated, only recorded here. It is unrelated to this diff, which touches no `apps/api` code. It is consistent with the load-sensitive cold-start tests noted under spec 168 in `lessons-learned.md`.
