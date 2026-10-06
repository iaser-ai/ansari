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
