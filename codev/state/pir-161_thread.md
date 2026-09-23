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
