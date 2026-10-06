# pir-225 thread

## Plan phase (2026-10-06)
- Session crashed at startup before any work; resumed after architect check-in.
- Key finding: in nightGrade(), NIGHT_STRENGTH cancels out of the page multiplier for every source value in [frond, wall] — m(v) = 1 − (1−D)(wall−v)/(wall−frond). Darkness at night is NIGHT_DEPTH alone; S only keeps the `min` tail off the 0-clamp.
- Proposal: DAY 0.3→0.345; NIGHT_DEPTH 0.58→0.517; NIGHT_STRENGTH 0.6→0.7 (needed ≥0.61 to avoid crushing portrait min).
- Conflict flagged for human: 15% deeper at night puts the frond mass at/below night.well, and the well test (deepest > 0.45) must be retuned to 0.38. Fallback D≈0.55.
- Ungraded path (iOS, Android 29–30) is already at opacity 1; not darkenable via constants → follow-up issue.
