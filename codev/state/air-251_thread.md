# air-251 thread — strip inline LK ids from answer bodies (#251)

- Added `stripInlineCitationMetadata` + exported `LK_ID` in `prototypes/ansari-expo/lib/citations.ts`. `matchEntry` now uses the shared `LK_ID`.
- Applied in `stripUnbackedCitations` (covers persisted no-docs + streaming) and on the body in `resolveCitations`'s resolved path (with-docs).
- Streaming: `PENDING_LK_ID` withholds a trailing `(L`…`(LK id 1_77` off the RAW text before stripping, so the open bracket never flashes.
- Volume/page deliberately NOT stripped: human-readable citation, high over-strip risk.
- Proved the tests fail with the scrub disabled (10+ failures), and pass when it's restored. Full suite 592/592, tsc clean.
