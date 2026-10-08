# air-247 thread

- Issue #247: `?q=` reopen of a thread ending on an unanswered user question showed "Searching…" forever.
- Chose fix option (b): the waiting line now needs a send behind it (in flight, auto-send due on an unloaded/empty thread, or a send made this session). A thread that already ends on an unanswered question gets the existing SendFailure retry instead. Did not auto-resend: silently re-sending on every bookmark/history reopen could fire duplicate requests (e.g. the answer is still streaming in another tab).
- Logic extracted to pure `lib/chat-wait.ts` (`answerWait`) so it is unit-testable; screen wiring in `app/chat/[id].tsx`.
- "A send this session" = `sentAtCount.current !== null` (set by every `send()`, never reset).
- Negative-tested: the two #247 regression cases fail against the old formula.
- Not verified in a running app (needs a backend thread in the stranded shape); unit-level only.
