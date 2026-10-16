# Plan: Image attachments in chat messages

Spec: `codev/specs/211-image-attachments.md` · Issue: #211 · Branch: `feature/image-attachments`

## Executive Summary

Four phases, in dependency order. Phase 1 fixes the wire contract and the stored shape: the
request schema, validation, the placeholder block, and the `attachments` key. Phase 2 carries
the image bytes from the route to Gemini for every call in the request. It also replaces
stored placeholders with a "no longer available" note in later history, and keeps image turns
off Inkling. Phase 3 is the Expo prototype UI. Phase 4 covers docs and the arch/lessons
updates.

No DB migration: `messages.content` is `jsonb`, and the placeholder is a new `ContentBlock`
variant. `DEPLOYED_THROUGH` does not move.

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "API contract: validation, placeholder block, attachments key"},
    {"id": "phase_2", "title": "Facilitator: image parts on the current turn, history note, Gemini-only"},
    {"id": "phase_3", "title": "Prototype: picker, thumbnails, send, placeholder chips"},
    {"id": "phase_4", "title": "Docs and governance updates"}
  ]
}
```

## Phase Breakdown

### Phase 1: API contract

#### Objective
Accept and validate `images` on `POST /threads/{id}/chat`. Persist placeholders, never bytes.
Serve placeholders as an additive `attachments` key without changing text-only messages.

#### Files to Create / Modify
- `apps/api/db/schema/messages.ts`: add the `ImagePlaceholderBlock` variant
  `{ type: 'image'; status: 'not_stored'; media_type: ImageMediaType }` to `ContentBlock`.
- `apps/api/lib/attachments.ts` (new):
  - The limits: `MAX_IMAGES = 4`, `MAX_IMAGE_BYTES = 5 MB` decoded,
    `MAX_CHAT_BODY_BYTES = 16 MB`, and `IMAGE_MEDIA_TYPES = png | jpeg | webp`.
  - `imageInputSchema`: Zod with a strict base64 regex.
  - `decodeImages(inputs)`: decode, enforce the size limit, and check magic bytes against
    `media_type`. Returns `ImageAttachment[]` (`{ mediaType, data }`) or a typed error.
  - `placeholderBlocks(images)`: one block per image with no data. The return type makes a
    `data` key impossible.
  - `splitForWire(content)`: returns `{ content: string | ContentBlock[], attachments? }`.
    Image blocks are removed. Any remaining single text block, or nothing at all, becomes a
    bare string (`""` when only images remain). `attachments` is set only when there was at
    least one image.
- `apps/api/src/app/api/v2/threads/[id]/chat/route.ts`:
  - Reject `Content-Length > MAX_CHAT_BODY_BYTES` with 413 before `request.json()`.
  - The schema becomes `{ message: string (may be empty), images?: imageInput[] (max 4) }`,
    refined so text and images can't both be empty.
  - Return 422 on validation failure, before any row is written.
  - Persist `[text?] + placeholders`.
- `apps/api/src/app/api/v2/threads/[id]/route.ts` (GET) and `share/[id]/route.ts`: replace the
  local `formatMessageContent` with `splitForWire`, and spread `attachments` only when present.

#### Acceptance Criteria
- 0/1/4 images accepted. 5 images, a wrong type, a magic-byte mismatch, invalid base64, and
  5 MB + 1 B each rejected with 422 and no row written.
- An oversize `Content-Length` gets 413.
- `thread-get-contract.test.ts` passes unchanged.
- A text-only message serializes byte-identically.
- An image message has `content` as a string plus `attachments`.

#### Test Plan
- `tests/attachments.test.ts` (unit): decoding and validation boundaries, `splitForWire`
  shapes.
- `tests/chat-images-route.test.ts`: route-level 413/422, persisted content shape (mocked
  facilitator).
- Contract case for thread GET and share GET `attachments`.

### Phase 2: Facilitator plumbing

#### Objective
Gemini sees the images on the current turn for every call in the request, and nowhere else.
Later turns get a note instead. Image turns never touch Inkling.

#### Files to Create / Modify
- `apps/api/lib/ai/gemini-client.ts`: `streamGemini(message: string | Part[], …)`, passed
  straight to `sendMessageStream({ message })`. Re-export the `Part` type if needed.
- `apps/api/lib/facilitator/agent.ts`:
  - `convertToGeminiHistory`: a user message with text or image blocks always produces
    exactly one Content. Image blocks append the "no longer available" note. This closes the
    `slice(0, -1)` hazard at `:466`.
  - `runFacilitator(…, options.images?: ImageAttachment[])`. Build `userParts` from the text
    (if any) plus `inlineData` for each image. Use it for the first Gemini call, the
    continuation push (`:891`), and the synthesis history (`:589`). `currentQuery` (string)
    stays Inkling's input.
  - `inklingAllowed = !hasImages && isInklingConfigured()` replaces both rung and rescue
    checks. An image turn that starts on Inkling (forced provider or primary) yields an
    error immediately.
- `chat/route.ts`: pass `images` to `runFacilitator`. Return 422 when `config.primaryBackend
  === 'inkling'` and images are present (before persisting). Thread naming gets the text, or
  "Image question" when there is none.
- `lib/ai/thread-naming.ts`: skip the Gemini call and use the fallback name when the message
  is empty.

#### Acceptance Criteria
- A captured Gemini request has `inlineData` on the current turn for the first call, a
  continuation, an empty-final retry, and synthesis.
- No earlier Content carries `inlineData`.
- History on turn 2 carries the note.
- An image-only turn keeps the previous assistant turn.
- An image turn with a degenerate final retries once on Gemini and then errors: no Inkling
  call.
- A pglite scan finds no base64 substring in `messages` or `tool_call_orphans` after the
  success, error, and empty-final paths. The scan is negative-tested against a planted row.

#### Test Plan
- `tests/facilitator-images.test.ts` (mocked `streamGemini`/`streamInkling` capture).
- `tests/images-no-storage.test.ts` (pglite, real route).
- Update every `vi.mock('@/lib/ai/gemini-client')` / agent factory that the new code paths
  reach (grep for them all).

### Phase 3: Prototype UI (`prototypes/ansari-expo`)

#### Objective
Pick up to 4 images, preview and remove them, send them, and see placeholder chips on reload.

#### Files to Create / Modify
- `lib/api/wire-schemas.ts`: optional `attachments` on `wireMessageSchema`.
- `lib/api/types.ts`: a local `Message` extending the vendored one with
  `attachments?: Attachment[]`, where `Attachment = { mediaType; uri? }` (`uri` only for
  in-session local images).
- `lib/api/mappers.ts`: map `attachments`.
- `lib/api/streaming.ts` / `hooks.ts`: `images` in `StreamChatParams` and `SendMessageRequest`.
- `lib/attachments.ts` (new, pure): the 4-image cap, media-type mapping, and the
  `toImageInput` request shape.
- `lib/pick-images.ts`: expo-image-picker (multiple, remaining-slot limit, base64). Downscale
  with `expo-image-manipulator` (longest edge 1568 px, JPEG 0.8). Fall back to the picker's
  `quality` option if the manipulator is unavailable.
- `lib/pending-attachments.ts`: an in-memory handoff of the home screen's images to the chat
  screen, keyed by conversation id and consumed once (`q` is a route param, and images can't
  ride on one).
- `components/ChatInput.tsx`: an attach button, a thumbnail strip with remove, and send
  enabled when there is text or an image. `onSend(text, images)`.
- `components/AskedQuestion.tsx`: an attachment row. Thumbnails when a `uri` is present;
  otherwise a placeholder tile labelled "Image · not stored".
- `app/index.tsx`, `app/chat/[id].tsx`: thread the images through `send`, the echo, and the
  auto-send.

#### Acceptance Criteria
- Picker limit enforced.
- Send works with images only.
- The echo bubble shows thumbnails while the answer streams.
- After reload, the message shows placeholder tiles.
- `pnpm test` and `pnpm typecheck` pass.
- Checked in the browser against the local API.

#### Test Plan
- Vitest: mapper (`attachments` present/absent), wire schema, `lib/attachments`, and the
  pending-handoff consume-once behaviour.

### Phase 4: Docs and governance
- `apps/api/README.md`: the request/response shape for `images` and `attachments`.
- `codev/resources/arch.md` (+ a hot-tier line if it earns one): "image bytes never
  persisted; image turns Gemini-only; `attachments` additive key".
- Review doc `codev/reviews/211-image-attachments.md` at the end.

## Risks and Mitigation

| Risk | Mitigation |
|---|---|
| A `vi.mock` factory missing a new export, swallowed by the route's catch | Grep all factories of touched modules after Phase 2 |
| `expo-image-manipulator` install fails or version mismatch with SDK 54 | Picker `quality` fallback; client-side size check before send |
| Reconcile/hand-off flicker from the extra echo content | Echo carries local URIs; landed message swaps to placeholders by the same key |

## Documentation Updates
See Phase 4.
