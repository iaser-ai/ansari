# air-200 thread — issue #200 (answer text not selectable on web)

- Fix as the issue prescribed: `AnswerMessage` seeds `selecting` with `Platform.OS === 'web'`, mirroring `ThreadQuestion`. Comment updated to say why web differs.
- Added `components/AnswerMessage.test.tsx` — the first component test under `components/` (vitest config already allowed it). Mocks `AnswerProse` as a probe of its `selectable` prop; flips `Platform.OS` to `ios` for the native case.
- Negative-tested: with the fix stashed, the web test fails and the native one passes.
- Not done: manual click-and-drag check in a browser; the test covers the prop handed to the prose, not DOM `user-select`.
- Merged origin/develop (#193/#195/#197/#199) per architect; no conflicts — develop still had `useState(false)`, so the diff vs develop remains the one line. vitest 349/349, tsc clean.
