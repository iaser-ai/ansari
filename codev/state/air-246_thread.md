# air-246 thread

- Root cause confirmed as described in #246: `scrollPending` was a one-shot flag spent on the first `onContentSizeChange`; a streamed answer grows across many.
- Replaced it with `lib/thread-follow.ts` (`createThreadFollow`): a follow-up send (or "Jump to latest") starts *following*; every growth then scrolls to the foot until the reader scrolls up and ends short of the foot. Upward + short-of-foot is the "left" test, so a programmatic scrollToEnd (only moves down) and an iOS bounce (settles onto the foot) never cancel it — no drag events needed, which react-native-web can't give us anyway (#202).
- "Jump to latest" is now re-decided on growth too, not only on scroll. Visible side effect: opening a long existing thread (lands at its top) now offers "Jump to latest" straight away; before, it waited for the first scroll.
- Not changed: THREAD_BOTTOM_PAD stays static (issue calls it secondary).
- Verified by unit tests + typecheck + full vitest; NOT exercised in a live browser against a streaming backend.
