# air-226 thread — citation auto-scroll clearance (#226)

- Fix lives in shared `SourceStack.bringIntoView`, so panel and sheet both get it.
- Clearance = the column's own resting `paddingTop`, read from `contentStyle` via `StyleSheet.flatten`
  (panel 22px, sheet 12px), rather than a new constant — a tapped source now lands exactly where the
  first leaf rests, and the first source maps to scroll 0. Falls back to `LEAF_SHADOW_REACH.above`
  when the padding is not numeric.
- Extracted as pure `stackScrollTarget(offset, contentStyle)`; unit-tested (5 cases). The scroll call
  itself is not render-tested (would need reanimated + folio rendering under jsdom).
