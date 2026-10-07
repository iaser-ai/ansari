# air-243 thread

- Swapped `SuggestionLine`'s `trending-up` Feather glyph for `compass` (and the three comments that called it a "trend mark").
- First topic renamed "Prayer" -> "To get you started"; questions now wudu / crypto / "strengthen my faith". Used a curly apostrophe in "What’s" to match the existing "Qur’an" string in the same file.
- Added `lib/suggested-topics.test.ts` (flattened order + source scan for the icon). Negative-tested against HEAD: 3 of 4 fail on the old source, all pass on the new.
- Full suite 527/527, typecheck clean.
- Review feedback (human, via preview): remove the icon from the three desktop sample lines entirely and line their text up with the composer placeholder. Dropped the `Feather` glyph from `SuggestionLine` and the matching `PlaceholderMark` from the loading skeleton. The existing `paddingLeft: 38` now puts the first letter at the placeholder's x: measured in headless Chrome over CDP at 1440 wide, both at 556px. The Chrome extension wasn't connected.
- The source-scan test now asserts `SuggestionLine` contains no `<Feather`. It fails if the compass is put back.
