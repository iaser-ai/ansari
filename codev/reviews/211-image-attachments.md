# Review: Image attachments in chat messages

## Summary

Users can attach up to 4 images to a chat message. They reach Gemini for that turn only and are
never stored. Each stored message keeps one placeholder block per image, which clients render
as a "Not stored" tile. Later turns tell the model the image is no longer available. The work
covers `apps/api` (validation, facilitator plumbing, an additive `attachments` key) and
`prototypes/ansari-expo` (picker, downscale, thumbnails, the home → thread hand-off).

## Spec Compliance

- [x] 0–4 images accepted. 5+, an unsupported type, mismatched magic bytes, and invalid base64
      all get 422 with no row written. An oversize body gets 413 before parsing.
- [x] `inlineData` reaches the current turn of the first call, a tool continuation, an
      empty-final retry, and synthesis. No earlier Content carries it.
- [x] No image bytes in `messages` or `tool_call_orphans` on the success and error paths.
      Checked through the real route and facilitator against pglite (scan negative-tested),
      and again against a real Postgres with the dev server.
- [x] Turn 2+ history carries the unavailable note. An image-only message keeps the previous
      assistant turn.
- [x] Text-only thread GET is byte-identical: `thread-get-contract.test.ts` passes unchanged.
- [x] Prototype pick → thumbnails → send → reload shows placeholders, driven in Chromium on
      the web build.
- [ ] **Not verified: Gemini actually answering about an image.** No Gemini credentials were
      available. Every request reached Gemini and failed on the dummy key. This needs a run
      with real credentials before merge.
- [ ] Native iOS/Android picker not exercised. Only the web build was driven.

## Deviations from Plan

- The API Phases 1 and 2 landed in one commit. The chat route carries changes for both, and
  splitting its hunks would have produced an intermediate commit that doesn't typecheck.
- `takeOpeningImages` became `peekOpeningImages` + `clearOpeningImages`. A destructive read in
  a render-time initializer loses the images under StrictMode's double invocation.
- The empty-final scan scenario was not run through the route. Image turns can't reach the
  Inkling rung, and the route's empty-`done` path is covered by the existing
  `chat-empty-answer` tests. The success and error paths cover both tables.

## Consultation Feedback

Not run: the `consult` CLI is not installed on the machine this was built on. The owner
approved the spec with the recommended answers to all open questions (2026-10-01).

## Lessons Learned

- **A history builder that skips entries breaks every "drop the last entry" consumer.**
  `convertToGeminiHistory` skipped text-less user messages, and `runFacilitator` removed the
  last Content as the current turn. Any new user-message shape without text would have
  silently deleted the previous assistant answer. Producers should emit exactly one entry per
  stored message.
- **Positional identity breaks once content can be empty.** The prototype's reconciler and
  guards used text truthiness (`if (!q)`, `if (pendingQuestion)`) to mean "there is a
  question". Image-only questions made `''` a valid question, so each check needed an
  explicit `!== null` or an attachments check.
- **TypeScript accepts a callback with fewer parameters.** `onSend={ask}` kept compiling after
  `onSend` gained an `images` argument, so the home screen would have dropped images
  silently. Grep every call site when widening a callback.

## Known pre-existing issues (not addressed)

- Reloading a thread whose only question failed shows "Searching…" indefinitely. Text-only
  questions do this too.
- The SSE `error` frame forwards the raw provider error message to the client.
