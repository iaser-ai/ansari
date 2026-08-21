# Ansari performance baseline

Measured 2026-07-23 on the web preview (dev build), React `<Profiler>` around
the chat screen plus a render counter on `AnswerMessage`, driving the core
ask → answer flow (`/chat/[id]?q=…` auto-send).

## Baseline (after design pass)

| Metric | Value |
|---|---|
| ChatScreen mount commit | 11.8 ms |
| Commits during ask → answer | 9 |
| Heaviest commit (answer arrival) | 14.3 ms |
| AnswerMessage renders per answer | 2 (mount + query refetch commit) |

## Interpretation & decisions

- Every commit is under the 16 ms frame budget; there is no re-render
  cascade (the answer component renders once on mount and once when the
  conversation query refetches — expected with invalidate-on-success).
- Lists are short (messages, conversations) and already virtualized with
  `FlatList`; no list-config change is justified by measurement.
- **React Compiler:** the babel plugin was installed but never wired into
  `babel.config.js`. Profiling shows no cascading re-renders for it to
  eliminate, so the dependency was removed rather than enabled. Revisit
  only if a future measurement (e.g. after streaming answers) shows
  wasted renders.

## How to re-measure

Wrap the chat screen in `<Profiler id="ChatScreen" onRender={...}>`,
add `console.count` to suspect components, open
`/chat/<id>?q=<question>` in the web preview, and read the browser
console. Compare against the table above.

## Sunlit-paper pass (2026-07-23)

- Film grain is a single 8.5 KB tiled PNG (96px) — static, no filters,
  no per-frame cost; CSS `background-repeat` on web, `resizeMode="repeat"`
  natively.
- No new JS-thread work per frame was added; the chat-screen baseline
  above is unaffected (composer and screens re-render on the same events
  as before).
- Interaction pass (2026-07-23): composer bottom padding follows the
  keyboard via `useReanimatedKeyboardAnimation` progress (UI-thread
  interpolation, no JS keyboard listeners).
- Header material (2026-07-24): the chat header is now one uniform frosted
  bar (`HeaderBar`) — a single static blur surface, replacing the earlier
  stacked BlurViews + Android scrim. iOS: system chrome material
  (UIVisualEffectView, never masked — masking disables it). Android: real
  blur-behind via expo-blur's Dimezis renderer (RenderEffect on 12+); cost
  is bounded — one bar-sized region, radius 25 (intensity 100 /
  blurReductionFactor 4) — and the on-device smoothness check rides the
  Task 12 hardware pass. Web: CSS `backdrop-filter`, compositor-only; the
  filter must sit on the floating wrapper itself (see the note in
  `HeaderBar.tsx`) because a nested BlurView's backdrop-filter samples an
  empty stacking context and silently no-ops. Zero JS-thread per-frame
  cost on all three platforms.
- Palm shadow (2026-07-24): removed at the user's direction (artwork did
  not meet the bar). It shipped as deferred-mount pre-blurred rasters with
  a transform-only drift loop; nothing ambient animates on the home screen
  now, so there is no per-frame cost to re-verify.
