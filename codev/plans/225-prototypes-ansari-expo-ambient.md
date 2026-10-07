# PIR Plan: Ambient palm-shadow ~15% darker

## Understanding

The drifting palm-frond shadow behind the empty chat screen is too faint. The request is to make it about 15% darker. How dark it gets is set by constants in `prototypes/ansari-expo/lib/ambientNight.ts`. `components/AmbientVideo.tsx:412-483` only applies the treatment that module returns: it sets the layer's opacity, and at night it also sets `mixBlendMode: multiply` and the optional `filter`.

There are three render paths, and each one darkens by a different mechanism:

| Path | Where | Composite | Knob |
|---|---|---|---|
| Day | everywhere | source-over at `DAY_STRENGTH` (`:116`), no blend | linear opacity |
| Night, graded | web, Android ≥ 31 | `nightGrade()` levels stretch → multiply at `NIGHT_STRENGTH` | `NIGHT_DEPTH` (see below) |
| Night, ungraded | iOS, Android 29–30 | raw clip, multiply at `NIGHT_STRENGTH_UNGRADED = 1` | none left |

I define "15% darker" as **15% more shadow depth**: the gap between the page and the shadowed page (`1 − multiplier` at night, `α·(page − source)` by day) grows by a factor of 1.15. This is the quantity that controls how visible the fronds are, and it is the same definition on all three paths.

### Day: linear, so ×1.15 directly

Day composites source-over: `out = page·(1−α) + α·v`. The darkening at any source value `v` is `α·(page − v)`, which is linear in `α`, and the frond-to-wall contrast `α·(wall − frond)` is linear in `α` as well. So `DAY_STRENGTH` 0.30 → **0.345** gives exactly 15% more shadow everywhere in the frame, with no other coupling.

### Night, graded: `NIGHT_STRENGTH` alone changes nothing visible

The issue suspected that raising `NIGHT_STRENGTH` alone would only reshape the midtones. It is stronger than that: **between the wall and the frond anchor, the rendered output does not depend on `NIGHT_STRENGTH` at all.**

`nightGrade()` (`:206-217`) builds an affine map `g` that sends `wall → 1` and `frond → floor`, where `floor = 1 − (1 − D)/S` (`:208`). The page multiplier is `m(v) = 1 − S·(1 − g(v))`. Because `g` is affine between the anchors:

```
1 − g(v) = (1 − floor) · (wall − v)/(wall − frond)
         = ((1 − D)/S) · (wall − v)/(wall − frond)
⇒ m(v)   = 1 − (1 − D) · (wall − v)/(wall − frond)
```

`S` cancels. Every source value in `[frond, wall]` lands at the same multiplier whatever `NIGHT_STRENGTH` is, and that range covers 99.5% of the frond pattern. I checked this numerically against `pageMultiplier()` (which models the browser's clamps): the frond and midtone multipliers are identical at S = 0.6, 0.65 and 0.7. `NIGHT_STRENGTH` only matters below `frond`, where the darkest half-percent (`min`) is extrapolated toward the filter's 0-clamp.

So **the knob is `NIGHT_DEPTH`**. To get 15% more depth, `1 − D` goes from 0.42 to 0.42 × 1.15 = 0.483, which gives **`NIGHT_DEPTH` 0.58 → 0.517**. That scales the whole curve by the same factor, because `1 − m(v)` is proportional to `1 − D` for every `v` in range.

`NIGHT_STRENGTH` still has to move, for a different reason. A deeper `D` lowers `floor`, and the portrait clip's `min` tail extrapolates past it:

| D | S | portrait floor-relative `min` (graded) | test needs |
|---|---|---|---|
| 0.58 | 0.60 | 0.140 | > 0.02 |
| 0.517 | 0.60 | **0.011** (crushes — fails `:199`) | > 0.02 |
| 0.517 | 0.65 | 0.087 | > 0.02 |
| 0.517 | **0.70** | **0.152** (about the current margin) | > 0.02 |

Raising S raises the floor, which puts headroom back under the tail without changing anything in `[frond, wall]`. The minimum is S ≈ 0.61. **0.70** brings the crush margin back to roughly today's level (0.15 vs 0.14), and it still leaves room below 1, which the `:100-104` doc comment asks for. Brightness stays below 1 on both clips (portrait 0.660, landscape 0.615), so the `:164` "brightens nothing first" test still holds.

Resulting multipliers (unchanged → proposed):

| | portrait | landscape |
|---|---|---|
| frond mass | 0.580 → 0.517 | 0.580 → 0.517 |
| midtone | 0.790 → 0.759 | 0.790 → 0.759 |
| core (`min`) | 0.484 → 0.407 | 0.571 → 0.506 |

### ⚠ Design consequence that needs a human call: the shadow core goes past the well

The current `NIGHT_DEPTH` was chosen as "about as far as the page can travel" (`:84-96`): `night.well` (#0A0908) is only 0.53–0.57× `night.page` (#13100E), and 0.58 puts the frond mass just above it. At 0.517 the frond mass sits **at or slightly below the well**, and the portrait core (0.407) goes clearly past it. **"15% darker at night" is not achievable while keeping the shadow above the well.** The two requirements conflict.

The `:171-187` test enforces that floor (`deepest > 0.45`), and it fails at the proposed values (portrait 0.407). Its other guard, the crush check at `:189-200`, still passes comfortably. So the shadow gets darker but keeps its internal detail; it just goes deeper than the "floor of the room".

**My recommendation:** apply the full 15% at night (D = 0.517, S = 0.70). Lower the "well" bound from 0.45 to **0.38**, so it still catches a regression toward black (portrait core 0.407, landscape 0.506), and rewrite the test and doc comments to state the new intent. The issue explicitly asks for more visibility, and the crush test is the guard that protects legibility.

**Alternative if the reviewer wants to keep the well as a hard floor:** leave night alone, or make a partial bump (for example D ≈ 0.55, about 7% deeper, which keeps the portrait core around 0.45). In that case only day gets the full 15%. Please choose at plan-approval; the default below is the recommendation.

### Night, ungraded (iOS, Android 29–30): not reachable via these constants

`NIGHT_STRENGTH_UNGRADED` is already 1 (max opacity). Multiply at opacity 1 gives `m = v`, so the multipliers are fixed by the source (portrait wall 0.894, frond 0.706). No constant in this module can darken this path further. A filter is not an option either: iOS honours only `brightness()`, which dims the wall and fronds alike (a page-wide dim, not more shadow), and `:139-143` documents that requesting a filter on iOS fights the layer's fade animation. The real fix would be a separate, contrast-stretched copy of the clip for ungraded platforms. That means new video/poster assets, so it is **out of scope here; I'll file it as a follow-up issue**.

## Proposed Change

1. `DAY_STRENGTH` 0.3 → 0.345.
2. `NIGHT_DEPTH` 0.58 → 0.517, and `NIGHT_STRENGTH` 0.6 → 0.7.
3. Update the doc comments so the code says why: the `NIGHT_DEPTH` comment (the well is no longer the floor; the depth figures change), the `NIGHT_STRENGTH` comment (state plainly that S does not affect anything between wall and frond, and that it exists to keep the `min` tail off the clamp), and the `DAY_STRENGTH` comment.
4. Retune the test at `lib/ambientNight.test.ts:186`, `0.45 → 0.38`, and rewrite its rationale comment.
5. Add one test that pins the finding above: for each clip, `pageMultiplier` at the wall/frond midpoint is the same for two different strengths. This stops a future retune from reaching for `NIGHT_STRENGTH` to change darkness.
6. File the ungraded-path follow-up issue and link it from the PR.

## Files to Change

- `prototypes/ansari-expo/lib/ambientNight.ts:84-116`: constants and their doc comments.
- `prototypes/ansari-expo/lib/ambientNight.test.ts:171-187`: well bound and comment. A new `S`-invariance test goes in the "grade hits the tones" block.
- No change to `components/AmbientVideo.tsx`.

Other assertions the issue flagged, re-verified at the proposed values:

- `:199` crush check: 0.152 / 0.295 > 0.02. Passes.
- `:209` ungraded wall `m > 0.85`: unaffected, since the ungraded path is unchanged.
- `:224` `raw > NIGHT_DEPTH`: 0.706 > 0.517 still holds, and with more margin than before.

## Risks & Alternatives Considered

- **Risk: the night shadow now drops below `night.well`.** The deepest fronds could read as holes rather than shade. Mitigation: the crush test keeps tonal detail, and the dev-approval visual check in dark mode covers how it looks. If it is too heavy, D = 0.55 is a one-line fallback.
- **Risk: on the ungraded platforms (iOS, Android 29–30) night mode will not change.** This is stated openly and gets a follow-up issue rather than a workaround.
- **Alternative: define "15% darker" as a 15% bigger L* drop.** At night that needs D ≈ 0.505, which is even further past the well. I rejected it: on a near-black page, L* deltas are a fraction of a unit and do not make a useful handle, and the multiplier-depth definition matches what the code already reasons in.
- **Alternative: raise `NIGHT_STRENGTH` alone, as the issue considered.** Rejected: as shown above, it is a provable no-op on 99.5% of the frame.

## Test Plan

- Unit: `npx vitest run lib/ambientNight.test.ts` passes, including the retuned well bound and the new S-invariance test.
- Unit, negative check: temporarily set `NIGHT_STRENGTH` back to 0.6 with D = 0.517 and confirm the crush test fails. This proves the guard runs, then restore the value.
- Manual (web, light mode): open the empty chat screen. The fronds should be noticeably more present than on `develop`, while still a background texture.
- Manual (web, dark mode): toggle the system dark scheme. The shadow should be deeper and still show frond detail at its core, with no flat black patches and no lifted or grey film.
- Manual (desktop-width web): check the landscape clip in both schemes to confirm it still matches the phone clip's weight.
- Cross-platform: on iOS dark mode, expect **no change** (ungraded path, see the follow-up). On iOS light mode, expect the 15% day bump.
