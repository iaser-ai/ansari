# pir-228 thread

## Plan phase
- Root cause confirmed: RNW root <Text> defaults dir="auto" (react-native-web Text/index.js:106-108); iOS/Android first-strong too. Single newlines stay inside one paragraph <Text>, so "Arabic line\nEnglish line" (the facilitator's verse+translation shape) is one RTL-based block.
- Plan: detect by Arabic script (not citation matching). Lift Arabic-only lines into a `passage` block (Amiri, RTL, right-aligned); pin every other block LTR (web dir, iOS writingDirection, Android LRM); brass accent rule on quotes holding a passage; whole-answer RTL mode for Arabic/Urdu answers (no lifting).
- Open questions to reviewer: brass rule on unquoted passages? Amiri for inline Arabic runs?

## Implement phase
- Architect answers folded in: a bare (unquoted) passage gets the same brass treatment, done by having the parser wrap passage + rest-of-paragraph in a `quote`; inline Arabic runs set in Amiri at 1.15x.
- Porch trap hit AGAIN (4th builder): reading the implement prompt via `porch next` right after plan approval recorded `dev-approval` gate-requested (bef0f37) before any code existed.
- jsdom quirk: cssstyle drops an inline `font-family: Amiri_400Regular` (accepts `Foo`), and RNW static styles are atomic classes getComputedStyle won't resolve; test reads the class's CSS rule instead. Moved the inline-run fontFamily into StyleSheet.
- Negative test: removing the web `dir` pin fails 5/8 AnswerProse tests.
- Visual check via temp uncommitted route `app/preview228.tsx` + headless Chrome CDP; before/after screenshots show the bug and the fix (light + dark).

## Dev-approval feedback round 1 (architect visual review)
- (1) Scripture quote is now a box: brass wash (accent 0.06) + brass hairline (0.32) at RADIUS.lg; ink-rule quotes unchanged.
- (2) Trailing `(reference)` is lifted off the Arabic line (`splitTrailingReference` → `passage.reference`) and set beneath the verse+translation as a byline between two short brass rules.
- (3) No round marker exists in the app: inline CitationChip and the Sources pills both use the brass superscript figure. The raw `[N]` in the first screenshots was an artifact of my preview passing no citations. Preview now uses SAMPLE_CITATIONS; chip style unchanged, and the point is raised with the architect rather than inventing a style.
- (4) Verse and translation are centred together inside the box.

## Dev-approval feedback round 2: brass disc behind the inline marker
- CitationChip: lining figure on a brass-tinted disc (accent 0.18, 18px); web = inline-flex span (stays selectable), native = inline View (nested Text can't take a radius).
- Gotcha: an inline-flex disc is an atomic inline, and Chrome breaks before it even with U+2060 next to it, and wraps a space after it onto an empty line. That opened a gap under the paragraph. Measured with getClientRects over CDP, not by eye. Fix: AnswerProse sets the last word + chip in one `white-space: nowrap` run and drops the model's space before the marker.

## Dev-approval feedback round 3: source pill on the box edge
- User asked for the citation number and title combined in an oval like the footer pills, pinned to the box's base with the border through its centre, tappable, and labelled by kind. Built as `ScripturePill`: opaque paper base plus a brass inset wash, so the hairline doesn't show through. Markers shown on the pill are suppressed inline in the box, and the pill replaces the written-reference byline (the byline stays as a fallback when nothing resolves).
- `sourceKindLabel` was moved to lib/footnote-groups.ts and the folio uses it (it had its own SOURCE_LABEL map).
- Near miss: a reanimated mock without `Easing` failed the whole AnswerProse test file at load, and the test count dropped 445→431 while my grep showed only "Tests N passed". Always check `Test Files` too.
