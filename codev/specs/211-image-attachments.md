# Specification: Image attachments in chat messages

> Issue #211. Status: APPROVED at the spec gate (2026-10-01). The owner accepted the recommended
> answer to every open question (see Open Questions → Resolutions).

## Problem Statement

Users can only send text. A user who wants to ask about an image (a page of a book, a
screenshot of a fatwa, a photo of an inscription) has to transcribe it first. The feature: a
user attaches **up to 4 images** to a chat message. The model sees them **for that turn
only**, and they are **never stored**. The thread keeps a placeholder so the UI can show that
an image was attached, and later turns tell the model that the image is no longer available.

The feature request says images are "sent to Claude". The API's chat model is **Gemini**
(`@google/genai`; the facilitator was ported from Claude, `lib/facilitator/agent.ts:4`), with
**Inkling** as a fallback rung and an optional primary (`PRIMARY_BACKEND`). This spec reads
"Claude" as "the chat model".

Affected: users of the Expo prototype, who get the feature. Released mobile builds, which
must see no contract change on threads they open. The owner, who pays the extra input tokens.

## Current State

- **Send paths.** `POST /api/v2/threads/{id}/chat` (SSE; `chatSchema = { message: string }`)
  is the path `prototypes/ansari-expo/lib/api/streaming.ts:65` uses.
  `POST /api/v2/threads/{id}` (raw-text stream, `{ content, role }`) is the path released
  mobile builds use. `v2/mcp-complete` and `v1/chat/completions` are text-only integrations.
- **Persistence.** The chat route writes the user message as
  `content: [{ type: 'text', text }]` before streaming starts. `messages.content` is `jsonb`
  typed `ContentBlock[]`, so a new block variant needs **no migration**.
- **Serialization.** Thread GET and share GET collapse a single text block to a bare string
  (`formatMessageContent`, `threads/[id]/route.ts:30`, `share/[id]/route.ts:12`). Any other
  shape is returned as the raw array. The frozen mobile contract requires single-text
  `content` to stay a bare string (arch-critical).
- **History.** `convertToGeminiHistory` (`agent.ts:347`) turns user messages into a single
  text part and **skips user messages with no text**. `runFacilitator` then drops the last
  history entry (`agent.ts:466`), assuming it is the current user turn.
- **The current turn.** It is sent as a string (`currentQuery`) through
  `streamGemini(message: string, …)` / `streamInkling(message: string, …)`. The same text is
  re-added to history as a text part in two places: tool continuation (`agent.ts:891`) and
  the synthesis pass (`agent.ts:589`). Inkling's message model is OpenAI-style
  `content: string` (`inkling-client.ts:85`).
- **Privacy guards already present.** Sentry `beforeSend` deletes `event.request.data`.
  `raw_payload` stores only the final **model** turn, so it never contains user parts.
- **Clients.** `prototypes/ansari-expo` already depends on `expo-image-picker` and
  `expo-image` (unused for this). `apps/frontend` is a HeroUI starter screen with no chat UI.

## Desired State

1. The prototype composer lets the user pick 1–4 images, shows thumbnails with remove, and
   sends them with the message. The text may be empty when at least one image is attached.
2. The API passes the images to the model as inline image parts on the **current user turn**
   for every model call in that request: the first call, tool continuations, empty-final
   retries, and synthesis.
3. Image bytes exist only in request memory. They are never written to any table, log line,
   Sentry event, or thread-naming call.
4. The user message is persisted with one placeholder block per image (media type only).
   Clients render a placeholder chip ("Image — not stored") on reload and in shares.
5. On every later turn, the history sent to the model replaces each placeholder with a text
   note: the user attached N image(s), which are no longer available.
6. Released mobile builds see no change for threads without images, and no crash for threads
   with them (see Approach C).

## Success Criteria

- [ ] `POST /threads/{id}/chat` accepts `images` (0–4) and rejects 5+, unsupported types,
      oversize images, and bytes that don't match the declared type, with 422 and no row
      written.
- [ ] A request with images sends `inlineData` parts on the current user turn on every
      Gemini call in the request, verified for the first call, a tool continuation, and the
      synthesis pass.
- [ ] pglite test: after an image turn (success, error, and empty-final paths), no column of
      `messages` or `tool_call_orphans` contains the base64 payload or any 64+-char substring
      of it.
- [ ] Turn 2+ history contains the "no longer available" note at the image message's
      position, and contains no `inlineData`.
- [ ] An image-only message does not drop the previous assistant turn from history (the
      `agent.ts:466` hazard).
- [ ] Thread GET for a text-only message is byte-identical to today
      (`thread-get-contract.test.ts` stays green, unchanged).
- [ ] Prototype: pick → thumbnails → send → answer about the image works on iOS and web.
      Reloading the thread shows placeholder chips.
- [ ] Verified on the real user path (dev server + prototype), not only in unit tests.

## Constraints

- **Frozen mobile contract.** Single-text `content` stays a bare string. No change to the
  legacy `POST /threads/{id}` path used by released builds.
- **Vertex history rules** (arch-critical). Image parts go only on user-role Contents.
  Adding them must not disturb the user/model alternation or the functionCall/
  functionResponse pairing.
- **No stored image data** anywhere, including logs. Log only `{name, code}` from SDK or
  driver errors, because a Gemini SDK error can echo request content.
- **No new env var** unless needed. If one is added, it goes in `turbo.json` `globalEnv` and
  the Zod config (strict env mode).
- **Request size.** App Router route handlers impose no body limit, and `request.json()`
  buffers the whole body. The route must reject an oversize `Content-Length` before parsing.

## Assumptions (verify during plan)

- The Vertex Gemini model in use accepts `image/png`, `image/jpeg`, `image/webp`,
  `image/heic`, `image/heif` as inline data, with a ~20 MB total inline request limit.
- Inkling (Tinker, OpenAI-compatible) does **not** accept image input. If it does, Approach D
  simplifies.
- Images cost about 258–1,300 input tokens each on Gemini, which the existing `inputTokens`
  accounting already captures.

## Solution Approaches

### A. Request transport

**Recommended: base64 inside the existing JSON body.**
`images: [{ media_type, data }]`, with the SSE fetch unchanged. The client downscales first
(longest edge ≤ 1568 px, JPEG q≈0.8, with HEIC converted on device), so a typical image is
200–600 KB. Server limits: ≤ 4 images, ≤ 5 MB decoded each, ≤ 16 MB body. The server checks
magic bytes against `media_type` and accepts png/jpeg/webp.
*Alternative:* multipart/form-data. It saves the 33% base64 overhead, but it changes the
prototype's fetch/stream helper and the route's parsing, which isn't worth it at these sizes.

### B. Placeholder block

New `ContentBlock` variant: `{ type: 'image', status: 'not_stored', media_type: string }`.
It is distinct from `document` and never carries `data`. A `type` guard in `createMessage`
(or the schema helper) rejects any `image` block that carries extra keys, so a future edit
cannot store bytes by accident.

### C. Serving placeholders without breaking released builds

The ask conflicts with the frozen contract. A user message with images would serialize as an
array, which released builds have never seen on a user message.
- **C1 (recommended): additive `attachments` key.** `formatMessageContent` serializes only
  text blocks (still a bare string, or `""` for an image-only message). The thread GET and
  share GET add `attachments: [{ type: 'image', status: 'not_stored', media_type }]` **only
  on messages that have images**. Old clients ignore the unknown key, and text-only messages
  are byte-identical.
- **C2: array `content`.** Simplest, but released builds would receive an unknown block type
  on any thread that a user started in the prototype.
- **C3: a separate endpoint**, mirroring spec 168's `/documents`. This is over-built for one
  tiny marker per message.
Spec 168's owner ruling redirected *documents* away from an additive key on these endpoints.
That ruling was about payload size, which doesn't apply here, but **the owner needs to
confirm C1.**

### D. Inkling paths

Inkling cannot see images, so a text-only rescue would answer as if it had.
- **Recommended:** when the current turn has images, the request is **Gemini-only**. The
  Inkling empty-final rung and the #79 error rescue are skipped, the turn fails with the
  existing clean error, and tool records go to orphans as usual. When
  `PRIMARY_BACKEND=inkling`, `/chat` returns 422 "Image attachments are not available right
  now" before persisting anything.
- *Alternative:* fall back to Inkling with a text note saying the image couldn't be viewed.
  This was rejected because it risks a confident wrong answer.

### E. Facilitator changes

- `streamGemini` takes `message: string | Part[]`. The facilitator builds
  `currentParts = [text?, ...inlineData]` and uses it everywhere `userQuery` enters history:
  the first call, continuation (`:891`), and synthesis (`:589`).
  `runFacilitator(history, onMessage, { …, images })` carries the bytes. They are **not** put
  on `Message`, so persistence code never sees them.
- `convertToGeminiHistory` emits a user Content whenever a user message has text **or**
  image blocks. For image blocks it appends:
  `[The user attached N image(s) to this message. Images are not stored and are no longer
  available; rely only on what earlier answers said about them.]`
  This guarantees every user message yields exactly one Content, which removes the
  `slice(0, -1)` hazard. The current turn's placeholder note is then replaced by the real
  parts.
- Thread naming gets the text only. An image-only first message is named by a fallback
  ("Image question").

### F. Out of scope

Legacy `POST /threads/{id}`, `mcp-complete`, and `v1/chat/completions` stay text-only and
unchanged. There is no `apps/frontend` work because it has no chat UI yet; when one is built,
it should reuse the prototype's request shape. Non-image files (PDF) are also out of scope.

## Open Questions

1. **(Owner)** C1 additive `attachments` key: confirm, or choose C2/C3.
2. **(Owner)** D: confirm Gemini-only for image turns and 422 under `PRIMARY_BACKEND=inkling`.
3. Image-only messages: allowed (recommended), or require text?
4. Share snapshots: show the placeholder chip (recommended), or omit attachments from shares?
5. Should a failed image turn (error/empty-final) still keep its placeholder row? It will
   today, since the user row is written before streaming. That's acceptable, because the
   follow-up turn tells the model the image is gone.

### Resolutions (spec gate, 2026-10-01)

1. C1 confirmed: an additive `attachments` key.
2. D confirmed: image turns are Gemini-only, with 422 under `PRIMARY_BACKEND=inkling`.
3. Image-only messages are allowed.
4. Shares show the placeholder chip.
5. A failed image turn keeps its placeholder row.

## Test Scenarios

- Validation: 0/1/4/5 images. Wrong magic bytes. 5 MB + 1 B. Oversize `Content-Length`
  rejected before parse. Empty text + images accepted. Empty text + no images rejected.
- Gemini request capture (mocked client): inlineData present on the first call,
  continuation, empty-final retry, and synthesis. Absent from every Content before the
  current turn.
- History: a 3-turn thread with images on turn 1 sends the note on turn 2/3. Image-only
  turn 1 followed by turn 2 keeps assistant turn 1 in history.
- Inkling: an image turn with an empty final skips the Inkling rung and returns the error.
  `PRIMARY_BACKEND=inkling` returns 422 with no row written.
- No-storage scan (pglite, real DB): success, error, and empty-final paths. Negative-test the
  scan: it must flag a row that does contain the base64, and must not flag a placeholder.
- Contract: `thread-get-contract.test.ts` unchanged and green. A new case covers the
  `attachments` key only on image messages, for thread GET and share GET.
- `vi.mock` factories of `gemini-client` / `agent` updated for the new signatures
  (lessons-critical: a missing export can be swallowed in the streaming route's catch).
- Prototype: picker limit 4, remove thumbnail, send with images, the placeholder chip
  renders from `attachments`, web file picker works.

## Risks and Mitigation

| Risk | Mitigation |
|---|---|
| Bytes leak into logs via SDK error objects | Log `{name, code}` only on the image path; test that a thrown error carrying the payload is not logged verbatim |
| Large bodies tie up memory | Early `Content-Length` reject; client-side downscale |
| Old builds break on image threads | C1 keeps `content` a string; additive key only |
| Inkling answers without seeing the image | D: image turns are Gemini-only |
| History desync (image-only turn) | E: one Content per user message, covered by a test |
| Higher token cost | Already metered per message; 4-image cap |

## References

- `apps/api/src/app/api/v2/threads/[id]/chat/route.ts`
- `apps/api/lib/facilitator/agent.ts` (`convertToGeminiHistory`, `:460–469`, `:589`, `:891`)
- `apps/api/lib/ai/gemini-client.ts:922`, `apps/api/lib/ai/inkling-client.ts:85`
- `apps/api/db/schema/messages.ts` (`ContentBlock`)
- `apps/api/src/app/api/v2/threads/[id]/route.ts:30`, `share/[id]/route.ts:12`
- Spec 168 (owner ruling on additive keys), spec 73 (orphans), issue #70 (history fidelity)
- `prototypes/ansari-expo/lib/api/streaming.ts`, `components/ChatInput.tsx`
