# PIR Plan: Compact hadith citations with multiple grades

## Understanding

A hadith graded by more than one scholar shows up in the prototype as a tall box. Each grade gets its own line, there is a lot of empty space between lines, and a grader who gave no verdict still shows up as a bare `2:`.

Root cause (confirmed in code):

- `apps/api/lib/tools/search-hadith.ts:103,116`: Kalimat's `grade_en` is passed through untouched as `source.data.grade`. It is one opaque string.
- `prototypes/ansari-expo/lib/document-citations.ts:137,151`: `grade = str(json.grade)` goes directly into `sourceTitle` as `Grade: ${grade}`. Nothing splits it or limits its length.
- `sourceTitle` is displayed in two places. Neither sets `numberOfLines`, so every `\n` in it becomes a real line break:
  - **The footnote pill** under the answer: `components/AnswerMessage.tsx:171-194` (styles `footnoteLine` / `footnoteText`, ~287-306). This is the "citation card" that grows past the screen height.
  - **The source folio** in the panel/sheet: `components/SourceFolio.tsx:58-60` (style `sourceTitle`, 177-181).

Unconfirmed: none of the fixtures in the repo contain a multi-grade value (they all use `grade_en: 'Sahih'`), so the exact separator is inferred from the symptom. The parser therefore accepts both newline-separated entries and a single-line `1: … 2: …` run. Implementation will check one real response if a thread showing the bug can be reached (AbuDaud · Purification), and the review will say whether that happened.

## Proposed Change

### 1. Parse grades (`lib/document-citations.ts`)

Add an exported, pure function `parseGrades(raw: string | undefined): string[]`:

- Split on newlines. If the result is still a single line that starts with `1:`, also split it on the numbered prefixes `(?:^|\s)\d{1,2}[:.)]\s*`. The split only applies when the string begins with `1:`, so a grade that happens to contain a colon cannot be broken up.
- Remove the leading `N:` / `N.` / `N)` from each entry, collapse runs of whitespace, and trim.
- Drop entries that end up empty, which is how the bare `2:` disappears. Also drop exact duplicates.
- A plain `'Sahih'` gives `['Sahih']`. An empty or missing value gives `[]`.

Hadith case in `toCitationFields`:

- `grades = parseGrades(str(json.grade))`
- `sourceTitle` becomes `chapter · <primary>` when there is one grade, or `chapter · <primary> (+N more)` when there are several, where N = `grades.length - 1`. It stays on one logical line.
- The `Grade:` prefix stays. It is the only thing that tells a reader "Sahih" is a grade and not part of the chapter name. Result: `Purification · Grade: Sahih (+2 more)`.
- The full list is returned as a new optional field, `grades`, set only when there are two or more grades.
- The fallback reference (`head`, used when `collection` is missing) also gets its whitespace collapsed. It is built from the doc title, which carries the raw grade.

### 2. Carry the full list (`lib/api/types.ts`)

`Citation` is generated in `vendor/api-client-react` and is reference-only, so that file stays as it is. `lib/api/types.ts` will re-export `Citation` as the generated interface plus `grades?: string[]`. All UI code already imports `Citation` from `@/lib/api`, so no other imports change.

### 3. Show the full list on tap (`components/SourceFolio.tsx`)

Tapping a pill already opens that source's folio in the panel or sheet, so the folio is where "the full grade list on tap" goes. No new tooltip is added.

- When `citation.grades` is present, a compact list appears under the `sourceTitle` line: a small `GRADES` label, then one short line per grade, numbered 1..n over the non-empty grades only. It uses a tight line height and has no gaps between rows.
- In the folio, `sourceTitle` then shows only the chapter part, so the `(+N more)` summary doesn't appear twice. The component decides this, so `sourceTitle` stays one plain string everywhere else.

### 4. Bound the pill (`components/AnswerMessage.tsx`)

- The pill's `<Text>` gets `numberOfLines={2}` and `ellipsizeMode="tail"`. The pill can then never be taller than two lines, whatever the data contains, and a long book or chapter name ends in "…" instead of wrapping further.
- The issue asks for `numberOfLines={1}` on the book name alone. That isn't possible while the marker, reference and source are nested spans in one `<Text>`, and splitting them into sibling `<Text>`s would break how the line wraps as a single sentence. A two-line limit on the whole pill does the same job and matches the issue's "one or two lines max". If you prefer the single-line version, I'll make the pill a row: `marker + reference` fixed, then the source as its own `numberOfLines={1}` text.
- The pills stay stacked in the existing tight column (`gap: 8`). Once the height is bounded, that column meets "stack tightly". I'm not switching to horizontal wrapping (see alternatives).

### 5. `SourceStack.tsx`

No change. Its per-leaf spacing (`spaced`, `leaf` padding) is not what caused the height; the unbounded text inside the folio was. It was listed in the issue as relevant, and I checked it.

## Files to Change

- `prototypes/ansari-expo/lib/document-citations.ts:133-159`: add `parseGrades`, build the hadith `sourceTitle` with the primary grade plus `(+N more)`, set `grades`, collapse whitespace in the fallback reference.
- `prototypes/ansari-expo/lib/api/types.ts`: `Citation` becomes the generated interface plus `grades?: string[]`.
- `prototypes/ansari-expo/components/SourceFolio.tsx:58-60, 177+`: chapter-only title when grades are present, plus the compact grades list and its styles.
- `prototypes/ansari-expo/components/AnswerMessage.tsx:171-194`: `numberOfLines={2}` and `ellipsizeMode="tail"` on the pill text.
- `prototypes/ansari-expo/lib/document-citations.test.ts`: new tests (below).
- `prototypes/ansari-expo/lib/sample-citations.ts`: add one multi-grade hadith sample, so the offline demo shows the case.

## Risks & Alternatives Considered

- **Risk: the real separator differs from what I've assumed** (for example `;` or `|`). Mitigation: the parser never throws, and the pill is limited to two lines no matter what the data contains, so the worst case is a truncated pill, not a card that fills the screen. I'll check against a live thread if I can reach one.
- **Risk: numbered-prefix splitting damages a legitimate single grade.** It only runs when the string begins with `1:`. Tests will include a near-miss (a grade with an internal colon) that must stay whole.
- **Alternative: parse in `apps/api` and send `grades: string[]`.** Rejected. The issue says to fix this on the client, and changing the wire shape of a stored `document` block affects the frozen mobile contract and spec 168's derived documents.
- **Alternative: a tooltip or popover on the pill for the grade list.** Rejected. Tapping the pill already opens the folio, and a second tap target inside a 44pt pill would compete with that.
- **Alternative: wrap the pills horizontally (row + `flexWrap`).** Rejected for now. It would redesign the footnote area, which the issue does not require once the height is bounded.

## Test Plan

- **Unit (`lib/document-citations.test.ts`):**
  - `parseGrades`: `'Sahih'` gives `['Sahih']`; `''` and `undefined` give `[]`; the issue's `'1: Sahih\n2:\n3: Sahih Mauquf\n4: The chain is da\'if'` gives three grades with no empty entry; blank lines (`\n\n`) between entries are ignored; the single-line `'1: Sahih 2: Hasan'` gives two; the near-miss `'Hasan: according to Al-Albani'` stays one entry.
  - Hadith mapping with a multi-grade doc: `sourceTitle === 'Purification · Grade: Sahih (+2 more)'`, `grades` has length 3, and neither contains a `\n`.
  - The existing single-grade test is unchanged (`'Times of the Prayers · Grade: Sahih'`, no `grades` key).
- `pnpm --filter ansari-expo-prototype test` and `typecheck` pass.
- **Manual (web, `afx dev`):** ask a question that returns multi-graded hadith (e.g. about wudu, which should cite AbuDaud · Purification), or use the multi-grade sample citation. Check that:
  - each footnote pill is one or two lines, and ends in "…" when the text is long
  - no pill shows a bare `2:`
  - tapping the pill opens the folio with the chapter and a compact numbered grades list, with no large gaps
  - single-grade hadith and Qur'an pills look the same as before
- **Cross-platform:** `numberOfLines` behaves differently on web (CSS line-clamp) and native. Check the pill on the iOS simulator or Expo Go if one is available; otherwise web only, and the review will say so.
