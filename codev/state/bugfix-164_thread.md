# bugfix-164 thread — legacy web: follow the streaming answer

## Investigate (2026-09-23)
- Root cause: `legacy/frontend-web/src/components/chat/MessageList.tsx` has no auto-follow at all.
  Old repo 76c2843 swapped FlatList+scrollToEnd for a plain ScrollView and dropped it; the
  `MessageListRef.scrollToBottom` that ChatContainer calls on mount is never implemented (ref is inert),
  and `useScrollManagement` has no consumer. On web the RN ScrollView grows to content height and the
  `overflow-y-auto` View in `src/app/(app)/_layout.tsx` is the real scroller, so any follow logic has
  to act on that ancestor, not on the ScrollView.
- Reproduced with a new streaming e2e (a local HTTP server that streams chunks; the POST is
  `route.continue`d to it): with the reader at the bottom, the newest text ended 1478 px below the fold.
- Scope added by Waleed (issue comment): a floating jump-to-latest button whenever the reader is
  >50 px from the bottom, plus before/after Playwright videos. The architect's rule: videos go to
  gitignored `legacy/frontend-web/e2e/videos/`, never committed; I report their paths when the PR is up.
- Setup gotcha: `playwright install` timed out on this machine even though curl fetched the same
  zip in 2 s. I installed chrome-headless-shell v1243 by hand into ~/Library/Caches/ms-playwright.
- #59 (pin the question to the top on send) vs follow: this fix scrolls to the bottom on send and
  follows from there. #59 would replace only the on-send jump, and could reuse the same follow flag.

## Fix (2026-09-23)
- MessageList: follow flag in a ref. It is set on send or on reaching the bottom, and cleared only by
  an UPWARD scroll. Hard-won detail: scroll events can fire before ResizeObserver reports growth
  in the same frame, so "distance > 50 px" alone would drop the flag while following. The
  scrollTop-decreased rule avoids that.
- First attempt followed only while `isSending`. It left a 320 px gap after the stream, because the
  reaction row renders once `isSending` goes false. The follow is now position-driven.
- Opening a thread still lands at the top (measured scrollTop 0 before and after). The jump button
  shows there.
- Jump button: the existing native-only ScrollToBottomButton, now on web too. It is `fixed` on
  web because the page scrolls, and `absolute` on native.
- 16/16 e2e passed with `--repeat-each 4`. Jest 45/45. PR #174.
