# PIR Review: Honor Qur'an/Hadith in answer prose; stop English rendering right-to-left

Fixes #228

## Summary

English inside answers sometimes rendered right-to-left. No block set a direction, so a block opened by Arabic (a verse followed by its translation) took an RTL base on the web, where react-native-web defaults a root `<Text>` to `dir="auto"`, and on iOS and Android, which apply the same first-strong rule. Every answer block now has an explicit direction.

Lines written wholly in Arabic are lifted out of the prose and set as scripture. Each sits in a centred box in the folio's Amiri face and brass, with its translation directly beneath it. The source is named on a tappable pill on the box's lower edge, giving its number, its kind (Qur'an, Hadith, Scholarly work) and the reference. Detection is by script, not by citation, so the treatment also applies while an answer is still streaming.

## Files Changed

- `prototypes/ansari-expo/lib/script.ts` (+124 / -0): new. Arabic-letter classification, `isArabicPassageLine`, `splitTrailingReference`, `answerDirection`, `splitArabicRuns`
- `prototypes/ansari-expo/lib/script.test.ts` (+119 / -0): new
- `prototypes/ansari-expo/lib/markdown.ts` (+105 / -11): `passage` block, `liftPassages` (one passage per Arabic line; wraps an unquoted verse in a quote), `parseAnswer(source, { lift })`
- `prototypes/ansari-expo/lib/markdown.test.ts` (+114 / -0)
- `prototypes/ansari-expo/components/AnswerProse.tsx` (+662 / -28):
  - pinned direction per block (`pinDirection`)
  - inline Arabic set in Amiri
  - the scripture box, `ScripturePill` and the fallback byline
  - balanced centred lines
  - binding of each `[N]` marker to its word and of each ayah number to its verse
- `prototypes/ansari-expo/components/AnswerProse.test.tsx` (+322 / -0): new, run through jsdom and react-native-web
- `prototypes/ansari-expo/components/CitationChip.tsx` (+96 / -37): the inline marker is now a brass figure on a brass-tinted disc
- `prototypes/ansari-expo/lib/footnote-groups.ts` (+18 / -0): `sourceKindLabel`, shared with the folio
- `prototypes/ansari-expo/components/SourceFolio.tsx` (+2 / -7): uses `sourceKindLabel`
- `prototypes/ansari-expo/lib/document-citations.ts` (+1 / -7): imports the shared `isMostlyArabic`
- `codev/resources/arch.md`, `arch-critical.md`, `lessons-learned.md`, `lessons-critical.md`: see the two sections below
- `codev/plans/228-prototypes-ansari-expo-disting.md`, `codev/state/pir-228_thread.md`

## Commits

- `28d34ff` [PIR #228] Wider gap between verse/translation pairs
- `49cece9` [PIR #228] Balance scripture lines; one passage per verse; count only Arabic letters
- `60ffcb8` [PIR #228] More air above the Arabic at the head of a scripture box
- `9fed8d9` [PIR #228] Scripture pill number set level with its kind label
- `9990b19` [PIR #228] Scripture box names its source on a pill riding its lower edge
- `4ac330d` [PIR #228] Inline source marker on a brass disc, bound to the word it cites
- `ae2df8d` [PIR #228] Scripture as a centred brass box with its reference as a byline
- `a148ffc` [PIR #228] arch.md: scripture in prose and pinned direction; thread log
- `6042be4` [PIR #228] Tests: script classifier, passage lifting, pinned direction
- `31acc39` [PIR #228] Pin answer blocks' direction; set Arabic passages as scripture
- `2d25541` [PIR #228] Plan draft
- `bc260b9` Merge of `origin/develop` (#231 favicon)

## Test Results

- `tsc --noEmit` (prototype): ✓ clean
- `vitest run` (prototype): ✓ 30 files, 463 tests. This change adds 61 tests: 2 new files (`script.test.ts`, `AnswerProse.test.tsx`) plus additions to `markdown.test.ts`. The other 6 new tests come from the merged #231.
- Negative-tested:
  - Removing the web `dir` pin fails 5 of the original 8 render tests.
  - Reverting the Arabic-letter regex fails both new numbered-verse cases.
- Porch `build`/`tests` checks pass with `apps/api/.env.ci` loaded. Without it, apps/api's `next build` fails Zod env validation (USUL_API_TOKEN etc.); this happens on develop too and is unrelated to this change.
- Manual, on the web, using headless Chrome over CDP against a temporary preview route that was never committed:
  - Before/after screenshots in light and dark mode, at 340–720px.
  - Line layout measured with `Range.getClientRects()`. In every multi-line scripture block the last line is at least 79% of the widest at 340/360/390/420/720px. Before this change, "their prayer." was under 20%.
  - The human reviewed it over several rounds at the `dev-approval` gate: box, centring, pill, number size, padding, verse pairing.
- **Not verified on device:**
  - iOS (`writingDirection`, `lineBreakStrategyIOS`, the inline `View` disc)
  - Android (the LRM mark, `textBreakStrategy`)
  - The pill's `boxShadow` inset wash, which needs the new architecture (Expo 54 default)
  - Android clipping of the pill. `pillRow` hangs half outside the box (`bottom: -PILL_HEIGHT/2`), and Android has a history of clipping absolutely-positioned children that overflow a parent with a background and radius.

## Architecture Updates

- **COLD** `codev/resources/arch.md`, "Prototype chat display": a new paragraph, **Scripture in prose and text direction (issue #228)**. It covers:
  - the per-answer direction and the per-platform pin
  - detection by script and the letters-not-script rule
  - one passage per Arabic line, and the self-wrapping quote
  - the scripture box with its pill on the box edge, marker suppression, and the byline fallback
  - balanced centred lines
  - the inline disc and the nowrap word binding
- **HOT** `codev/resources/arch-critical.md`: the "Prototype chat display" map entry now also says "consult when touching text direction, Arabic passages, or the scripture box and its source pill". No new hot fact. Nothing here constrains code outside `AnswerProse`/`markdown`.

## Lessons Learned Updates

- **COLD** `codev/resources/lessons-learned.md`: a new section, **Scripture in answer prose — prototype (issue #228)**. It covers:
  - react-native-web's `dir="auto"` default
  - Arabic script vs Arabic letters
  - Chrome breaking in front of atomic inlines
  - `text-wrap: balance` vs forced breaks
  - jsdom's blindness to react-native-web styles
  - suite-load failures hiding behind a test-count grep
  - not recovering structure the model didn't write
  - the `porch next` trap, which hit a fourth builder
- **HOT** `codev/resources/lessons-critical.md`: the map was at its 12-topic cap. #65 and #189 (both streaming render) were merged into one map line, and #228 was added. Both cold sections are unchanged. No new critical lesson: the test-count lesson is an instance of the existing "prefer loud failures" rule.

## Things to Look At During PR Review

- **The widest visual change is not scripture-specific.** `CitationChip`'s inline `[N]` marker changes in EVERY answer: a brass superscript figure becomes a brass figure on a brass-tinted disc, bound to its preceding word. The human requested and approved this at `dev-approval`; it goes beyond the plan's text.
- **3-way consultation:**
  - Codex: APPROVE.
  - Claude: APPROVE, with documentation notes, folded in here.
  - Gemini: skipped, because its CLI is not installed; this is non-blocking.
  - Claude's two cosmetic asymmetries are left as is:
    - A lead-in written *inside* a `>` quote is centred into the box with the verse.
    - A non-reference trailing parenthetical such as `(see note)` on an Arabic line would be lifted to the byline.

- **Script detection is strict on purpose** (`isArabicPassageLine`). A line is lifted only when every letter is Arabic, ignoring `[N]` and one trailing `(reference)`. `Allah says: قَدْ…` therefore stays English prose. The safe failure is Arabic left inline in an LTR paragraph, which still reads correctly.
- **An unquoted verse is wrapped in a `quote` by the parser** (`liftPassages`), so a verse looks the same whether or not the model wrote `>`. A lead-in before the first Arabic line stays outside the box.
- **Markers inside a box move onto its pill** (`ctx.pinnedMarkers`, `markersIn`). If the box cites nothing that resolves, the reference the model wrote after the verse is shown as a byline instead.
- **Web-only CSS passed through react-native-web by casts:** `inline-flex` for the disc, `white-space: nowrap` for word binding, `text-wrap: balance`, and an inset `boxShadow` for the pill's wash. Each has a comment explaining why. The native equivalents are the inline `View` disc, `textBreakStrategy` and `lineBreakStrategyIOS`.
- **The answer's direction is computed over the whole streamed text** (`answerDirection`, more than 60% Arabic letters means RTL). An English answer that opens with a long verse could therefore render RTL for its first line or two while streaming, then flip.
- **Multi-verse quotes with one combined translation** can't be split into verse pairs here. The renderer pairs verses only when the model alternates Arabic and English lines. **#234** (apps/api facilitator prompt, cross-boundary, needs @amrmelsayed and @waleedkadous) asks the model to write that format.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder pir-228 → **Review Diff**
- **Run dev**: VSCode sidebar → **Run Dev**, or `afx dev pir-228`
- **What to verify**:
  - Ask a question that draws verses and hadith, e.g. khushu' in prayer, or the hadith of intentions.
  - English lines read left to right.
  - Each verse is set in Amiri, centred over its translation, inside a brass box.
  - The box's pill names the kind and the reference, and opens the folio when tapped.
  - A plain `>` quote keeps the grey rule.
  - An answer written in Arabic reads fully right to left, with no boxes.
  - Check light and dark mode, and phone and desktop widths.
