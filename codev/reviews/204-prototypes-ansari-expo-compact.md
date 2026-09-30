# PIR Review: Compact the retrieval trace into a source-category row

Fixes #204

## Summary

While Ansari searches, the waiting line in `prototypes/ansari-expo` used to add one line per search query, and the list grew without bound (six or more lines for one question). It is now one fixed row, `Searching Qur'an · Hadith · Fiqh · Tafsir`. Each source starts dim, breathes while it is being searched, and goes to full opacity once all its searches have finished. The row keeps its shape from the first frame to the last. The per-call `traceReducer` is unchanged. A new pure derivation, `sourceProgress()`, groups its entries by source, so the existing invariants (match by tool, FIFO fallback, never strand a spinner) carry over to the new view.

## Files Changed

- `prototypes/ansari-expo/lib/chat-trace.ts` (+60 / -32): adds `SOURCE_CATALOGUE` and `sourceProgress()`. Removes `formatTraceLine` / `plural`.
- `prototypes/ansari-expo/lib/chat-trace.test.ts` (+63 / -40): adds `sourceProgress` tests. The `formatTraceLine` tests are removed as superseded. The `traceReducer` / `displayTool` tests are unchanged.
- `prototypes/ansari-expo/components/ThinkingLine.tsx` (+133 / -38): the fixed row, the `SourceWord` per-state opacity, and the accessibility summary.
- `prototypes/ansari-expo/components/ThinkingLine.test.tsx` (+71 / -0): new render test through react-native-web.
- `codev/resources/arch.md` (+2 / -0): new "Retrieval trace row" paragraph.
- `codev/resources/lessons-learned.md` (+12 / -0), `codev/resources/lessons-critical.md` (+1 / -0): new lessons section and its map entry.
- `codev/plans/204-prototypes-ansari-expo-compact.md` (+231 / -0), `codev/state/pir-204_thread.md` (+15 / -0).

## Commits

- `1b80e6d` [PIR #204] Hold the lead at 'Searching'; order sources as the prompt lists tools
- `3a53a79` Merge remote-tracking branch 'origin/develop' into builder/pir-204 (brings in #203)
- `44ea2de` [PIR #204] Document the trace row in arch.md; thread update
- `8c352ea` [PIR #204] Render the retrieval trace as a fixed source row
- `f4ecc59` [PIR #204] Derive per-source progress from the per-call trace
- `04cc845` [PIR #204] Plan draft
- plus the porch state commits

## Test Results

- `tsc --noEmit` (prototype): ✓ clean
- `vitest run` (prototype): ✓ 372 tests passing, 12 of them new (9 `sourceProgress` and 3 `ThinkingLine` render tests)
- Monorepo `turbo run build --force` with the CI dummy envs: ✓ (4/4, uncached)
- Manual: the reviewer verified the running worktree on web at dev-approval, after two rounds of feedback (below), and said it "looks great".

## Architecture Updates

COLD: I added a **"Retrieval trace row (issue #204)"** paragraph to `codev/resources/arch.md` → Prototype chat display. It covers:
- the two-layer model: per-call `traceReducer`, then a derived `sourceProgress`;
- the state rules;
- the fixed catalogue, in the facilitator prompt's order, with unknown tools appended;
- why each word is a sibling `Animated.Text`.

Nothing goes into HOT `arch-critical.md`. This is a prototype display detail, not a cross-cutting invariant.

## Lessons Learned Updates

COLD: I added a new **"Compact retrieval trace — prototype (issue #204)"** section to `codev/resources/lessons-learned.md`, and added its line to the `lessons-critical.md` map (11 of 12 slots). It covers:
- derive a coarse view from the fine-grained record instead of replacing it;
- RN ignores opacity on a nested `Text` span;
- keep the anchoring first word fixed;
- order progress by the sequence the work usually runs in;
- "I don't see the fix" usually means a stale or `CI=1` Metro server, or the wrong checkout, so grep the served bundle;
- the `porch next` trap recurred;
- porch's local build check needs the `.env.ci` files.

**Suggestion for the architect, not done here:** the `porch next` trap has now hit #202 and #204 back to back. It may deserve promotion to HOT `lessons-critical.md`. The hot tier is at its 10-lesson cap, so promoting it means demoting one, and that is the architect's call.

## Things to Look At During PR Review

- **Reviewer-driven revisions at dev-approval.**
  - The lead word no longer switches from "Searching" to "Reading". Changing the first word re-flowed the whole row, so the `phase` field was removed entirely.
  - The order was changed from Qur'an · Hadith · Tafsir · Fiqh to Qur'an · Hadith · **Fiqh · Tafsir**, which matches the facilitator prompt's tool list (`apps/api/lib/ai/prompts/facilitator.ts:58-61`). The row therefore usually lights left to right. Nothing enforces that order, so a tafsir-first question will light a word further right early, but the row does not move.
  - The plan carries a revision note at the top recording both changes.
- **Hard-coded catalogue.** `SOURCE_CATALOGUE` mirrors apps/api's `TOOL_LABELS` by hand, because the prototype cannot import apps/api. A new `search_*` tool is appended with a title-cased label, never dropped, and a test covers that.
- **Name-mismatch path.** When the FIFO fallback re-labels a pending hadith entry as quran, Hadith drops back to idle instead of staying half-lit. This is deliberate and tested.
- **Deliberately dropped detail.** Query text and result counts are no longer shown. `TraceEntry` still records them.
- **Opacity is not asserted in tests.** The render test mocks reanimated's shared values, so it checks the text, the order and the accessibility label, not the animated opacity. Opacity was verified by eye at dev-approval.
- **Cross-boundary check.** The diff touches only `prototypes/ansari-expo/**` and `codev/**`, with no other app or package, so the cross-boundary approval rule does not apply.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder pir-204 → **Review Diff**
- **Run dev**: `afx dev pir-204`. If a server is already running, check that it is this worktree's server and not started with `CI=1` (see lessons).
- **What to verify**:
  - Ask a question that uses several sources, e.g. "What does Islam say about patience?".
    - The row stays on one line, reading `Searching Qur'an · Hadith · Fiqh · Tafsir`.
    - The source being searched breathes, and each source goes to full opacity when it finishes.
    - The first word never changes.
    - The row hands off to the streaming answer as before.
  - Send a greeting with no tool calls. The row stays dim until the answer streams, with no layout jump.
  - Start from the home screen. The same row appears under the lifted question and carries into the thread.
  - On a narrow window (~320px) or at the largest text size, the row wraps to at most 2 lines.
  - With reduced motion on, there is no breathing, only static opacity steps.
