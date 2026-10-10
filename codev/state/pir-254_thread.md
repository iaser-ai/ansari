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

## dev-approval round 1 — FAILED on a real iPhone (light + dark)
- Architect tested on a real iPhone: still jittery in both modes. This rules out the dark-mode blend as the cause, and shows the Simulator's rVFC cadence is not evidence for this class of bug (its video goes through the Mac's decode and compositing path).
- The phone's developer tunnel is down (last connected 2026-06), so I can't attach Safari Web Inspector. Instead I built a self-reporting harness, served on one port (scratchpad, not committed): `/diag` runs 5 isolated cases (old 0.727x / new 1.0x / new + drift / drift over a still poster / old + drift), and `/` serves the production web export with a probe injected. A `/dev-on` cookie routes to the Metro dev server with the same probe, to separate dev overhead from the fix. Every page POSTs its rAF + requestVideoFrameCallback timings back. Asked the architect for screen recordings too, since the compositor-only drift can't be measured from JS.
- Waiting on real-device numbers before touching code or re-requesting dev-approval.

## dev-approval round 1 follow-up — real-device findings, arrival rework
- The phone finally reached the harness once the Mac stopped hopping networks (its address changed 4 times across the session; LAN testing was blocked until then).
- Real iPhone (iOS 18.7, Safari 27): video cadence is even at 1.0x and uneven at 0.727x, as predicted, but by eye both the isolated cases and a blind A/B of production builds looked about the same. The visible problem was the ARRIVAL: three stages (poster fade, video fade, abrupt start of motion) running JS-driven while the page was still loading.
- The reviewer approved the arrival rework and keeping the clip change. The arrival is now a single CSS-transition fade once everything is ready, with the clip already moving. AMBIENT.videoIn removed; layerIn raised to 1200 ms; settle waits for fonts, with a 250 ms fallback on Safari (no rIC).
- Test gotcha: with Reanimated mocked, react-native-web reads a numeric transitionDuration as px. Pass explicit 'NNNms' strings.

## Review phase
- dev-approval approved after a blind A/B on the phone (the reviewer picked the new build: "arrives smoother, one clean fade").
- Review written. Arch: cold paragraph plus a hot map wording change. Lessons: cold section; the hot "real user path" lesson sharpened rather than added (cap 10); the #225 map entry merged with #254 (map cap 12). The Simulator advice in the #202/#245 lesson is now scoped to layout and input in both tiers.
- PR targets develop (origin/HEAD), not main as porch's template default says.
