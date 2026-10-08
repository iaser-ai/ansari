# PIR Plan: Smooth the ambient palm shadow on mobile

## Understanding

The ambient palm-shadow layer (`prototypes/ansari-expo/components/AmbientVideo.tsx`) looks jittery on a phone. The issue's leading hypothesis is that the JS-thread `setInterval(tick, 100)` "breath" ramp writes `player.playbackRate` 20–26 times per ramp, and each write forces a resync. The issue also points at an anomaly the code already documents (`AmbientVideo.tsx:739-751`): measured in a browser, the clip runs at one constant rate and the ramps never reach it.

### Root cause of the anomaly: the breath cycle never starts

The anomaly is a React dependency bug, not a browser quirk.

- The breath-cycle effect bails out unless `running` is true: `if (!live || !foreground || !running) return;` (`AmbientVideo.tsx:736`).
- `running` is **missing from its dependency array**: `}, [live, foreground, player]);` (`AmbientVideo.tsx:831`). There is no `eslint-disable` here; the omission is unflagged.
- `running` starts `false` (`:724`) and flips to `true` only at the end of the fade-in (`:876`). By then `live` and `foreground` have already settled:
  - On web, `live` is `status !== 'error'` (`:675`), which stays `true` through the loop-wrap status flicker.
  - On native, `live` is the latched `ready`.
- So the effect ran once while `running` was still `false`, returned early, and never runs again. No ticker is ever created, and `playbackRate` is never written after setup.
- The clip still plays because the watchdog (`:841-851`) sees `wantPlaying && !isPlaying` and calls `play()`. The rate it plays at is the one set in the `useVideoPlayer` setup: `p.playbackRate = CREEP_RATE` (`:621`), which is 8/11 ≈ 0.727×.
- The one exception is a background → foreground round trip. That flips `foreground`, re-runs the effect with `running === true`, and only then does the breath (and its ramps) actually begin.

This bug is on both web and native. It has been there since the Replit port (`a7b20a7`), so in practice the "breath" has never been part of what readers see.

### What a reader actually sees, and why it judders

In practice the layer is a **constant 0.727× playback of a 30 fps file**, which is ~21.8 source frames per second. On a 60 Hz phone each source frame is held for 60 / 21.8 ≈ 2.75 refreshes. That has to round to an uneven 3-3-3-2 / 3-3-2… cadence, so the motion speeds up and slows down a little several times a second. That is judder, and on a slow, smooth wash it is easy to see. The file's own notes already name the cure: at 1.0× "the browser presents all 30 of the file's frames per second and never resamples the timeline" (`:159-162`), which gives a clean 2-2-2 cadence at 60 Hz (and 4-4 at 120 Hz). A rate other than 1 also makes mobile Safari and Chrome resample the media timeline, which drops or repeats frames on top of that. Neither cost shows up on a fast desktop, or at a 1.0× rate.

So the issue's leading hypothesis (ramp writes causing resyncs) is close, but the ramps it blames never run. The live cause is the **non-1.0 playback rate** itself. The constant `playbackRate` that the breath code assumed was temporary turns out to be permanent.

The dark-mode secondary hypothesis (multiply blend + `filter` over live video, `lib/ambientNight.ts`) is plausible as an extra cost, but it can't explain a day-mode report. I'll measure it (see Test Plan) and only change it if the numbers point there. See Risks.

## Proposed Change

**Bake the speed into the file and play it at exactly 1.0×, with no `playbackRate` writes at all.** This sidesteps the mechanism instead of reducing its symptom, and it keeps the look readers have actually signed off on.

1. **Measure first (diagnostic, not shipped).** Before touching the clips, put a throwaway `requestVideoFrameCallback` probe on the running `<video>`. It logs presented-frame intervals and `mediaTime` deltas. Run it in iOS-Simulator Mobile Safari and desktop Chrome under three conditions: (a) current build, (b) the same build forced to rate 1.0, (c) dark mode. The result confirms or refutes the cadence hypothesis before any assets are re-encoded. If it refutes it, I stop and report back at this gate's level rather than ship the retime on a guess.

2. **Retime the four clips by 11/8 with motion interpolation**, the same procedure the file documents for the previous 20/11 retime (`:138-156`):
   - `ambient-shadow.{mp4,webm}` and `ambient-shadow-desktop.{mp4,webm}`.
   - Run `minterpolate` over a doubled copy, cut at one loop's worth of frames, and keep 30 fps.
   - MP4 stays H.264 Main @ L4.0 (`avc1.4D4028`, which `webPrefersMp4` probes for). WebM stays VP9 with the same profile and pixel format as today.
   - The loop goes from ~8.3 s to ~11.4 s. At 1.0× the shadow moves across the wall at exactly today's on-screen speed (0.727 × 8.3 s of motion spread over 11.4 s), with every presented frame a real source frame.
   - Posters are unchanged, because the retime keeps frame 0.
   - The ffmpeg commands go in a short `scripts/retime-ambient.sh` (or a comment block) so the next re-export can be reproduced. ffmpeg is installed via Homebrew for this; it is not a project dependency.

3. **Delete the breath cycle.** In `AmbientVideo.tsx`:
   - Remove `DRIFT_RATE`, `CREEP_RATE`, the four phase durations, `TICK_MS`, `RATE_EPSILON`, `smoothstep`, and the ticker effect (`:732-831`).
   - The player setup sets `p.playbackRate = 1` once, explicitly, so a browser default can never differ.
   - The `running` state stays, because it still gates when `play()` is wanted after the fade (`wantPlaying`). The effect that starts playback on `running` lists `running` in its deps.
   - Rewrite the block comment at `:119-201` to explain the new arrangement, why rate ≠ 1 judders, and the retime ratio. Drop the "not yet known" anomaly note at `:739-751` and replace it with the dependency-bug explanation.

4. **Re-check the masking drift's beat rule.** `MASK_PERIOD_MS = 27000` was chosen to stay clear of the 16.6 s breath and the 8.3 s loop (`:233-242`). The breath goes away, and 27 s / 11.4 s ≈ 2.37 loops, which is still clear of a whole or half multiple. I'll update the comment's numbers and keep the value unless the new loop length lands near a multiple.

5. **Dark mode: no change unless step 1 shows it.** If the night path drops noticeably more frames than day with the rate fix in, I bring that measurement back as a follow-up issue instead of growing this one. Changing the blend or grade would reopen the #225 tuning.

### Why not just add `running` to the deps?

That would make the breath run as designed. But it would turn on the very ramps the issue suspects (100 ms JS-thread ticks, live `playbackRate` writes during mobile decode). It would also add a 1.0× drift pass that no reviewer has ever seen, because the bug hid it. It fixes the anomaly and makes the jitter worse.

## Files to Change

- `prototypes/ansari-expo/assets/video/ambient-shadow.mp4`, `ambient-shadow.webm`, `ambient-shadow-desktop.mp4`, `ambient-shadow-desktop.webm`: re-encoded, retimed by 11/8, 30 fps.
- `prototypes/ansari-expo/components/AmbientVideo.tsx`:
  - `:119-201`: the breath constants and comment are replaced by the retime and rate note.
  - `:279`: `smoothstep` removed.
  - `:609-622`: setup sets `playbackRate = 1`.
  - `:732-831`: the ticker effect is replaced by a small "play once running" effect with correct deps.
  - `:233-242`: the beat-rule comment is updated.
- `prototypes/ansari-expo/scripts/retime-ambient.sh` (new, small): the reproducible ffmpeg retime.
- `prototypes/ansari-expo/components/AmbientVideo.test.tsx` (new, see Test Plan).
- `codev/resources/arch.md` (prototype chat display: ambient layer) and `lessons-learned.md`: one entry each at review time.

## Risks & Alternatives Considered

- **Risk: interpolation artifacts** (smearing or ghosting on the fronds). Mitigation: it's a blurred, low-opacity wash, the same technique was already used once on these clips, and I'll compare frame grabs side by side before committing. If `minterpolate` artifacts are visible, fall back to `mi_mode=blend` (cross-fade interpolation), which can't warp shapes.
- **Risk: generation loss.** There is no master in the repo, so the retime runs on already-compressed files. It's a soft wash. I'll keep the bitrate similar to today's and eyeball the result against the current clip.
- **Risk: bigger files.** About 37% more frames: roughly 140 KB → ~190 KB for the MP4. That is still trivial, and the data-saver path (`connectionAllowsVideo`) is unchanged.
- **Risk: changing the look.** The on-wall speed equals the current speed, so the visible pace is preserved. Opacity, blend and grade (#225) are not touched. What does change: the breath that was designed but never actually ran is removed rather than switched on. If the reviewer *wants* the breath, that is a separate visual change to sign off on, ideally done without `playbackRate`, e.g. as two pre-rendered segments.
- **Alternative: add `running` to the deps.** Rejected above: it enables the suspected jitter source.
- **Alternative: set rate 1.0 without retiming.** It's smooth, but the shadow moves 1.375× faster than what readers have seen. That breaks "preserve the look".
- **Alternative: drive the ramp from a Reanimated worklet.** That moves the timer off the JS thread, but every `playbackRate` write is still a media-pipeline resync on the main or media thread, and the constant non-1.0 cadence problem remains. It treats the wrong layer.
- **Alternative: animate via `currentTime` seeks.** Seeks on mobile are far more expensive than rate changes. Rejected.

## Test Plan

- **Unit (vitest, jsdom, `expo-video` + reanimated mocked as in existing component tests):** render `AmbientVideo`, drive the player mock through ready → buffered → primed → fade, and assert:
  - `playbackRate` is 1 and is **never written** after setup. A setter spy counts zero writes across a simulated 60 s with fake timers.
  - `play()` is called once `running` flips, without needing a foreground toggle. This is the regression test for the dependency bug: it fails on today's code if the ticker is restored with the old deps.
  - No `setInterval` remains active after the fade, apart from the bounded buffer poll.
- **Asset check:** `ffprobe` each re-encoded clip and record codec/profile/level, pix_fmt, 30 fps, frame count, and duration ≈ 11/8 × the old one, in the review. Also confirm that frame 0 still matches the poster (the fade-in depends on it).
- **Measured cadence (the real evidence):** using the step-1 `requestVideoFrameCallback` probe on before and after builds, in iOS-Simulator Mobile Safari (per the #202/#245 lesson; headless Chrome is no proxy for a phone) and desktop Chrome. Report the presented-frame interval distribution: today should show a 2/3-refresh mix, after should show uniform 2-refresh holds at 60 Hz. Also report the same pair in dark mode.
- **Manual (reviewer, at dev-approval) — a real phone is the acceptance bar.** Open the worktree's dev server from a phone on the LAN and sit on the empty home screen for ~30 s in light mode and again in dark mode.
  - Expect: the shadow drifts at the same pace as before, with no rhythmic stepping and no speed surges.
  - Background the tab, return, and check it still plays and stays smooth (this is the path that used to switch the ramps on).
- **Cross-platform:** iOS / Android native use the same MP4 and the same rate-1.0 path. If a simulator or emulator is available I'll run a quick smoke check that it plays and loops without a hitch at the wrap. Desktop web is checked against the landscape clip.
