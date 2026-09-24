# bugfix-182 thread — composer jitter during streamed answer (legacy web)

## Investigate
- Reproduced with a new e2e test (`e2e/chat-scroll.spec.ts`, "the composer stays put while a followed
  answer streams"): it samples the composer textarea's `getBoundingClientRect().top` on every animation frame
  across the stream. Before the fix it moved by 59 px.
- Root cause is as the issue describes. `src/app/(app)/_layout.tsx` makes the whole page one
  `overflow-y-auto` scroller (Header, Slot, Footer). `ChatInput` sits in normal flow below `MessageList`,
  so each chunk pushes it down, and the #164 follow logic scrolls it back one frame later.
- Note for the fix choice: a sticky composer (option 1) would still move, because the Footer sits below the
  composer inside the same scroller. The sticky clamp is the viewport bottom, and the composer rests a
  Footer-height above that, so every chunk would still shove it down by up to the Footer height.

## Fix
- Chose option 2 (list becomes the scroller). Implemented as `style={{ flexBasis: 0 }}` on the live chat's
  ScrollView (web, `followEnabled` only). Its content no longer sizes the page, so the existing flex chain in
  `_layout.tsx` bounds it and RNW's default `overflowY: auto` makes it scroll. `_layout.tsx` is untouched, so
  other routes (delete-account, logout, home empty state) and the share view keep their page-scroll layout.
- Surprise: react-native-web overwrites `scrollTo` on the ScrollView's DOM node with its RN-shaped
  `scrollTo({x, y, animated})`. The #164 code called `scroller.scrollTo({top, behavior})`, which on that node
  means "animate to y=0". It had never mattered because the page scroller was a plain div. Now the call goes
  through `HTMLElement.prototype.scrollTo`.
- The jump button's sticky zero-height anchor became plain `absolute`, the same as the native branch.
- Checked: desktop, RTL (ar-SA locale; full suite passes), 390px phone width (full suite passes once the send is
  a click, because Enter does not submit in mobile layout), and the home route (composer drift 37px before, 0 after).
  In input full mode on a phone the composer is 242px wide, the same as before the change. That is pre-existing
  and not touched here.
- Video: legacy/frontend-web/e2e/videos/182-composer-stays-put-fixed.webm (gitignored).

## PR #183 — CMAP
- gemini APPROVE, codex APPROVE, claude APPROVE.
- Claude's non-blocking notes, not acted on here:
  - The bounded list has no `minHeight`. On a very short window with a tall draft (the composer can reach
    300px) the list can be squeezed. Reading the flex chain, it falls back to page overflow rather than
    breaking. Possible follow-up issue.
  - `followEnabled` now also picks the scroll-container shape. It covers the same routes today; a separate
    prop would be clearer if this file is touched again.

## Architect integration review — two items
- The `followEnabled` doc comment now says it also makes the list its own height-bounded scroller on web.
- Keyboard check. With nothing focused, Space/PageDown/arrows/End scroll nothing, and the old page scroller
  behaved the same (checked on 173cc97), so this is not a regression. Before `tabIndex`, Tab never landed on the
  list itself, but keys did scroll it once focus was inside it (a reaction button) or after a click. Added
  `tabIndex={0}` on web (live chat only). Tab now reaches the list in 2 presses and PageDown/Space scroll it.
  A mouse click draws no focus ring (`:focus-visible` false); the ring shows for keyboard focus only.
- Follow-up for the list's minHeight floor: #184.
