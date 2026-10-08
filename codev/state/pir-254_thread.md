# pir-254 thread — jittery ambient shadow on mobile (#254)

## Plan phase
- Found the documented "ramps never reach the rate" anomaly is a React deps bug: the breath-cycle effect in `AmbientVideo.tsx` gates on `running` but omits it from deps, so the ticker never starts (web AND native) except after a background→foreground round trip. Readers have always seen constant 0.727x playback.
- Live jitter cause (hypothesis, to be measured with requestVideoFrameCallback): 0.727x of a 30fps file ≈ 21.8 fps on 60 Hz → uneven 3/2 refresh cadence + timeline resampling.
- Plan: retime clips by 11/8 (minterpolate), play at exactly 1.0x, delete the breath ticker. Same on-wall speed; #225 opacity/grade untouched. Dark-mode blend measured but not changed.

## Implement phase
- Measured before touching assets (rVFC probe page, iOS-Simulator Mobile Safari, 60 Hz): old clip at 8/11 → 234 frames held 3 refreshes / 27 held 2 (~21.8 fps, uneven); same clip at 1.0 → 352/354 held exactly 2. Night (multiply + filter) showed no extra drops in the Simulator — not representative of a phone GPU, so still worth a real-device look.
- Retimed all four clips by 11/8 with `minterpolate` over a doubled copy, cut at 341 frames (~11.37 s, 30 fps). SSIM vs originals at matching timestamps 0.992 / 0.995; frame 0 still matches the posters.
- Surprise: single-pass VP9 at the old bitrates made a visible keyframe jump at the desktop WebM wrap (1.82 vs 0.83 mean-abs step). Two-pass fixed it (0.85). MP4 wrap step equals the shipped original's (codec noise, not motion).
- Stale doc found: the comment claimed the portrait WebM is VP9 Profile 1 / 4:4:4; both WebMs were already Profile 0. Comment corrected.
- Breath ticker deleted; rate set once to 1.0. New `AmbientVideo.test.tsx` (4 tests) negative-tested: fails on the old code and on old-code-with-the-dep-fixed.
- Tests: act() only re-renders at its end, so fake-timer advancing had to step in 10 ms increments or the 600 ms video-wanted timer was never registered.
- Real app check: headless Chrome over CDP shows the served clip is the 11.37 s one at rate 1, playing, zero rate writes in 8 s; Simulator screenshots show the shadow moving.
