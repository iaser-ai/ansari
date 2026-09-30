# PIR #204 — Review iteration 1: rebuttals

## Codex — REQUEST_CHANGES

### 1. "The row can exceed two lines at large Dynamic Type"

**Finding accepted. Code change rebutted. Documentation corrected (`814ba92`).**

Codex is right that the row is not capped at two lines. The `flexWrap` row has no line limit, and text scaling is uncapped, so at the accessibility sizes the row wraps to three or more lines.

The code stays as it is because the app never caps text scaling: `maxFontSizeMultiplier` / `allowFontScaling` appear nowhere in `prototypes/ansari-expo/app` or `components`. A cap on this row alone would make it the one line that ignores the reader's text-size setting, and it would shrink the text for exactly the readers who asked for it larger. The request ("1 line, max 2") holds at default size: 1 line on a phone, and 2 on a narrow window or at moderately larger text.

What was actually wrong was my claim that the row wraps to "at most 2 lines at the largest Dynamic Type". I corrected that claim in the review file, in the plan's revision note, and in the `ThinkingLine.tsx` comment.

Escalated to the human at the pr gate. If they want a hard two-line cap, the change is `maxFontSizeMultiplier` (about 1.3) on the row's `Text` nodes.

### 2. Review file: test count and native verification

**Fixed (`814ba92`).** The review now says 8 `sourceProgress` tests (11 new in total, not 12), and a VoiceOver/TalkBack step is listed under How to Test Locally.

## Claude — APPROVE (nits)

- Stale `formatTraceLine`-era doc comments in `chat-trace.ts`: fixed.
- Per-state opacity is not asserted in the tests: already disclosed, and verified by eye at dev-approval.
- The polite live region may be chatty on TalkBack: left as is and flagged in the review for a device check.

## Gemini — COMMENT (skipped)

The `agy` CLI is not installed on this machine, so there is no review content. Porch treats this as a non-blocking skip.
