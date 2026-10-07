# PIR Plan: Honor Qur'an/Hadith quotations in answer prose, pin English to LTR

## Understanding

Two problems, one code path (`lib/markdown.ts` → `components/AnswerProse.tsx`).

**Bug: English sometimes renders right-to-left.** No text block in `AnswerProse` sets a
direction, so every block's base direction comes from its first strong character:

- **Web** (where the prototype is mostly used): react-native-web gives every *root* `<Text>` `dir="auto"`
  by default (`node_modules/react-native-web/dist/exports/Text/index.js:106-108`). The browser takes the
  element's direction from its first strong character.
- **iOS**: `NSWritingDirectionNatural`, the same first-strong rule. **Android**: `FIRSTSTRONG`.

A paragraph is one `<Text>` (`AnswerProse.tsx:238-250`), and single newlines stay *inside* that paragraph
(`markdown.ts:701-717`, "Single newlines are kept as line breaks"). The model is told to give "the
ayah number, Arabic text, and translation" (`apps/api/lib/ai/prompts/facilitator.ts:25-26`), and it
usually writes the Arabic on one line and the English on the next. For example:

```
> قَدْ أَفْلَحَ ٱلْمُؤْمِنُونَ
> Successful indeed are the believers [1]
```

That becomes **one** quote paragraph that starts with Arabic. The whole block, English line included,
gets an RTL base. The English is right-aligned, and its punctuation and the `[1]` chip move to the wrong
end. The same thing happens without a `>`.

**Design gap.** Scripture looks like any other text. A `quote` is a heroInk left rule plus a 16px indent
(`AnswerProse.tsx:342-358`, `546-550`), in the same face and size as the prose. Arabic is set in
Literata, which has no Arabic glyphs, so it falls back to the platform's default Arabic font. The folio
(`SourceFolio.tsx`) already has a vocabulary for this: Amiri (`fonts.arabic`) for Arabic, the brass
`colors.accent`, plain prose (not italic) for the translation, and italic only for attribution. None of
it reaches the answer body.

## Proposed Change

The approach detects **Arabic script**, not citations. This is the simpler approach recommended in the
issue, and it is the one that fixes the bug: the bug fix and the design both need to know which lines are
Arabic. Matching quotes against `Citation[]` would also miss the most common case. The streaming bubble
has no citations at all, so a verse would change style when the persisted answer lands.

### 1. A shared script classifier: `lib/script.ts` (new)

- `isArabicScript(ch)` / `ARABIC_RUN = /[\p{Script=Arabic}][\p{Script=Arabic}\p{M}\s‌‍،؛؟.]*/gu`
  (with the trailing whitespace trimmed).
- `isArabicPassageLine(line): boolean`. True when the line has at least one Arabic letter and **no Latin
  letters**, ignoring markdown punctuation, `[N]` markers, digits, and **one trailing parenthetical
  reference** (`… (Qur'an 23:1)`, `… (2:255)`). The rule is strict on purpose. A line such as
  `Allah says: قَدْ أَفْلَحَ…` stays English prose, so its English lead never lands at the right end of an
  RTL line.
- `isMostlyArabic(text)` moves here from `lib/document-citations.ts:96-101`, and that file imports it. It
  is the same function, so there is one definition of "Arabic" in the app.
- `answerDirection(source): 'ltr' | 'rtl'`. Returns `rtl` when the whole answer is mostly Arabic-script
  letters. This covers an answer written in Arabic or Urdu: the facilitator answers in the user's
  language (`facilitator.ts:10`).

### 2. Parser: lift Arabic lines into their own block (`lib/markdown.ts`)

- Add `| { type: 'passage'; spans: Span[] }` to `Block`. The doc comment describes it as "a line or run of
  lines in Arabic script, set apart from the prose around it".
- In the paragraph branch of `parseBlocks` (`markdown.ts:698-717`), group the paragraph's collected lines
  into maximal runs by `isArabicPassageLine`. Each Arabic run becomes a `passage`, and each other run
  stays a `paragraph`. A paragraph with no Arabic lines takes exactly today's path, so its output is
  unchanged.
- The rule is recursive through `parseBlocks`, so it also applies inside quotes and list items.
- `parseAnswer(source, { lift })`. When the answer is RTL (step 1), lifting is off. In an Arabic or Urdu
  answer every line is Arabic, and setting all of them as scripture would honor nothing. Urdu also reads
  badly in a Naskh face.
- Trade-off: an emphasis run that spans an Arabic line and an English line is split at the boundary and
  degrades to literal `*`. This is the parser's existing "everything degrades" contract, and it is rare.

### 3. Renderer (`components/AnswerProse.tsx`)

**Direction pinning (the bug fix).** Every text-bearing block gets an explicit base direction from the
answer's direction (`ltr` for an English answer): paragraph, heading, list marker, table cell, and the
paragraphs inside quotes. A shared helper `dirProps(direction)` returns:

- web: `dir` on the root `<Text>`. RNW passes it to the element and stops defaulting to `auto`.
- iOS: `writingDirection` style.
- Android (`writingDirection` is iOS-only): a leading U+200E LEFT-TO-RIGHT MARK in the block's text, so
  `FIRSTSTRONG` resolves to LTR. This is added only on Android, so web/iOS selection and copy stay clean.
  Copy/Share use `message.content`, not the rendered text, so they are unaffected everywhere.

An Arabic run *inside* an LTR paragraph still reads right-to-left within the line. That is the Unicode
bidi algorithm's job, and it does it well once the paragraph's base direction is fixed.

**Inline Arabic runs.** In `renderSpans`'s `text` case, split text on `ARABIC_RUN` and wrap each Arabic
run in `<Text style={{ fontFamily: fonts.arabic, fontSize: size * ARABIC_SCALE }}>`. A short phrase such
as `khushu' (خشوع)` is then set in the folio's Naskh instead of a system fallback. `ARABIC_SCALE ≈ 1.15`
because Amiri's x-height runs small next to Literata. The exact value is tuned by eye at implementation.
This change is typographic only, with no color, and it is skipped in an RTL answer.

**`passage` block (the honored source).** The treatment copies the folio:

- Amiri (`fonts.arabic`), about 1.3× body size, with the open leading Amiri needs for its marks (about
  2× size, as the folio's 26/52 does).
- `textAlign: 'right'`, RTL direction via `dirProps('rtl')`, in `colors.strongForeground`.
- `marginTop` of about 18 and a small `marginBottom`, so the verse has air. The English translation that
  usually follows stays an ordinary LTR prose paragraph, upright and not italic, the same as in the folio.
- Footnote chips inside a passage still render as `CitationChip`s.

**Scripture quote.** A `quote` block whose children include a `passage` changes its left rule from
heroInk to the brass `colors.accent` (at roughly the folio's 0.6 opacity). This uses the same single
brass hue the folio is "illuminated" in, and it is the only change to the quote. A quote of a scholar
or of the question keeps today's heroInk rule. No ornament glyph, frame, or background is added, to
keep the result "distinguished yet simple".

Update the component doc comment, which currently states quotations get "no italics … the indent is the
signal", to describe passages and scripture quotes.

### 4. Docs

- `codev/resources/arch.md` → "Prototype chat display": add a short **Scripture in prose (issue #228)**
  paragraph. It covers: direction is pinned per block from `answerDirection`, never left to `auto`; Arabic
  lines are lifted to `passage` by script, not by citation; and the brass rule marks a quote that holds
  a passage.

## Files to Change

- `prototypes/ansari-expo/lib/script.ts` (new): `isMostlyArabic`, `isArabicPassageLine`, `ARABIC_RUN`
  splitting helper, `answerDirection`
- `prototypes/ansari-expo/lib/script.test.ts` (new)
- `prototypes/ansari-expo/lib/document-citations.ts:96-101`: import `isMostlyArabic` from `lib/script`
- `prototypes/ansari-expo/lib/markdown.ts:65-76` (Block type), `:698-717` (paragraph branch → passage
  lifting), `:727-730` (`parseAnswer` option)
- `prototypes/ansari-expo/lib/markdown.test.ts`: passage-lifting cases
- `prototypes/ansari-expo/components/AnswerProse.tsx`: `dirProps`, direction on every text block,
  inline Arabic runs in `renderSpans`, `passage` case in `renderBlock`, accent rule on scripture quotes,
  styles, doc comment
- `prototypes/ansari-expo/components/AnswerProse.test.tsx` (new, jsdom + RNW like
  `AnswerMessage.test.tsx`)
- `codev/resources/arch.md`: Prototype chat display section

## Risks & Alternatives Considered

- **Risk: a passage is misclassified.** For example, an Arabic line with a Latin gloss in the middle stays
  prose. That is the safe failure: it renders LTR with the Arabic inline, and it is no worse than today
  (better, since the direction is pinned). The strict no-Latin rule is chosen so the opposite failure,
  English pushed into an RTL line, cannot happen.
- **Risk: style flips while streaming.** A line becomes a `passage` as soon as its first Arabic letter
  arrives, and it stays one unless a Latin letter arrives later on the same line. Because the rule is
  strict, the flip happens at most once per line, which matches how a table already resolves mid-stream.
  It will be checked live.
- **Risk: Android LRM.** An invisible U+200E sits at the start of each native-Android block. It is
  harmless for display, and native drag-selection could include it. The prototype is web-first. The
  alternative, `textDirection` via a native module, is out of scope.
- **Risk: Amiri inline scale changes line height.** A larger inline run in a nested `<Text>` can open
  that line's leading. Mitigation: the scale stays modest and the parent's fixed `lineHeight` stays as
  is. Long Arabic text is lifted into a passage anyway.
- **Alternative: match quotes against `Citation[]`.** Rejected. It is precise only after `/documents`
  resolves, the streaming bubble has none, and the model often writes the verse without `>`.
- **Alternative: pin `ltr` only, with no passage block.** This fixes the direction, but an Arabic line
  inside an LTR paragraph is then *left*-aligned. That is wrong for Arabic, and it does nothing for the
  design request.
- **Alternative: the folio's `۝` ornament rule above each passage.** Held back as too heavy for
  "distinguished yet simple" inside every answer. It is a small addition if the reviewer wants more
  ceremony.

### Open questions for the reviewer

1. Should an Arabic passage that is **not** inside a `>` quote also get the brass rule, or only Amiri
   and right alignment as proposed? The issue is that the translation which follows sits outside the
   rule.
2. Is the inline-Arabic face change (Amiri for short runs inside English sentences) wanted, or should
   only lifted passages change face?

## Test Plan

**Unit (vitest)**
- `lib/script.test.ts`:
  - `isArabicPassageLine` is true for a pure ayah, an ayah with `[1]`, an ayah with `(2:255)`, and an
    ayah with `(Qur'an 23:1)`.
  - It is false for `Allah says: قَدْ…`, English only, transliteration (`Bismillah…`), and an empty
    line.
  - `answerDirection` is `rtl` for an Arabic answer and an Urdu sample, and `ltr` for an English answer
    containing verses.
  - The near-miss negative tests are taken from the lessons.
- `lib/markdown.test.ts`:
  - Arabic line + English line in one paragraph → `[passage, paragraph]`.
  - The same inside `>` → quote containing `[passage, paragraph]`.
  - English-only paragraphs parse identically to before (snapshot against current output).
  - With `lift: false`, nothing is lifted.
- `components/AnswerProse.test.tsx` (jsdom/RNW):
  - The English paragraph renders `dir="ltr"`, and the passage renders `dir="rtl"` with the Amiri
    family.
  - The scripture quote's border colour is `accent`, and a plain quote's is not.
  - An RTL answer gets `dir="rtl"` on its paragraphs and has no passage.
- `document-citations` tests still pass after the move.
- `pnpm test` and typecheck pass.

**Manual (web, `afx dev`)**: a debug/sample thread, or a real question that draws verses (for example,
"What does the Qur'an say about khushu' in prayer?") or hadith (for example, "the hadith of intentions").
Check that:
- English lines are left-aligned with the `[N]` chips on the right end.
- The Arabic sits right-aligned in Amiri above its translation.
- A quoted verse carries the brass rule, and a non-scripture quote does not.
- Streaming shows no visible flicker.
- Dark mode is legible.
- An Arabic-language question gets an answer that is fully RTL and not set as scripture.

**Cross-platform**:
- iOS simulator: the same answer, to confirm `writingDirection` pins LTR.
- Android, if available: confirm the LRM path.
- Screenshots of before and after go in the PR.
