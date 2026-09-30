# air-198 thread

- Branch was behind develop (PR #195 added `lib/footnote-groups.ts`, which the issue names); merged origin/develop first.
- Design call: `reference` = `Qur'an <Surah> <s>:<a>` (e.g. `Qur'an Al-Isra 17:78`). The pill under the QUR'AN heading keeps using `footnoteLabel`'s existing prefix strip → `Al-Isra 17:78`; the folio and copied answer text read the full form. No change to `footnote-groups.ts` needed.
- Names: quran.com transliterations, static table in `lib/surah-names.ts`. Out-of-range surah numbers fall back to bare numbers.
- Marker matching is unaffected: it keys on the verse numbers, not the reference string.
