# PIR Plan: Composer tap jumps the thread and sometimes needs a second tap (mobile web)

## Understanding

On a phone browser, tapping the chat composer (mid-stream or after) makes the
thread visibly jump, and the field sometimes doesn't take focus until a second
tap. Everything below is `prototypes/ansari-expo/`.

The issue names `hooks/useKeyboard.web.ts` as the primary suspect. It is where
the chain *starts*, but I traced both symptoms further, into the chat screen's
list and into react-native-web. The chain on a tap, with the reader at (or
within 160px of) the bottom of the thread:

1. `focusin` → `engage()` (`hooks/useKeyboard.web.ts:301-332`) shrinks the body
   shell in one synchronous step and forces layout. **This part is deliberate
   and stays.** The file's header (lines 40-48) records why: an eased or
   deferred reshape lets iOS decide the field is covered, and iOS then pans the
   whole app off the top of the screen. The issue's hypothesis B (the mid-gesture
   layout shift makes the tap miss) doesn't hold up here: `focusin` means the
   field *has* focus already, so the tap has landed.
2. The FlatList's container gets shorter. react-native-web delivers `onLayout`
   through a `ResizeObserver` and then `UIManager.measure`, which wraps the
   callback in `setTimeout(0)`
   (`node_modules/react-native-web/dist/exports/UIManager/index.js:32-35`). So
   the browser **paints one frame** of the short list with its content still at
   the old offset, which means the newest lines are clipped at the foot.
3. The list's `onLayout` (`app/chat/[id].tsx:742-754`) then sees `shortened &&
   atBottom` and calls `scrollToEnd({ animated: false })`. That moves the content
   up by the shrink **plus** however far the reader was from the end (up to the
   160px `atBottom` slack, `app/chat/[id].tsx:733`). **This is the visible jump
   (A):** content that stood still for a frame, then snapped.
4. **That programmatic scroll blurs the composer (B).** The list sets
   `keyboardDismissMode` to `'on-drag'` on every non-iOS platform, web included
   (`app/chat/[id].tsx:719-721`). On the web, react-native-web does not check
   for a drag. It calls `dismissKeyboard()` on *every* scroll event
   (`node_modules/react-native-web/dist/exports/ScrollView/index.js:244-246`, v0.21.3),
   and `dismissKeyboard` blurs the focused field
   (`modules/dismissKeyboard/index.js`). So the scroll from step 3 takes focus
   straight back off the field that was just tapped. `focusout` → `release()` 80ms
   later hands the room back (the shell eases open again), and the keyboard
   either never comes up or flashes and leaves. The next tap sometimes works
   because whether step 3 runs at all depends on the reader's offset and
   `atBottom` at that moment. That is why it's "sometimes".
5. When the first keyboard on a device lands at a different height than the
   guess, `settle()` (`hooks/useKeyboard.web.ts:367-415`) eases a correction
   about 700ms later. Each eased frame that shortens the list fires `onLayout`
   again, and each of those runs step 3 (and step 4) once more.

Streaming makes this worse without being a separate cause. The paced reveal
(`hooks/useRevealedText.ts`) grows the last row while steps 2-4 happen, so the
snap target moves under the reader. Once steps 2-4 are fixed, nothing scrolls
the list on a tap, so there's nothing left for the reveal to compound with.

`release()` resetting the write-dedupe sentinels (`writeShell('', '')`) is
correct: the shell really *is* cleared, and the next `engage` really does need
to write. It explains why the jump repeats on every tap after a blur, but it
isn't itself a defect, so I'm leaving it alone.

## Proposed Change

Three changes, each aimed at one link in the chain.

### 1. Stop the thread list blurring the composer on the web (fixes B)

`app/chat/[id].tsx:719-721`: on the web, set `keyboardDismissMode` to `'none'`.
Keep `'interactive'` on iOS and `'on-drag'` on Android, where the platform
really does check for a drag. On the web the prop can't do what its name says,
since react-native-web treats any scroll as a drag. A comment will record why,
so nobody "restores" it later.

Trade-off: mobile-web readers lose drag-to-dismiss on the thread. Mobile Safari
doesn't dismiss the keyboard on scroll natively either, and the keyboard's own
"Done" key and tapping outside the field still work. A real touch-drag dismissal
(on `touchmove`, not on `scroll`) could be added later if it's wanted. It is
not part of this bug.

### 2. Keep the thread still in the same frame as the reshape (fixes A)

Give the web shim a synchronous notification that the shell has been written:

- `hooks/useKeyboard.web.ts`: add an exported `onShellResize(listener): () =>
  void` (a subscribe that returns an unsubscribe). `writeShell` calls the
  listeners right after a write that actually changed something. In `engage`,
  it moves to *after* the forced reflow (`void document.body.offsetHeight`), so
  listeners can read the new geometry. `track()` runs in `requestAnimationFrame`
  and `settle()` runs its write synchronously, so a listener reached through
  either one also runs before the next paint.
- `hooks/useKeyboard.ts` (native): export a matching no-op `onShellResize`, so
  the screen can call it without branching on platform.
- `app/chat/[id].tsx`: on the web, subscribe in an effect. The listener reads
  the list's scroll node (`listRef.current.getScrollableNode()`), compares its
  `clientHeight` with `listHeight.current`, and, when the list got shorter and
  the reader was `atBottom`, adds exactly the lost height to `scrollTop`. Then it
  records the new height in `listHeight.current`, so the delayed `onLayout` that
  follows sees no shortening and does nothing. The reader's distance from the end
  is kept exactly. There's no snap to the absolute end, so the up-to-160px
  overshoot is gone.
- `app/chat/[id].tsx:742-754`: `onLayout` stays as the fallback, for window
  resizes, rotation, and the eased `settle` correction, whose intermediate
  frames the shim never writes. But it switches from `scrollToEnd` to the same
  "add back the lost height" move, through one shared helper, so the fallback
  no longer overshoots either.
- The arithmetic ("given the old height, the new height, the scroll offset and
  whether the reader is at the bottom, where does the offset go?") goes in a pure
  helper, `keepFootInView` in `lib/keyboard.ts`, which is unit-tested. The screen
  and the listener both call it.

The shim header warns that measurements taken either side of a reshape can't
be trusted (lines 50-61). That warning is about the *document's* position,
which iOS may already have moved by the time `focusin` fires. A scroller's own
`clientHeight` and `scrollTop` are element-internal and not affected by a
document scroll. `unscroll()` has also already run by then. I'll add a sentence
to that header note so the distinction is on record.

### 3. Test the stateful shim (the untested area the issue calls out)

New file `hooks/useKeyboard.web.test.ts`, run under jsdom (`// @vitest-environment
jsdom`; `vitest.config.ts` already includes `hooks/**`). The module registers its
listeners at import time, so each test stubs `window.visualViewport` (a fake
`EventTarget` with settable `height`, `offsetTop` and `scale`) and
`matchMedia('(pointer: coarse)')`, then imports fresh (`vi.resetModules()`),
with `react-native-reanimated` mocked and fake timers. Cases:

- Focusing a `<textarea>` shrinks `body.style.height` **synchronously**, inside
  the `focusin` dispatch, and `onShellResize` listeners have run before
  `focus()` returns.
- Focusing a non-text element (a button) leaves the shell untouched.
- Blur followed by focus within 80ms (moving between fields) does not release.
- Blur with nothing re-focused releases after 80ms: the shell is cleared and
  progress returns to 0.
- No keyboard by `GRACE` (the viewport never shrank) → released.
- The viewport settles to a different room than the guess → the shell is
  corrected, and the room is remembered in `localStorage` keyed by width.
- A remembered room is used on the next engage (no `FIRST_GUESS`).
- Pinch-zoomed (`scale > 1`) → `engage` does nothing.
- Unsubscribing a listener stops its notifications.

Plus two regression pins:

- `lib/keyboard.test.ts`: cases for `keepFootInView`: at bottom → offset grows
  by the shrink; not at bottom → unchanged; growth → unchanged.
- `components/ScrollDismiss.test.tsx` (jsdom, react-native-web): records the
  root cause as a fact about the library. With `keyboardDismissMode="on-drag"`,
  a programmatic scroll event on a `ScrollView` blurs a focused `TextInput`;
  with `"none"` it doesn't. If a future react-native-web release changes this,
  the test says so. If the web setting is ever restored to `on-drag`, a reviewer
  can see what that costs.

## Files to Change

- `prototypes/ansari-expo/hooks/useKeyboard.web.ts`: add `onShellResize`
  subscription; notify from `writeShell`; in `engage`, notify after the forced
  reflow; a short addition to the header note.
- `prototypes/ansari-expo/hooks/useKeyboard.ts`: no-op `onShellResize` for native.
- `prototypes/ansari-expo/lib/keyboard.ts`: pure `keepFootInView` helper.
- `prototypes/ansari-expo/app/chat/[id].tsx:719-721`: `keyboardDismissMode`
  `'none'` on web.
- `prototypes/ansari-expo/app/chat/[id].tsx:742-754`: `onLayout` uses
  `keepFootInView` instead of `scrollToEnd`; new effect that subscribes to
  `onShellResize` on web.
- `prototypes/ansari-expo/lib/keyboard.test.ts`: `keepFootInView` cases.
- `prototypes/ansari-expo/hooks/useKeyboard.web.test.ts`: new, the stateful shim tests.
- `prototypes/ansari-expo/components/ScrollDismiss.test.tsx`: new, the RN-web
  dismissal regression pin.

`components/ChatInput.tsx` does not change.

## Risks & Alternatives Considered

- **Risk: the same RN-web behaviour exists elsewhere.** `components/Sidebar.tsx:759`
  uses `keyboardDismissMode="on-drag"` on the conversation list, right under the
  sidebar search field. On the web, any scroll event there, including the
  browser clamping `scrollTop` when a search filters the list shorter, would
  blur the search field mid-typing. This is the same mechanism but a different
  symptom and a different screen, and the issue asks for other mobile problems
  to be filed separately, so **I'll file it as its own issue rather than fix it
  here.** The architect may prefer to fold the one-line fix in, since it's the
  same defect; say so at plan review and I'll include it.
- **Risk: the scroll write in the listener fires a `scroll` event.** It does.
  With change 1 that event no longer blurs anything, and `onScroll` just
  recomputes `atBottom`, which stays true. This is also why change 1 has to land
  with change 2, not after it.
- **Risk: the listener runs before React has committed the list** (for example,
  on the first focus after navigating into a thread). The listener
  null-checks the scroll node and does nothing without one. `listHeight.current
  === 0` also means "not measured yet", which the helper already treats as "no
  shortening".
- **Alternative: make `engage` asynchronous (reshape on the next frame) to
  avoid mid-event layout.** Rejected. The shim's own history (header, lines
  40-48) says that re-opens the iOS pan, which was the bug that design exists to
  prevent. And the two-tap cause isn't the mid-event layout anyway, it's the blur.
- **Alternative: an inverted FlatList or `column-reverse`, so the foot is the
  natural anchor.** That would pin the bottom without any code on a resize, but
  it re-plumbs scrolling, the "Latest" button, the footer and `scrollPending` for
  the whole thread. That's far too much for this bug.
- **Alternative: keep `scrollToEnd` but make it animated.** That still blurs
  (it's still a scroll event under `on-drag`), still overshoots by the `atBottom`
  slack, and turns a snap into a slide that visibly lags the reshape.
- **Alternative: only change `keyboardDismissMode`.** That fixes the second tap
  but leaves the one-frame clip and the overshoot snap, which is the "jump"
  half of the report.

## Test Plan

- **Unit:** `pnpm --filter ansari-expo test` (or `pnpm test` in
  `prototypes/ansari-expo`). Every new case above passes, and the existing
  suites still pass. I'll also `tsc --noEmit` the prototype.
- **Show the root-cause tests would have caught the bug:** temporarily set the
  thread back to `on-drag` on the web and confirm the ScrollDismiss pin reads as
  "blurs". Temporarily move the `onShellResize` notification back before the
  reflow and confirm the "listeners see the new height" test fails. Revert both.
- **Manual, desktop Chrome (reproducible without a phone):** open the thread
  with DevTools device emulation on an iPhone profile. That makes `pointer:
  coarse` match, so the shim engages on focus. Open a thread long enough to
  scroll, scroll to the bottom, tap the composer.
  - Before (on `develop`): the thread content jumps, and
    `document.activeElement` is no longer the textarea (check with
    `document.activeElement.tagName` in the console, or watch the focus rim drop
    and the shell ease back open).
  - After: the content above the composer moves up in step with the shell, with
    no second movement, and the textarea keeps focus.
  - Repeat while an answer is streaming.
  - Repeat scrolled to the middle of the thread: no scroll at all, content stays
    put.
  - `?kb=420` in the URL gives the keyboard-up shape at a fixed room, for a
    screenshot.
- **Manual, a real phone (reviewer at dev-approval):** iOS Safari and Android
  Chrome, on a long thread at the bottom:
  - Tap the composer once. The keyboard comes up on the first tap and the last
    lines of the answer stay visible just above the composer, without a snap.
  - Tap it mid-stream: same.
  - Tap send, then tap the composer again: same (this is the blur → re-focus path).
- **Cross-platform:** native iOS and Android are unchanged. The
  `keyboardDismissMode` values there are the same as today, the native
  `onShellResize` is a no-op, and `onLayout` only swaps `scrollToEnd` for the
  equivalent offset move, which on native still runs through the same
  `scrollToOffset` path. A quick native smoke test of "focus the composer at the
  bottom of a thread" covers it.
