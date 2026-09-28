# PIR Review: Map apps/api's citable documents to `Citation` in the prototype

Fixes #161

## Summary

In `prototypes/ansari-expo`, an answer that used search tools now shows its real sources.
The detail query fetches `GET /threads/{id}` and spec 168's `GET /threads/{id}/documents`
in parallel. It joins the documents to their messages and turns each document into a
`Citation` the existing pill and source-sheet UI renders.

The model's own inline `[N]` markers are kept **only** when its trailing "Citations:" list
names exactly one retrieved document. The match uses the strongest key the entry carries:
hadith LK id → Qur'an surah:ayah → encyclopedia volume + page → exact title. Every other
marker is dropped rather than guessed, and every retrieved source is listed. On 5 real staging
answers (9–14 sources each), 28 of 28 model markers resolved.

The plan was redone mid-flight. Revision 1 was built on #66's sibling `documents` key, which
#165 reverted. Revision 2 targets spec 168's dedicated endpoint (plan:
`codev/plans/161-prototypes-ansari-expo-map-app.md`, "What changed from revision 1").

## Files Changed

- `codev/plans/161-prototypes-ansari-expo-map-app.md` (+239 / -0)
- `codev/resources/arch.md` (+3 / -1)
- `codev/state/pir-161_thread.md` (+25 / -0)
- `prototypes/ansari-expo/README.md` (+2 / -1)
- `prototypes/ansari-expo/lib/api/decode.test.ts` (+208 / -2)
- `prototypes/ansari-expo/lib/api/decode.ts` (+53 / -2)
- `prototypes/ansari-expo/lib/api/hooks.ts` (+3 / -5)
- `prototypes/ansari-expo/lib/api/mappers.ts` (+73 / -35)
- `prototypes/ansari-expo/lib/api/wire-schemas.ts` (+45 / -2)
- `prototypes/ansari-expo/lib/citations.ts` (+8 / -4)
- `prototypes/ansari-expo/lib/document-citations.test.ts` (+318 / -0)
- `prototypes/ansari-expo/lib/document-citations.ts` (+333 / -0)
- `prototypes/ansari-expo/lib/sample-citations.ts` (+12 / -11)

## Commits

- `48397ea` [PIR #161] Thread: revision 2 implement notes
- `eb32ad6` [PIR #161] Docs: citations come from spec 168's /documents endpoint
- `494fbb4` [PIR #161] fix: match LK ids with a -1 segment; never read a hadith number from a truncated title
- `90fbdf7` [PIR #161] Fetch sources from spec 168's /threads/{id}/documents, joined by id + index, fail-soft
- `d9588ce` [PIR #161] Plan revision 2: consume spec 168's /documents endpoint
- `0e80da7` [PIR #161] Thread: implement notes
- `753afb2` [PIR #161] Update docs for document-backed citations
- `102baf5` [PIR #161] Attach real citations in the mapper; khushu' sample becomes a fallback
- `a9ac47a` [PIR #161] Parse apps/api documents and resolve the model's [N] markers against them
- `35a1f38` [PIR #161] Plan: confirm uncited sources stay listed
- `e36938b` [PIR #161] Plan revised: keep inline markers, resolved via the model's Citations list
- `5577cdc` [PIR #161] Plan draft

(Plus merges of `origin/develop` and porch bookkeeping commits.)

## Test Results

- Repo-root build (porch `build` check): ✓ pass, run with `apps/api/.env.ci` loaded as CI does.
  Without it, `apps/api`'s config Zod schema throws. That is a pre-existing environment issue,
  unrelated to this diff.
- `ansari-expo` `vitest run`: ✓ 286 tests pass after the latest develop merge. New: 23 in
  `lib/document-citations.test.ts` and 12 in `lib/api/decode.test.ts` (27 → 39).
- `tsc --noEmit`: ✓ clean.
- Mutation checks, each proven to fail and then pass again when restored:
  - Pairing markers by position instead of resolving them fails 5 resolver tests.
  - Dropping the LK-id `-` fails the real-id test.
  - Removing the join's `message_id` check fails the cross-check test.
  - Joining by id only (ignoring `message_index`) fails 2 tests.
- Real data: 6 questions against staging from a throwaway guest (5 returned documents, 1
  thread-create timed out). Markers resolved 23/28 at first; after the LK-id fix, 28/28. No
  "Citations:" text is left in any rendered answer.
- Dev-approval: the architect reviewed revision 2 (diff, typecheck, and an independent
  test run) and approved it on 2026-09-25. The recorded `dev-approval` from 2026-09-23 covered
  revision 1 and was deliberately not relied on. No on-device (iOS/Android) manual pass has
  been recorded for revision 2.

## Architecture Updates

COLD, `codev/resources/arch.md` "Prototype chat display": added **Real citations come from
`/documents` (issue #161, spec 168)**, covering:
- the parallel fetch in `loadConversationDetail`;
- the fail-soft rule for the documents request (an HTTP error or a bad body renders without
  sources, while the thread keeps its throwing gate);
- the id + raw-index join (`message_index` counts `tool` rows, so the join runs before
  `mapMessage` drops them);
- the strong-key marker resolution and its fallbacks.

I also corrected the #158 paragraph, which described "no citation data" and a streamed/persisted
symmetry that the key-based hand-off never needed.

HOT, `arch-critical.md`: no change. Its spec-168 bullet already says thread GET and share GET
carry no documents and `/documents` is separate. The prototype-side details are reference
material, not cross-cutting invariants.

## Lessons Learned Updates

COLD, `codev/resources/lessons-learned.md`: new section **Citation mapping — prototype
(issue #161)**. It covers:
- fixtures copied from the producer's code inherit your assumptions, so run matchers on real
  payloads;
- a cross-check test can pass vacuously;
- never parse structured fields out of a display title the API truncates;
- an enhancement request must never fail the primary view;
- a gate approval covers the code it saw.

HOT, `lessons-critical.md`: map entry added for the new section. No new critical lesson. The
closest candidate ("run it on real payloads") is already covered by the hot "tests pass is not
it works" lesson, and the cap is full.

## Things to Look At During PR Review

- **Marker resolution (`lib/document-citations.ts`, `matchEntry`).** The first key the entry
  carries decides, and an ambiguous or empty match is never rescued by a weaker key. That is
  the drop-rather-than-guess rule. If you loosen it, the "wrong LK id must not link" and
  "names two documents" tests are the guards.
- **Real LK ids contain `-`** (`4_6_-1_1597`, books without sub-chapters). The original
  `[A-Za-z0-9_]+` pattern silently missed every Ibn Majah and some Tirmidhi citations. It only
  came to light on real data, because my fixtures were written from `search-hadith.ts`.
- **Truncated hadith titles.** apps/api's `trimCitationTitle` cuts titles at 100 characters,
  often through "Hadith N". A cut title (one ending `...`) now shows just the collection
  (e.g. "AbuDaud") with the chapter as the source title, so two pills from one collection can
  look alike. The hadith data JSON has no number field. A small apps/api follow-up (add
  `hadith_number` to the data JSON) would fix this. **Not done here, as it would cross into
  `apps/api`.**
- **Collection names are apps/api's raw ids** ("AbuDaud", "Tirmizi", "IbnMaja"). A display-name
  table would read better, but it is a content decision I didn't make here.
- **Fail-soft is deliberate** (approved at the redesign gate). A malformed `/documents` body is
  `console.error`-logged with zod paths only, and the thread renders without sources. It is not
  a thrown error. That is the #165 lesson: a sources fault must not make conversations
  unreadable.
- **Markers appear after streaming.** The streaming bubble has no documents, so it stays
  stripped. The persisted answer (after the post-`done` refetch) gains markers and pills. The
  hand-off keys on message id (`chat-reconcile.ts`), not text, so this is a re-render, not a
  glitch.
- **`/share/{id}/documents` is not consumed.** The prototype has no share view.
- **Staging side effects:** my verification created three throwaway guest accounts
  (`guest_pir161…@ansari.chat`) and their threads on staging.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder pir-161 → **Review Diff**
- **Run dev**: VSCode sidebar → **Run Dev**, or `afx dev pir-161` (defaults to
  `https://api-staging.askansari.ai`, which serves spec 168)
- **What to verify**:
  - "What does the Qur'an say about patience? Cite a hadith too." After the stream finishes,
    the answer shows inline superscripts and a pill for every source. Tapping a superscript opens
    the source its sentence cites. The Qur'an link opens quran.com. No "Citations:" list remains.
  - "hello": no pills, and no stray `[N]`.
  - A thread from before spec 168: loads normally, with no sources (old tool records fail
    closed upstream).
  - Block `/documents` in dev tools, or point at an API without spec 168: the conversation
    still loads, without sources.
