# PIR Review: Composer tap jumps the thread and sometimes needs a second tap (mobile web)

Fixes #202

## Summary

On mobile web, tapping the chat composer made the thread jump, and the field often needed a second tap. There were two causes, both downstream of the keyboard shim's synchronous shell shrink. That shrink is deliberate and stays unchanged.

1. **The second tap.** The thread list set `keyboardDismissMode="on-drag"`. react-native-web cannot detect a drag, so it dismisses the keyboard on *every* scroll event. The list's own scroll-to-foot therefore blurred the composer the reader had just tapped.
2. **The jump.** react-native-web's `onLayout` arrives a frame late. The screen painted one frame of the shortened list with its newest lines cut off, then snapped to the end, overshooting by up to 160px.

The fix sets `'none'` on web lists (the thread and, at the architect's request, the sidebar, which had the same defect). It also adds a synchronous `onShellResize` notification, so the thread hands back exactly the height it lost in the same frame as the reshape.

## Files Changed

- `prototypes/ansari-expo/app/chat/[id].tsx` (+59 / -9)
- `prototypes/ansari-expo/components/ScrollDismiss.test.tsx` (+47 / -0), new
- `prototypes/ansari-expo/components/Sidebar.tsx` (+5 / -2)
- `prototypes/ansari-expo/hooks/useKeyboard.ts` (+10 / -0)
- `prototypes/ansari-expo/hooks/useKeyboard.web.test.ts` (+199 / -0), new
- `prototypes/ansari-expo/hooks/useKeyboard.web.ts` (+43 / -6)
- `prototypes/ansari-expo/lib/keyboard.test.ts` (+28 / -1)
- `prototypes/ansari-expo/lib/keyboard.ts` (+28 / -0)
- `codev/plans/202-prototypes-ansari-expo-compose.md`, `codev/reviews/202-prototypes-ansari-expo-compose.md`, `codev/state/pir-202_thread.md`
- `codev/resources/arch.md`, `arch-critical.md`, `lessons-learned.md`, `lessons-critical.md`

## Commits

- `3d08cbf` [PIR #202] Plan draft
- `082ac84` [PIR #202] Stop web lists dismissing the keyboard on every scroll
- `0b2dcaf` [PIR #202] Tell listeners about a shell reshape before it paints; test the shim
- `e8030ca` [PIR #202] Keep the thread's foot in view in the same frame as the reshape
- `b1c4d19` [PIR #202] Thread: implement notes
- (plus porch state commits and the review commit)

## Test Results

- Prototype `vitest run`: ✓ 366/366 (17 new: 11 shim, 4 `keepFootInView`, 2 react-native-web dismissal pins).
- `tsc --noEmit` (prototype): ✓.
- Repo `build` (porch check): ✓, run with the committed `apps/*/.env.ci` dummies exported, the same way CI does. A forced, uncached `turbo run build` passed 4/4. Without those vars the `apps/api` Next build fails its Zod env validation (`USUL_API_TOKEN` and others). That is environmental and unrelated to this diff, which touches only `prototypes/ansari-expo`.
- Mutation check: moving the `onShellResize` notification before the forced reflow makes the ordering test fail. Restored afterwards.
- Manual: the human reviewer approved the running worktree at `dev-approval`. I don't know which devices they tested on.

## Architecture Updates

- **COLD, `arch.md`** ("Prototype chat display"): a new paragraph on the web keyboard. It records that the synchronous one-step reshape is deliberate (anti-iOS-pan), that `onShellResize` is the only before-paint hook and which writes fire it, that `keepFootInView` is used with an `onLayout` fallback, and that web lists must not use `keyboardDismissMode="on-drag"`.
- **HOT, `arch-critical.md`**: the map entry for "Prototype chat display" now also says to consult it for the keyboard shim, `onShellResize` and web `keyboardDismissMode`. No new critical fact: this is prototype-local, not system shape.

## Lessons Learned Updates

- **COLD, `lessons-learned.md`**: new section "Composer tap on mobile web — prototype (issue #202)". It covers:
  - react-native-web's `on-drag` dismisses on every scroll;
  - trace past the issue's suspect file before accepting its hypothesis;
  - RN-web `onLayout` arrives a frame late, so use a synchronous hook at the source of the change;
  - compensate a shrink by the height lost, not `scrollToEnd`;
  - how to test a module that listens at import time under jsdom;
  - `porch next` can advance state when you run it only to read instructions.
- **HOT, `lessons-critical.md`**: one map entry for the new section (10 of 12 topics). No new critical lesson, because these are prototype- and library-specific.

## Things to Look At During PR Review

- **`app/chat/[id].tsx`, the `holdFoot` / `onShellResize` effect.** On the web it reads the list's DOM scroll node (`getScrollableNode()`) for `clientHeight` and `scrollTop`. The subscription is made once and calls the latest `holdFoot` through a ref. After the listener handles a shrink it records the new height, so the late `onLayout` sees no change and does nothing.
- **Native behaviour changed slightly.** On a shrink while at the bottom, `onLayout` used to call `scrollToEnd`. It now calls `scrollToOffset(offset + lost)`, with the offset taken from `onScroll`, which is throttled to 100ms. If the reader is mid-fling that offset can be stale. `keyboardDismissMode` on iOS and Android is unchanged. Worth a native smoke test.
- **Mobile web loses drag-to-dismiss** on the thread and the sidebar. The keyboard's Done key and tapping outside the field still work. A real touch-drag dismissal (on `touchmove`) could be a follow-up if it's wanted.
- **The shim's synchronous shrink was kept on purpose.** The issue's hypothesis B (the mid-gesture layout shift causes the missed tap) didn't hold: `focusin` means the field is already focused. The blur came from the library.
- **`ScrollDismiss.test.tsx` tests react-native-web, not app code.** It fails, deliberately, if a future react-native-web release starts detecting drags. At that point `on-drag` could come back on the web.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder pir-202 → **Review Diff**
- **Run dev**: VSCode sidebar → **Run Dev**, or `afx dev pir-202`
- **What to verify**:
  - A long thread, scrolled to the bottom: tap the composer once. The keyboard comes up on the first tap, and the last lines stay just above the composer with no snap.
  - The same while an answer is streaming, and again right after sending.
  - Scrolled to the middle of a thread: tapping the composer leaves the content where it is.
  - Sidebar search: typing a filter that shortens the list keeps the search focused.
  - Desktop Chrome with iPhone device emulation reproduces most of this. On a real phone, try iOS Safari and Android Chrome.
