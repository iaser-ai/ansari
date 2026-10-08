# pir-254 thread — jittery ambient shadow on mobile (#254)

## Plan phase
- Found the documented "ramps never reach the rate" anomaly is a React deps bug: the breath-cycle effect in `AmbientVideo.tsx` gates on `running` but omits it from deps, so the ticker never starts (web AND native) except after a background→foreground round trip. Readers have always seen constant 0.727x playback.
- Live jitter cause (hypothesis, to be measured with requestVideoFrameCallback): 0.727x of a 30fps file ≈ 21.8 fps on 60 Hz → uneven 3/2 refresh cadence + timeline resampling.
- Plan: retime clips by 11/8 (minterpolate), play at exactly 1.0x, delete the breath ticker. Same on-wall speed; #225 opacity/grade untouched. Dark-mode blend measured but not changed.
