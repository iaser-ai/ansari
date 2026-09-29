# PIR Review: Thinner ThinkingLine, a generating mark while streaming, and hiding unbacked citations

Fixes #158

## Summary

This PR polishes the prototype chat screen's waiting and generating states:

- **Lighter status line.** "Searching the sources…" moves from Literata 500 Medium Italic to 300 Light Italic.
- **Generating mark.** A standalone pulsing Ansari mark, sized like the sidebar mark, sits at the foot of an answer while it streams.
- **No Copy/Share mid-stream.** The in-progress answer hides its Copy/Share row.
- **Hidden citation text.** The architect expanded the scope mid-plan to hide citation-shaped text (`[N]`, a trailing `Citations:` list) on any answer that has no citation data behind it. It applies both to answers loaded from the API and while streaming. The khushu' demo answer keeps its markers because it carries its sample citations.

## Files Changed

- `prototypes/ansari-expo/app/chat/[id].tsx` (+25 / -3)
- `prototypes/ansari-expo/components/AnswerMessage.tsx` (+52 / -44). Most of this is re-indentation from wrapping the action row in `{!generating && (…)}`.
- `prototypes/ansari-expo/components/Sidebar.tsx` (+2 / -1)
- `prototypes/ansari-expo/components/ThinkingLine.tsx` (+28 / -1)
- `prototypes/ansari-expo/constants/ansariMark.ts` (+9 / -0)
- `prototypes/ansari-expo/lib/api/mappers.ts` (+10 / -1)
- `prototypes/ansari-expo/lib/api/decode.test.ts` (+47 / -0)
- `prototypes/ansari-expo/lib/citations.ts` (+53 / -0, new)
- `prototypes/ansari-expo/lib/citations.test.ts` (+96 / -0, new)
- `codev/plans/158-prototypes-ansari-expo-thinner.md`, `codev/reviews/158-prototypes-ansari-expo-thinner.md`, `codev/state/pir-158_thread.md`
- `codev/resources/arch.md`, `codev/resources/arch-critical.md` (map line), `codev/resources/lessons-learned.md`

## Commits

- `7dd24ab` [PIR #158] Plan draft
- `3cc4aca` [PIR #158][Phase: implement] feat: lighter ThinkingLine, generating mark, hide unbacked citations
- `4638bbb` [PIR #158] thread: implement notes
- `87e36dd` [PIR #158][Phase: implement] fix: hold back a half-written citation tail while streaming
- the review commit (this file and the arch/lessons updates)

Plus porch bookkeeping commits and one merge of `origin/develop`. The merge brought in #130, #146 and `SAMPLE_ANSWER_CONTENT`.

## Test Results

- Porch `build` check: ✓ pass. It needed `apps/api/.env.ci` loaded (see Things to Look At).
- Porch `tests` check: ✓ pass.
- `prototypes/ansari-expo`: `tsc --noEmit` ✓; `vitest` ✓ 245 tests (24 new):
  - `lib/citations.test.ts`: 21 tests
  - `lib/api/decode.test.ts`: 3 new, and the existing 24 still pass
- Headless verification of the real code path: a real-shaped answer (inline `[N]` plus a `**Citations:**` block) was replayed through the `onEvent` logic and `mapConversationDetail` at chunk sizes 1/3/7/16.
  - The final streamed frame equals the persisted text, so the hand-off swap changes nothing.
  - The khushu' answer parses to footnote markers 1–3 with 3 citations.
  - This replay found a one-frame flash of `[1` / `**Cita` at chunk boundaries, fixed in `87e36dd`. Those tests fail without the fix (5 failures) and pass with it.
- Manual UI check: I could not drive the UI because the Chrome extension was not connected. The human reviewed the running build at dev-approval and approved it.

## Architecture Updates

COLD `codev/resources/arch.md`: new section **Prototype chat display (prototypes/ansari-expo)**. It records:
- the unbacked-citation display rule, applied in two symmetric places (mapper and streaming)
- the raw-ref recompute
- the khushu' exemption
- the fact that the streaming chrome (no actions, `GeneratingMark`) clears in the single hand-off commit

HOT `codev/resources/arch-critical.md`: map line only, for the new cold section. No new critical fact; it is prototype-scoped and does not belong in the capped hot tier.

## Lessons Learned Updates

COLD `codev/resources/lessons-learned.md`, in the existing "Incremental streaming render — prototype" section, two #158 bullets:
- Recompute a stream display transform from the raw accumulated text; never fold it into the cleaned state.
- Test stream transforms by replaying real-shaped text at several chunk sizes and asserting on every frame and on the final frame equalling the persisted text.

No hot-tier change. The existing hot lessons ("tests pass is not it works" and "negative-test every scan") already cover the general principle this instance illustrates.

## Things to Look At During PR Review

- **When the mark disappears.** It clears in the `done` hand-off commit, not at the SSE `done` frame (`sendMessage.isPending`). This was chosen so the mark leaving and Copy/Share returning happen in one layout change instead of two. The trade-off is that the mark keeps pulsing for one refetch round trip after the last token.
- **`PENDING_HEADING` in `lib/citations.ts`.** This streaming-only regex holds back a last line that could still become a `Citations` heading (`C`, `Cit`, `**Citat`, `## Ci`). Ordinary prose that starts a paragraph with those letters, such as "Citing…", shows one chunk later, never lost. It never applies to persisted text.
- **Native long-press still offers Copy mid-stream.** Only the visible Copy/Share row is gated. Gating the long-press `Pressable` wrapper would swap it for a `View` at the hand-off and remount the prose, which would bring back the flicker the stable-key hand-off exists to prevent.
- **A failed partial answer keeps its actions hidden.** Its `streamingText` stays on screen, so `generating` stays true. This is deliberate: there is nothing whole to copy.
- **`[N]` stripping is unconditional on citation-less answers.** A legitimate bracketed number like `[2]` in such an answer is hidden too. This is the architect's rule: with no citation data, citation-shaped text is hidden. It is display-only, and stored content is unchanged.
- **The `Citations` heading cut is first-match, not end-anchored** (raised by the Claude consult). A line that is only `Citations:` anywhere in an answer hides everything after it, including any prose that follows. This is unlikely from this model, and it is display-only and reversible. Two related gaps are left as possible follow-ups: `References:` / `Sources:` headings are not recognized (their `[N]` are still stripped), and a `[N]` alone on a line leaves an empty line behind.
- **3-way consult:** Codex APPROVE, Claude APPROVE (non-blocking comments above), Gemini skipped because the `agy` CLI is not installed on this machine.
- **Porch `build` check and env.** The local porch `build` check fails without `apps/api/.env`, because `next build` validates env with Zod. Neither the main checkout nor worktrees have that file. It passes with `env $(grep -v '^#' apps/api/.env.ci | xargs) porch done 158`. This is unrelated to this diff but worth knowing for other builders.
- **Process note.** A "stand down" instruction and its correction arrived out of order. I stopped work and later redid the edits cleanly on top of `develop`, so no competing commits were pushed.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder pir-158 → **Review Diff**
- **Run dev**: VSCode sidebar → **Run Dev**, or `afx dev pir-158`
- **What to verify**:
  - "Searching the sources…" reads visibly lighter, in light and dark mode.
  - Once text streams, a 32px pulsing mark sits under the answer, with no Copy/Share. At completion, the mark leaves and Copy/Share appear together, with no jump while pinned to the bottom.
  - A non-khushu' answer shows no `[N]` and no `Citations:` list, while streaming or after.
  - The khushu' question from home shows clean prose while streaming, then styled marks and footnotes after the hand-off.
  - On a mid-stream error, the partial text stays, the mark goes away, and only `SendFailure` shows.
  - With reduced motion on, the mark is held still.
