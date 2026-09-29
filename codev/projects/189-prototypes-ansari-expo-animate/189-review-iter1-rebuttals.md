# Rebuttal — PIR #189, review iteration 1

Fix commit: `60a5126` ([PIR #189] fix: consult findings (hand-off race, settle-time claims)).

## Codex — REQUEST_CHANGES

**1. Hand-off race: a landed answer is drawn whole before the first reveal tick. ACCEPTED, fixed in code.**
Valid. `revealedText` was the reconciler's only stream input, so in the ~48 ms before the first tick
(`revealedText === ''`) the landed-answer holdback did not apply. Fix:
- `reconcileThread` takes an optional `revealedText` alongside `streamingText`. `streamingText` decides holdback ("turn in flight"), and `revealedText` is the bubble's content. The bubble is added only once something is revealed.
- `app/chat/[id].tsx` passes both.
- Regression test in `lib/chat-reconcile.test.ts`: landed answer + non-empty target + empty reveal gives neither the persisted answer nor a bubble. Mutation-checked: switching the holdback back to `revealedText` fails it. Two more tests cover prefix content and the default.

**2. Settle bound not implemented as documented. ACCEPTED, docs corrected, behaviour kept.**
Valid: `backlog / settleSeconds` recomputed per tick is exponential, so drain time is logarithmic in the
backlog (~0.2 s for the ~75-character backlog a fast stream leaves, ~0.7 s for 2000 characters). I kept
the behaviour rather than adding stateful linear drain. A big final chunk revealing over ~0.7 s is the
smoothing the issue asks for, and the hand-off still waits for it, so nothing pops in. Corrected
`REVEAL` docs in `lib/reveal.ts`, `arch.md` and the review. The test now asserts the logarithmic bound
for backlogs up to 20,000 characters, plus ≤ 260 ms for 75 characters and ≤ 800 ms for 2000.

## Claude — APPROVE
Minor notes adopted in the review's "Things to Look At": backgrounded-tab rAF pause, the `generating` vs
footer keying, and the platforms exercised not being recorded. The reduced-motion extra render is
left as is, as the reviewer suggested.

## Gemini — COMMENT
Skipped: the `agy` CLI isn't installed on this machine. No findings.

Tests after the fix: prototype `vitest run` 310 passed, `tsc --noEmit` clean.
