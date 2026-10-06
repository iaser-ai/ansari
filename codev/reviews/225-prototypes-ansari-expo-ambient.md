# PIR Review: Ambient palm-shadow darker and more visible

Fixes #225

## Summary

The palm-frond shadow behind the empty chat screen was too faint to find. Light mode now draws it at `DAY_STRENGTH = 0.6` (was 0.3), and the graded night path (web, Android ≥ 31) at `NIGHT_DEPTH = 0.517` (was 0.58), with `NIGHT_STRENGTH = 0.7` (was 0.6). Working this out showed that `NIGHT_STRENGTH`, which the code documented as the night darkness knob, cancels out of the composite across the visible range. A new test now pins that. The ungraded night path (iOS, Android 29–30) cannot be darkened with these constants; that is follow-up #229.

## Files Changed

- `prototypes/ansari-expo/lib/ambientNight.ts` (+44 / -19)
- `prototypes/ansari-expo/lib/ambientNight.test.ts` (+21 / -7)
- `codev/plans/225-prototypes-ansari-expo-ambient.md` (+105 / -0)
- `codev/reviews/225-prototypes-ansari-expo-ambient.md` (new)
- `codev/state/pir-225_thread.md` (+20 / -0)
- `codev/resources/arch.md`, `codev/resources/arch-critical.md`, `codev/resources/lessons-learned.md`, `codev/resources/lessons-critical.md` (governance, below)

## Commits

- `84c9324` [PIR #225] Plan draft
- `ca3f06c` [PIR #225] Deepen ambient palm shadow ~15% by day and night
- `3093ab1` [PIR #225] Thread: implement phase notes
- `8af4a9a` Merge origin/develop into builder/pir-225 (29 commits, no conflicts)
- `87dc90f` [PIR #225] Raise day shadow to 0.4 after review: 0.345 was imperceptible
- `fe1395f` [PIR #225] Thread: dev-approval feedback notes
- `b31d6ca` [PIR #225] Raise day shadow to 0.5 after review: 0.4 still too faint
- `ae7d3bf` [PIR #225] Raise day shadow to 0.55 per review
- `f5a1f61` [PIR #225] Raise day shadow to 0.6 per review
- plus porch `chore(porch)` state commits

## Test Results

- `npm run typecheck` (prototype): ✓ clean
- `npm test` (prototype): ✓ 398 passed (27 files). `lib/ambientNight.test.ts` has 38 tests, 2 of them new: the strength-invariance test, once per clip.
- Negative checks, each of which fails as expected and passes again once restored:
  - `NIGHT_STRENGTH` back to 0.6 at the new depth fails the "keeps detail in the darkest fronds" test, because the portrait core crushes.
  - The old 0.45 well bound fails on the portrait clip.
  - A grade that ignores its `strength` argument fails the new invariance test.
- Porch `build` check: ✓, with the CI dummy envs loaded (`apps/*/.env.ci`). Without them it fails on apps/api env validation. That failure is pre-existing and environmental; see Lessons.
- Manual: the reviewer viewed the light-mode empty chat screen on web over four rounds (0.4 → 0.5 → 0.55 → 0.6) and accepted 0.6.

## Architecture Updates

- **COLD, `arch.md`, "Prototype chat display" section:** added an "Ambient palm-shadow layer (issue #225)" paragraph. It covers the three render paths, the fact that `NIGHT_DEPTH` (not `NIGHT_STRENGTH`) sets night darkness, and that the ungraded path is fixed by the source clip.
- **HOT, `arch-critical.md`:** extended the existing "Prototype chat display" map line with "or the ambient palm-shadow layer's strength/grade", so a future retune is routed to that paragraph. No new critical fact; this is prototype-local.

## Lessons Learned Updates

- **COLD, `lessons-learned.md`:** new section "Ambient shadow strength — prototype (issue #225)".
  - Size a perceptual change in ΔL*, not in percent of a constant.
  - Prove a documented knob actually moves the output before turning it.
  - The #204 stale-dev-server and local-build-env lessons recurred.
- **HOT, `lessons-critical.md`:** the map was at its 12-line cap. To make room for the new section, I merged the two citation/source map lines (#161 and #194) into one, since both cover answer sources. No hot lesson was added.

## Things to Look At During PR Review

- **Day ended at 0.6, not the planned 0.345.** The approved plan applied a literal ×1.15. In review that moved the frond-vs-wall contrast by under 1 L* (5.1 → 5.9) and could not be seen. The value was then raised in reviewer-directed steps to 0.6, about 10.2 L*.
  - `dev-approval` had already been recorded (`479119e`) before those rounds. The reviewer's acceptance of 0.6 was given in-pane, not through a second gate.
  - Night stayed at the planned 15% (depth 0.42 → 0.483). Past that, the near-black page leaves almost no room: D = 0.45 adds only about 0.3 L*.
- **`nightGrade(clip, strength = NIGHT_STRENGTH)`:** the new optional parameter exists only so the test can vary strength against the real function. Production calls are unchanged.
- **The shadow's core now goes past `night.well`.** The "bottoms out near the well" bound went from 0.45 to 0.38, as the architect approved: the well was a reference point, not an invariant. The crush test, which protects frond detail, is unchanged and has wide margin (0.152 vs > 0.02).
- **iOS and Android 29–30 in dark mode are unchanged.** That path is already at opacity 1, and the source clip sets its depth. See #229.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder pir-225 → **Review Diff**
- **Run dev**: `afx dev pir-225`. If 8081 is held by another checkout, run `npx expo start --web --port 8225 --clear` in `prototypes/ansari-expo` without `CI=1`.
- **What to verify**:
  - Light mode: the frond shadow is plainly visible on the empty chat screen, while still a background.
  - Dark mode (web): the shadow is deeper, with detail at its core and no flat black patches or grey film.
  - Desktop-width web: the landscape clip matches the phone clip's weight in both schemes.
