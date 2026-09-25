# pir-161 thread

## Plan phase
- #66 is merged; the thread/share GET emit `documents` only when non-empty. Per-tool title/data shapes are in the plan table.
- Surprise: the facilitator prompt already asks the model for inline [N] markers + a "**Citations**:" list. The model's numbering has no link to documents[] order, so the plan proposes strip-always + pills in document order. This departs from the issue's literal "only strip when documents absent" and is flagged for the reviewer.
- Hadith gets no URL (no verified scheme in the repo). Quran → quran.com/S/A.
- Plan review: the human wants inline markers kept. Revised: resolve each model [N] through its own Citations-list entry (LK id / surah:ayah / vol+page / title) to exactly one document. Unresolved markers are stripped, markers are renumbered by first appearance, and uncited docs are appended as pills.

## Implement phase
- New `lib/document-citations.ts` (`resolveCitations`) + 20 unit tests. Mutation check: pairing markers by position instead of resolving them fails 5 tests.
- The mapper resolves documents in `mapMessage`. The khushu' sample applies only when the first answer has no documents.
- The done hand-off swaps by message key, not text, so the persisted answer gaining markers after the stream is safe (arch.md updated; the old "must stay symmetric" note is superseded).
- Resolution rate on real answers is NOT measured yet: no local API, and the default target is staging. Deferred to dev-approval.
- Dev-approval blocked: staging GET /threads/{id} and chat both 500 while the list returns 200. Suspect #66 deployed without migration 0009_documents. Reported to the architect.

## Redesign (2026-09-25)
- #66's `documents` key was reverted in #165 and replaced by spec 168's `/threads/{id}/documents` + `/share/{id}/documents`. Merged develop.
- Verified: `message_index` counts `tool` rows (a raw-array index, before the prototype drops them). Derived documents carry the same title/context/data strings, so `document-citations.ts` is reusable unchanged.
- Plan revision 2: parallel fetch inside one queryFn. Join on message_id, cross-checked with message_index. The documents fetch fails soft (the conversation always renders). No share view in the prototype, so no share consumer. Waiting on architect review before coding.

## Implement, revision 2
- The architect approved both decisions (id+index cross-check, fail-soft). `loadConversationDetail` (decode.ts) fetches the thread and /documents in parallel with the transport injected, so it is testable without RN.
- The first join mutation test passed vacuously (a mismatched id attaches to nothing anyway). Replaced it with an id→answer B / index→answer A case, which now catches both mutations.
- Real staging data (5 answers, 9–14 docs each): initially 23/28 markers resolved. All 5 misses were a bug in my matching: real LK ids contain `-1` (`4_6_-1_1597`). After the fix, 28/28 resolve.
- apps/api cuts hadith titles at 100 chars, often through "Hadith N". A cut title now shows the collection only. Follow-up idea: apps/api could add `hadith_number` to the hadith data JSON.
