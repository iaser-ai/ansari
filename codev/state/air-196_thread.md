# air-196 thread — 'View N more' fold toggle too small

- Branch was cut before #195 (which added FootnoteGroup) merged; merged origin/develop first.
- Toggle extracted as exported `FootnoteToggle` so it can be rendered in isolation under jsdom/react-native-web.
- Fill: `colors.secondary` (the app's named "quiet fill" for every soft filled shape, e.g. suggestion chips), lifting to `card` on hover/press like the chips. Not `primary` (the ink block is reserved for the primary action). 44pt min height, RADIUS.xl, no underline, chevron kept in accent.
- Found: react-native-web 0.21 ignores `accessibilityState`, so `expanded` never reached the web DOM. Added `aria-expanded` alongside (same pattern as pills' `aria-hidden`).
- Dropped the old hitSlop: the drawn box is now the 44pt target.
- Negative-tested: the old styling fails the two style tests; restored passes. Not visually checked on device/web (needs a staging answer that folds).
