# bugfix-383 thread

Issue #383: `search_hadith` degraded on every production call since 2026-11-05.

## 2026-11-12 — investigate

**Delivery order (architect, owner-flagged):** hotfix PR against `main` first, from a branch
cut from `origin/main` (`debee8e`) with only this fix; then the same change against `develop`.
No merges by me.

**Evidence.** No Kalimat key exists locally and I was told not to read Railway variables. The
architect captured 11 raw production responses instead (hadith x3, Quran x8). What they show:

- Hadith (`getText=2`, `indexes=["sunnah_lk"]`): always `{results: [...], total_results_num}`.
  `search-hadith.ts` throws `invalid_body` on anything that is not a bare array, so every call
  degrades. That is the outage.
- Quran (`getText=1`): bare array for ordinary queries (English, Arabic, transliteration, long,
  no-match = `[]`), but the SAME envelope when the query is a verse reference (`2:255`) or a
  surah name (`Surah Al-Baqarah`). That is the 11-28/day `search_quran` `invalid_body`.
  Item keys are identical in both Quran shapes.

**Second defect found while checking item fields.** Real hadith items have no `ar_text`. The
Arabic is in `text` (`text` ~= `isnad_ar` + `matn_ar`). The tool reads `ar_text`, so unwrapping
the envelope alone would return hadith with the Arabic silently missing. Nothing in the repo
reads the document's `ar` field except the model. `id`, `source_book`, `chapter_english`,
`grade_en`, `en_text` are present as expected; `chapter_number` / `hadith_number` /
`section_number` are numbers, not strings (harmless in the title template, interface was wrong).
Whether `ar_text` ever existed in the old bare-array response cannot be checked any more.

**Not changing (reported, out of scope).** Quran results can include `type: "quran_chapter"`
items (id `"94"`, text = the surah's name) in BOTH shapes. Today they become a document titled
`Quran 94`. Pre-existing on the array path; the surah-name query now reaches it through the
envelope too.

**Scope.** Two tool files plus tests, well under 300 LOC. Fits BUGFIX.

**Worktrees.** develop work happens here. The main hotfix lives in a second worktree under my
scratchpad (branch `hotfix/383-kalimat-hadith-envelope`), because this worktree holds the porch
state and cannot be switched to a tree 1,277 commits behind.

## 2026-11-12 — fix

- New `apps/api/lib/tools/kalemat-response.ts`: `kalematResults()` returns the items from a bare
  array or from `{ results: [...] }` and throws `invalid_body` for anything else. Both tools use
  it. `search-hadith.ts` reads the Arabic from `text`.
- Tests replay real production responses, trimmed to one or two whole items
  (`apps/api/tests/fixtures/kalemat/`). 24 pass with the fix; 7 fail on the old tool code; 10
  fail under a lenient unwrap (`results ?? []`); 1 fails if the Arabic is still read from
  `ar_text`.
- **Main hotfix: PR #384** (base `main`, branch `hotfix/383-kalimat-hadith-envelope`, one
  commit). CI green. Not merged; that is the architect's call. The only difference from the
  develop commit is one test env line (`JWT_SECRET` on main, `ENVIRONMENT` on develop), because
  the config schema differs between the branches.
- Not verified live: I have no Kalimat key. A production `search_hadith` after deploy is the
  real check.

**Local check surprises (neither caused by this change):**

- My machine's default Node is 26; the repo pins 22. Under 26, `apps/frontend`
  `hooks/useKeyboard.web.test.ts` fails 11/11 (`window.localStorage` undefined). Under Node 22
  it passes. I ran porch through `fnm exec --using=22`.
- Porch's `tests` check sources only `apps/api/.env.ci`, but `apps/auth/tests/service-verify.test.ts`
  needs the auth env (`apps/auth/.env.ci`), which CI loads in the auth job. I exported it in the
  calling shell. The check command in `.codev/config.json` should load both; not changed here.
