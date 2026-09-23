# PIR Plan: Thinner ThinkingLine, a generating mark while streaming, and hiding unbacked citations

Issue: #158. Scope: `prototypes/ansari-expo` only, with no backend change. It includes the scope
the architect added between 2026-09-22 and 2026-09-23: hide Copy/Share while streaming, size the
mark like the sidebar mark, and strip unbacked citation text. The last addition replaces an
earlier khushu'-only bracket strip.

## Understanding

1. **ThinkingLine reads too heavy.** `components/ThinkingLine.tsx:107` sets the status text in
   `fonts.displayItalic` (`Literata_500Medium_Italic`, `constants/colors.ts:586`). The #130
   font fallback used to hide this. `fonts.proseItalic` (`Literata_300Light_Italic`, `:588`) is
   already loaded.
2. **Nothing shows generation in progress after the first token.** The footer
   (`app/chat/[id].tsx:698-707`) renders `ThinkingLine` only while
   `awaitingAnswer && !streamingText`.
3. **The in-progress answer offers Copy/Share.** The synthetic streaming bubble is an ordinary
   `AnswerMessage`, so its action row (`components/AnswerMessage.tsx:193`) shows under text that
   is still being written.
4. **Citation-shaped text with no citation data behind it.** `apps/api` returns no citations
   (`lib/api/mappers.ts:110`, `citations: []`), but the model writes its own `[1]` markers and
   often a trailing `Citations:` / `**Citations:**` block. These render as raw, unstyled text.
   The only exception is the khushu' demo: `mapConversationDetail` (`:127-145`) attaches
   `SAMPLE_CITATIONS` to the first assistant answer of a thread whose first user message
   matches `/khush/i`, and there the markers become styled marks. The streaming bubble always
   has `citations: []`, so during the demo the raw `[1]`s show and then swap at the hand-off.

Turn lifecycle (it determines when things appear and disappear): `send()` (`:300-317`) clears
`streamingText`/`trace`. Deltas stream into a synthetic bubble keyed `streamKey.current`. At
`done`, `onSuccess` invalidates the detail query. The refetch produces `landedAnswer`, and
`reconcileThread` hides that row while `streamingText` is set (`lib/chat-reconcile.ts:72-73`).
The hand-off effect (`:397-408`) remaps the key and clears `streamingText` in one commit, so the
row updates in place. On error, `streamingText` stays on screen and `failedQuestion` drives
`SendFailure`.

## Proposed Change

### 1. Weight

`components/ThinkingLine.tsx:107`: `fonts.displayItalic` becomes `fonts.proseItalic`. This also
reaches the home screen's `<ThinkingLine />` (`app/index.tsx:832`), which is intended because
the carried-in wait must match across the transition.

### 2. Generating mark

- **What:** `AnsariMarkPulse` on its own, with no text, in the list footer under the growing
  answer and left-aligned with its text.
- **Size:** 32, the sidebar mark's size (`components/Sidebar.tsx:94` `MARK_HEIGHT = 32`). That
  constant is private to `Sidebar.tsx`, so I will hoist it to `constants/ansariMark.ts` as
  `ANSARI_MARK_EMBLEM_HEIGHT = 32` and import it in both places so they cannot drift.
  ThinkingLine's inline mark stays at 15, sized to its line of type.
- **Component:** an exported `GeneratingMark` in `components/ThinkingLine.tsx`. It shares that
  file's `WAIT_ENTER` fade and row padding. It is decorative (`aria-hidden` already), and the
  existing `announce()` effect covers the start and end of the turn.
- **Footer:**

  ```tsx
  awaitingAnswer && !streamingText ? <ThinkingLine … />
  : streamingText && !failedQuestion ? <GeneratingMark />
  : failedQuestion ? <SendFailure … />
  : null
  ```

- **Disappears at the hand-off**, in the effect that clears `streamingText`, as the issue says.
  I dropped an earlier idea of also gating it on `isPending`, which would end it at the SSE
  `done`, because Copy/Share (§3) return at the hand-off. Ending both in the same commit means
  the mark's height leaves as the action row's height arrives, all in one in-place row update.
  Ending the mark at `done` would cause two layout shifts a round trip apart.
- `!failedQuestion` means that on a mid-stream error the mark gives way to `SendFailure`
  instead of hiding it.
- **Entrance:** `WAIT_ENTER` has a 180 ms delay, so the first text lands and then the mark
  settles beneath it. **Exit:** plain unmount, because a fading FlatList footer leaves a gap
  that then collapses.

### 3. Hide Copy/Share while streaming

- `components/AnswerMessage.tsx`: optional `generating?: boolean` (default `false`) that gates
  the `answerActions` View on `!generating`. Nothing else changes, so the finished answer looks
  the same.
- `app/chat/[id].tsx` renderItem: `generating={!!streamingText && item.id === streamKey.current}`.
  After the hand-off the landed row's `item.id` is the server id (the stream key only survives
  in `keyOverrides`) and `streamingText` is `''`, so the actions return in the hand-off commit.
- On error the partial answer keeps `streamingText`, so its actions stay hidden. A failed
  partial answer is not something to copy or share, but I'm flagging it in case the reviewer
  disagrees.

### 4. Hide unbacked citation text: `stripUnbackedCitations`

**New file `lib/citations.ts`**, exporting `stripUnbackedCitations(content: string): string`:

1. Cut a trailing citations section: the first line that is only a `Citations` heading, plus
   everything after it. The heading can be plain, bold (`**Citations:**` / `__…__`), or an ATX
   heading (`## Citations`), with or without the colon, in any case. It is anchored to the
   start of a line (`^…$` multiline), so prose that merely says "citations:" mid-sentence is
   untouched. Trailing whitespace is trimmed afterwards.
2. Remove the remaining bare `[N]` markers together with one preceding space (`/ ?\[\d+\]/g`),
   so `"prayer [1]."` becomes `"prayer."`, not `"prayer ."`.

It is a pure function with no knowledge of khushu'. Callers decide when it applies.

**Wiring 1: `lib/api/mappers.ts` `mapConversationDetail`.** After the khushu' substitution
pass, any assistant message with `citations.length === 0` gets
`content: stripUnbackedCitations(m.content)`. The khushu'-substituted message (it has
`SAMPLE_CITATIONS`) is exempt and keeps its `[1]/[2]/[3]`. User messages are never touched.

**Wiring 2: `app/chat/[id].tsx` `onEvent`.** Add a ref `rawStreamText = useRef('')` that
accumulates the untouched deltas. On each `text` delta:
`rawStreamText.current += event.content; setStreamingText(stripUnbackedCitations(rawStreamText.current));`
The cleaning is always recomputed from the raw text, never applied to the already-cleaned
previous state. Applying it to the cleaned state would lose the context the heading cut
needs. The architect saw this failure in the preview. `rawStreamText.current = ''` is reset in
exactly the two places `streamingText` is reset: `send()` and the hand-off effect.

**How the pieces meet at hand-off:**

- Ordinary thread: the streamed display text and the mapped persisted text are both stripped
  by the same function over the same content, so the in-place swap changes nothing.
- Khushu' opener: the stream shows clean prose, and at hand-off the persisted message (exempt)
  shows its styled marks and sample footnotes. Marks are added; bracket text is not
  transformed. This is the intended demo behaviour.
- Khushu' follow-ups get no sample citations, so they are stripped both while streaming and
  once persisted, and stay consistent.

`reconcileThread` and the landing logic still key off `streamingText` truthiness. The one edge
is a stream whose first delta is only a marker (`"[1]"`). The cleaned text is `''` until prose
arrives, so ThinkingLine simply stays up one delta longer. That is harmless.

**Open question for the reviewer (not deciding it myself):** the exempt khushu' message keeps
**everything**, including any model-written trailing `Citations:` block, which would then sit
next to the sample footnote pills as a second, raw citation list. My suggestion is to strip only
the heading section (step 1) for the exempt message and keep its `[N]` markers. That would be a
two-function split (`stripCitationsSection` / `stripCitationMarkers`), with
`stripUnbackedCitations` composing them. I will do that only if you approve it. Otherwise I'll
implement the exemption exactly as instructed.

## Files to Change

- `prototypes/ansari-expo/constants/ansariMark.ts`: `ANSARI_MARK_EMBLEM_HEIGHT = 32`.
- `prototypes/ansari-expo/components/Sidebar.tsx:94`: `MARK_HEIGHT` takes that value.
- `prototypes/ansari-expo/components/ThinkingLine.tsx`: `:107` weight swap, plus
  `GeneratingMark`, `styles.generating`, and doc comment.
- `prototypes/ansari-expo/components/AnswerMessage.tsx`: `generating?` prop that gates `:193`.
- `prototypes/ansari-expo/lib/citations.ts` (new): `stripUnbackedCitations`.
- `prototypes/ansari-expo/lib/citations.test.ts` (new): unit tests.
- `prototypes/ansari-expo/lib/api/mappers.ts`: strip pass in `mapConversationDetail`.
- `prototypes/ansari-expo/lib/api/decode.test.ts`: new cases (below).
- `prototypes/ansari-expo/app/chat/[id].tsx`: imports; `rawStreamText` ref; `onEvent`; resets
  in `send()` and the hand-off; footer branch plus comment; `generating` prop in renderItem.

## Risks & Alternatives Considered

- **Risk: a partial marker or heading flashes at a chunk boundary.** For example `"…prayer [1"`
  for one frame, or `"**Citat"` before the heading completes and the cut applies. Each lasts
  one delta. I'll watch for it at dev-approval. If it's visible, add a streaming-only trim of an
  unfinished trailing `[\d*` in the `onEvent` path. I'm not adding it to the persisted path,
  where content is complete.
- **Risk: the heading regex eats real prose.** It is anchored to a line that is only the
  heading, and there is a negative test for mid-sentence "citations:".
- **Risk: `[N]` stripping hits legitimate bracketed numbers in unbacked answers.** This is
  accepted per the architect's rule: with no citation data, citation-shaped text is hidden. It
  is display-only, and the stored content is unchanged.
- **Risk: mark and actions don't trade heights cleanly at hand-off (a jump while pinned to the
  bottom).** Check at dev-approval. If needed, give `styles.generating` a `minHeight` equal to
  the action row's.
- **Risk: Light Italic too faint in dark mode.** Check both schemes. No other italic weight is
  loaded, so I would raise it rather than add an asset.
- **Alternative: clean progressively from the previous cleaned state.** Rejected (see wiring 2).
- **Alternative: khushu'-only display strip** (the earlier instruction). Replaced by the general
  rule, which needs no `q`/khush special-casing on the client.
- **Alternative: caret, cursor, or "Writing…" label.** Rejected. It invents an idiom or competes
  with the text.

## Test Plan

- **Unit, `lib/citations.test.ts`:** plain, bold, `##`, no-colon, and uppercase headings are
  cut along with everything after; a mid-sentence "citations:" is kept; `[1]` with and without a
  leading space, and several markers, are removed; text with no markers is unchanged; `[a]` and
  `[]` near-misses are unchanged; empty string is unchanged.
- **Unit, `lib/api/decode.test.ts`:** the existing 24 tests stay green. New: a non-khushu'
  answer with inline `[1]` and a `**Citations:**` block collapses to just the prose. A khushu'
  thread's first answer keeps `[1]`/`[2]`/`[3]` intact alongside `SAMPLE_CITATIONS`. A khushu'
  follow-up (no citations) is stripped.
- **Typecheck/tests:** `pnpm --filter ansari-expo typecheck` and `pnpm --filter ansari-expo test`.
- **Manual (web via `afx dev`, plus iOS simulator if available):**
  1. Ask from home. "Searching the sources…" and the trace are visibly lighter than on
     `develop`, in light and dark.
  2. When streaming starts, the ThinkingLine goes away, the text grows, and about 180 ms later
     the 32px pulsing mark (the same size as the sidebar mark) settles under it. No Copy/Share
     appears on the in-progress answer.
  3. At completion, the mark leaves and Copy/Share arrive in the same moment, the row updates in
     place, with no flicker or duplicate and no jump while pinned to the bottom.
  4. A non-khushu' question whose answer has `[N]` and a `Citations:` block: no brackets and no
     citations section, either while streaming or after hand-off, and no change at the swap.
  5. "How can I develop khushu' in my prayer?" from home: clean prose while streaming, then
     styled marks and footnotes at hand-off. A follow-up in that thread stays clean throughout.
  6. Error mid-stream: the partial (cleaned) text stays, the mark goes away, `SendFailure` shows
     alone, and there are no actions on the partial answer.
  7. Reduced motion: the mark is held at mid-light and does not pulse.
  8. Reopen an old conversation whose stored answers contain `[N]` or `Citations:`: they render
     clean. The khushu' demo thread still shows its marks.
