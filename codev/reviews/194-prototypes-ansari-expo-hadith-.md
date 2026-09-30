# PIR Review: Compact hadith citations and grouped source pills

Fixes #194

## Summary

A hadith graded by several scholars showed its raw multi-line `grade` string in the source pill and the folio, and every line break became a real line. That made one citation fill most of the screen. The prototype now parses the grade into separate verdicts, dropping empty ones such as the bare `2:`. The pill shows the first verdict plus `(+N more)`, and the folio lists every verdict. Reviewer feedback at `dev-approval` then widened the scope to the whole foot of the answer:

- The pills are grouped under **Qur'an / Hadith / Scholarly works** headings and wrap side by side.
- Each group folds after three rows behind a **View N more** toggle.
- The block has a **Sources · N** title.
- Each pill is capped at two lines.

## Files Changed

- `prototypes/ansari-expo/components/FootnoteGroup.tsx` (+275 / -0): one group of pills (a heading, pills that wrap side by side, the measured three-row fold)
- `prototypes/ansari-expo/components/AnswerMessage.tsx` (+30 / -87): the Sources title, and one `FootnoteGroup` per kind in place of the old single column
- `prototypes/ansari-expo/components/SourceFolio.tsx` (+41 / -3): a compact numbered GRADES list; the title leaves out the grade summary when the list is shown
- `prototypes/ansari-expo/lib/document-citations.ts` (+53 / -3): `parseGrades`, `titleWithoutGrades`, the hadith title as primary grade + `(+N more)`, whitespace collapsed in the fallback reference
- `prototypes/ansari-expo/lib/footnote-groups.ts` (+76 / -0): `groupFootnotes`, `footnoteLabel`, `foldAt`
- `prototypes/ansari-expo/lib/api/types.ts` (+17 / -1): `Citation` = the generated interface + `grade?` / `grades?`
- `prototypes/ansari-expo/lib/document-citations.test.ts` (+81 / -1), `lib/footnote-groups.test.ts` (+82 / -0): tests
- `codev/plans/…`, `codev/state/pir-194_thread.md`, `codev/projects/…/status.yaml`: protocol artifacts

## Commits

- `9a23ca7` [PIR #194] Thread: fold feedback
- `1442178` [PIR #194] Fold each source group past three rows; add a Sources title
- `2c4d865` [PIR #194] Thread: dev-approval feedback
- `96faf8d` [PIR #194] Group answer footnotes by source kind; pills wrap side by side
- `d1b3535` [PIR #194] Thread: implement notes
- `ed05706` [PIR #194] Cap footnote pill at two lines; list grades in the folio
- `1d38636` [PIR #194] Parse hadith grades; title shows first grade + count
- `aa91a45` [PIR #194] Plan draft
- (plus `chore(porch)` state commits)

## Test Results

- Prototype `vitest run`: ✓ 308 tests, 25 new (14 on grade parsing and hadith mapping, 11 on grouping, labels and the fold). `tsc --noEmit`: ✓ clean.
- Porch `build` / `tests` checks: ✓. They were run with `apps/api/.env.ci` loaded, as CI does. Without it, the `apps/api` build fails config validation in a worktree that has no `.env`, which is unrelated to this change.
- Manual verification: the human reviewer ran it on web (localhost, against staging) and confirmed three things: a real wudu answer with 20 sources, the grouped layout, and the fold. They approved with "looks great". Native (iOS/Android) was not checked.

## Architecture Updates

Added a **Source pills** paragraph to `codev/resources/arch.md` → *Prototype chat display*. It records three things: grades are parsed on the client (`grade` / `grades` on the local `Citation` extension), pills are grouped by kind and folded by measured rows (`foldAt`), and the folio is where the full grade list lives. Nothing goes into the hot tier, because this is prototype-only display behavior.

## Lessons Learned Updates

Added a cold section to `codev/resources/lessons-learned.md`, *Hadith grades & source pills — prototype (issue #194)*, and a matching map entry in `lessons-critical.md`. The section covers three points:

- Bound the renderer rather than only parsing a guessed data shape.
- Fold a wrapping layout by measured rows, not by item count.
- The live data in the test didn't exercise the multi-grade path.

## Things to Look At During PR Review

- **The multi-grade path was not seen on live data.** No fixture in the repo carries a multi-grade `grade_en`, and there was no Kalimat key in the worktree. In the staging answer used for testing, every graded hadith had a single grade. `parseGrades` accepts two forms: newline-separated entries, and a single line that starts with `1:` and contains more numbered entries. Its tests use the shape quoted in the issue. If the real separator is something else, the result is contained: the two-line cap bounds the pill and the folded group bounds the section.
- **AbuDaud 135 / 137 showed no grade on staging.** Either `grade_en` really was empty, or it held only empty numbered entries that the parser now drops. Neither is wrong to hide, but I didn't confirm which.
- **Fold measurement (`FootnoteGroup.tsx`).** Every pill stays mounted so it can be measured, and the group is clipped at the top of its fourth row. While a group is unmeasured it holds a 3-row fold estimated from one-line pills (148pt), so a long group doesn't flash open on mount. Pills below the fold get `focusable={false}`, `aria-hidden` and `no-hide-descendants`. Keyboard skip was listed in the manual test steps, but the reviewer did not report on it specifically.
- **Plan deviations, all approved at `dev-approval`:** the grouping, the fold and the title were added from reviewer feedback. The multi-grade entry in `lib/sample-citations.ts` promised in the plan was dropped, because that file forbids entries not verified against a primary source.
- **Marker order:** the numbers no longer read 1..n down the page (the Qur'an group can come first with ⁵–⁹). The reviewer chose this layout knowing that.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder pir-194 → **Review Diff**
- **Run dev**: `afx dev pir-194`, or `cd prototypes/ansari-expo && CI=1 npx expo start --web --port 8093`
- **What to verify**:
  - Ask about wudu. The foot of the answer shows `Sources · N`, then the QUR'AN / HADITH / SCHOLARLY WORKS groups with pills side by side, and no pill taller than two lines.
  - A group longer than three rows shows `View N more ⌄`. It expands in place and collapses again with `Show less`. At phone width it re-folds, still at three rows.
  - Tapping any pill opens the folio on that source. A multi-graded hadith's folio shows the chapter and a numbered GRADES list with no gaps and no empty entries.
  - Single-grade hadith and Qur'an folios are unchanged.
