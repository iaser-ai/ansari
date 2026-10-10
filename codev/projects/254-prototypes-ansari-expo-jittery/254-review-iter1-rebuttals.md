# Rebuttal: PR review, iteration 1 (PIR #254)

All feedback was accepted. Nothing is disputed. Fixes are in `de9ebd7` (code and tests) and the following commit (arch note).

## Codex: REQUEST_CHANGES

**A late player failure doesn't fall back to the poster.** Accepted; it was a real defect.

- **Change:** failure is now latched in `AmbientVideoPlayer` (`failed`, set on `status === 'error'`).
  - `running = ready && primed && !failed`, and `live` uses `!failed`.
  - A clip that fails after arriving drops to opacity 0 and the poster carries the layer.
  - A clip that failed mid-warm-up never reports ready, even after the buffer wait primes it.
  - The layer stays shown on `'failed'`.
- **Tests:**
  - `never shows a clip that failed mid-warm-up, even once the buffer wait primes it`
  - `hides the video again, leaving the poster, when it fails after arriving`
  - Both fail on the pre-fix code.

## Claude: COMMENT

1. **There's no arrival deadline (Low Power Mode leaves even the poster invisible).** Accepted.
   - Added `ARRIVAL_DEADLINE_MS` (`BUFFER_WAIT_MAX_MS + 2000`, counted from asking for the clip). If the player hasn't settled by then, the poster arrives alone in the same fade.
   - The `pointerdown` retry stays armed while the clip has never played and hasn't failed, so a later tap can still start it on the poster's own frame.
   - Test: `brings the poster in by the deadline when the clip never loads`, including the tap rescue. It fails on the pre-fix code.
2. **The `onFail` test passed through the success path.** Accepted. `FakePlayer.play()` is now a no-op once failed (and for an inert player), and the test asserts the video host stays at opacity 0, past the buffer wait.
3. **No remount on a source change.** Accepted: `key={source}` on the player.
4. **Render-phase ref writes opt the player out of the React Compiler.** Accepted. The player takes `onSettle` and the parent passes its stable `setClip` setter, so the refs are gone.

## Gemini: COMMENT

The reviewer was skipped because the `agy` CLI isn't installed; there is no feedback to address.

## Verification

- `tsc --noEmit`: clean.
- Prototype `vitest run`: 44 files, 606 tests pass. `AmbientVideo.test.tsx` has 12 tests.
- All three new failure-path tests fail against the pre-fix component.
