# pir-158 thread

## 2026-09-23 plan
- The weight fix is one line (ThinkingLine displayItalic -> proseItalic). It also affects the home screen's ThinkingLine, which is intended.
- Generating mark: a new `GeneratingMark` (a standalone AnsariMarkPulse at 32px, the sidebar emblem size, hoisted into constants/ansariMark.ts) in the chat footer while `streamingText && !failedQuestion`.
- Architect added scope mid-plan: (a) hide Copy/Share on the streaming bubble (`generating` prop); (b) size 13 -> 48 -> 32 (sidebar mark); (c) a khushu'-only bracket strip, later REPLACED by a general `stripUnbackedCitations` (lib/citations.ts) applied in mapConversationDetail (the khushu'-substituted message is exempt) and in onEvent through a raw-text ref. It is never applied to the already-cleaned state.
- Decision: the mark ends at the hand-off, not at SSE `done` (isPending). Copy/Share return at the hand-off, so ending both in one commit avoids two layout shifts.
- Open question sent to the architect: should the exempt khushu' message still have a model-written trailing `Citations:` block stripped? Otherwise it duplicates the sample footnote pills.
