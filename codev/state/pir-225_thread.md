# pir-225 thread

## Plan phase (2026-10-06)
- Session crashed at startup before any work; resumed after architect check-in.
- Key finding: in nightGrade(), NIGHT_STRENGTH cancels out of the page multiplier for every source value in [frond, wall] — m(v) = 1 − (1−D)(wall−v)/(wall−frond). Darkness at night is NIGHT_DEPTH alone; S only keeps the `min` tail off the 0-clamp.
- Proposal: DAY 0.3→0.345; NIGHT_DEPTH 0.58→0.517; NIGHT_STRENGTH 0.6→0.7 (needed ≥0.61 to avoid crushing portrait min).
- Conflict flagged for human: 15% deeper at night puts the frond mass at/below night.well, and the well test (deepest > 0.45) must be retuned to 0.38. Fallback D≈0.55.
- Ungraded path (iOS, Android 29–30) is already at opacity 1; not darkenable via constants → follow-up issue.

## Implement phase (2026-10-06)
- Architect approved the recommendation: full 15% at night, well bound 0.45→0.38.
- Applied DAY 0.345, NIGHT_DEPTH 0.517, NIGHT_STRENGTH 0.7. Doc comments rewritten: NIGHT_STRENGTH is not a darkness knob.
- nightGrade() got an optional `strength` param (defaults to NIGHT_STRENGTH) so a test can pin S-invariance against the real function, not a re-derivation.
- Negative-tested: S=0.6 fails the crush test; the old 0.45 bound fails portrait; a grade that ignores strength fails the new invariance test. All restore green.
- typecheck clean, 389/389 tests pass.
- Ungraded follow-up filed: #229.

## Dev-approval feedback (2026-10-06)
- Reviewer: day shadow looked unchanged. Measured: 0.3→0.345 moved frond-vs-wall contrast only 5.1→5.9 L* on stone-200 paper (<1 L*, invisible on a soft moving texture). Raised DAY_STRENGTH to 0.4 (~6.8 L*).
- Dev-server gotcha: the 8225 server was launched with CI=1 (Metro "CI mode, reloads are disabled"), so it kept serving stale code after edits. Restarted without CI. Verify served values by grepping the bundle, not by trusting the tab.
