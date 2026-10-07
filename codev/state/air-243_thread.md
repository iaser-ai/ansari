# air-243 thread

- Swapped `SuggestionLine`'s `trending-up` Feather glyph for `compass` (and the three comments that called it a "trend mark").
- First topic renamed "Prayer" -> "To get you started"; questions now wudu / crypto / "strengthen my faith". Used a curly apostrophe in "What’s" to match the existing "Qur’an" string in the same file.
- Added `lib/suggested-topics.test.ts` (flattened order + source scan for the icon). Negative-tested against HEAD: 3 of 4 fail on the old source, all pass on the new.
- Full suite 527/527, typecheck clean.
