# bugfix-290 thread — frontend jsdom tests flake under load

Scope (architect:app brief): apps/frontend half only. The api half is #292 (main); apps/api is untouched.

## Investigate (2026-10-13)

Baseline, `turbo run test --force --filter ansari-frontend --filter ansari-api` with `.env.ci`: 5/5 green.
The loaded symptom depends on machine load. The ambient load average here swung between 33 and 50 (other apps), and that alone moved
AmbientVideo's first test from 237ms to 3096ms. Under 14 busy-loop CPU hogs, the frontend suite ran 8 times: 7 green and 1 red with
the ScrollDismiss unhandled error.

Two independent causes, neither in component code:

1. **ScrollDismiss**: react-native-web's `ScrollViewBase.handleScroll` arms a 100ms scroll-end
   `setTimeout` and never clears it on unmount. With `keyboardDismissMode='on-drag'` it runs
   `ScrollView._handleScroll` → `dismissKeyboard` → `TextInputState.currentlyFocusedField` →
   `document.activeElement`. The error needs the timer to fire after jsdom teardown and before the
   next file's environment defines `document` again, so it shows only when that gap widens under load.
   The stack captured under stress matches the issue exactly.
2. **AmbientVideo**: there is no DOM leak. `advance()` walks fake time in 10ms `act` steps (about 6,100 commits for
   the 61s soak in the first test). Under load that crosses vitest's 5s default timeout. A timed-out
   test's async body keeps running: it keeps driving the shared fake clock and module-level `player`
   while the next tests render, so every test in the file fails. `--testTimeout=40` reproduces the
   issue's signature deterministically: 12/12 failed, with null `style`, `expected false to be true`, and timeouts.

Fix plan (test-only, small): ScrollDismiss uses fake timers and drains the scroll-end timer inside `act`
before cleanup. AmbientVideo declares a time budget sized to its simulated time, and guards
`advance` so a test that has been torn down stops driving the clock (one loud failure, no cascade).
The tests still assert exactly what they asserted before.

## Fix (2026-10-13), commit 7f43b03

Changes are test-only, +36/-4 across two files. Component code is untouched and assertions are unchanged.

- ScrollDismiss: uses fake timers, and `afterEach` drains pending timers inside `act` while jsdom still exists,
  then asserts `vi.getTimerCount() === 0` before cleanup.
- AmbientVideo: `vi.setConfig({ testTimeout: 30_000 })` for this file only, and `advance()` throws once its test has
  been torn down (a `testRun` counter bumped in `afterEach`).

Negative tests:
- ScrollDismiss, with the drain removed: the zero-timer assertion goes red ("expected 3 to be +0") in both tests.
- ScrollDismiss, using a scratch jsdom environment whose teardown keeps the worker alive 300ms (the gap
  that load opens by chance): the HEAD file gave the unhandled `ReferenceError: document is not defined`
  3/3 times, and the fixed file was clean 3/3.
- AmbientVideo with the in-file budget forced to 150ms: guard OFF failed 12 of 12 tests in 2 runs (the issue's
  signature), and guard ON failed only the test that actually ran out of time.
- AmbientVideo with CLI `--testTimeout=40`: HEAD failed 12/12, and the fixed file passed 12/12 (its own budget governs).

## Acceptance (2026-10-13)

Ran full `turbo run test --force` at default concurrency, 10 times, with `.env.ci` and 8 CPU hogs (load average up to 113).
**Frontend was 616/616 in all 10 runs, with no unhandled errors.** The api was red in 4 of the 10 runs, all out of scope:
- 3× `eslint-env-guard` "the real tree is clean" hit the 5s timeout (already #292).
- 1× `thread-get-contract.test.ts:266`: `share!.content.messages[1].documents` was undefined under load. This one is NOT
  in #292's list; it was flagged to the architect.

## PR #293 + CMAP (2026-10-13)

`consult` needed `--issue 290` here ("Multiple projects found" without it). Gemini's first lane was skipped (agy gave no output), and the retry approved.
- gemini APPROVE.
- codex COMMENT: the branch is 10 commits behind develop. Those commits touch unrelated files and the merge-tree is clean, so I left it.
- claude APPROVE. One item was taken: the ScrollDismiss `afterEach` now runs `cleanup`/`useRealTimers` in a `finally`, so a tripped
  drain assertion can't leak fake timers into the next test (d305c40). Two were declined:
  - "Use Part of #290": the triage made #290 frontend-only, with the api half in #292.
  - "File the thread-get-contract flake": the architect already forwarded it to main for #292.
