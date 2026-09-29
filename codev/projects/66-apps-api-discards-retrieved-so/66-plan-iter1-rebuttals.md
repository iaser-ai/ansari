# Plan iteration 1 — rebuttals

All feedback was accepted. The plan was revised in commit 2444136.

## Gemini (COMMENT)
Lane skipped (agy CLI not installed). No feedback to address. The "working tree changed"
warning in each lane named only the consultation logs that my own background wrapper was
writing. No reviewer wrote to the tree.

## Codex (REQUEST_CHANGES)
1. **`documents: collected()` leaves the key present as `undefined`, which contradicts
   `'documents' in event === false`.** Accepted. Phase 1 now specifies a conditional spread,
   `...(docs ? { documents: docs } : {})`, so the key really is absent. The acceptance
   criterion stays and now holds by construction.
2. **The package is `ansari-api`, not `api`.** Accepted and verified in
   `apps/api/package.json`. Every verification command now reads
   `pnpm --filter ansari-api test` / `typecheck` / `lint`, with a note that `--filter api`
   matches nothing (a false green).
3. **Documentation updates were not assigned to a phase.** Accepted. They land in the Phase 3
   commit. Lessons are added in the review phase.

## Claude (COMMENT)
1. **The Phase 1 `in` criterion contradicts the implementation.** The same finding as Codex #1.
   I resolved it with the conditional spread rather than by weakening the criterion, so the
   event-level assertion stays strict.
2. **Phase 3 could loosen the existing exact-key contract assertions.** Accepted. Phase 3 now
   requires `Object.keys(m)).toEqual(MESSAGE_KEYS)` (~L194) and the snapshot key list (~L241)
   to stay unmodified. Document-bearing cases get their own pinned lists.
3. **The client check targeted the wrong trees.** Accepted and verified: `legacy/frontend-web`
   and `legacy/frontend-app` exist on `origin/develop`. Phase 3 now checks those trees and
   cites the prototype's non-strict `wire-schemas.ts:14`. It also records that `apps/frontend`
   does not consume these endpoints. The "mobile app not in repo" deferral is removed.
4. **The full-row lookups now return `documents`.** Accepted. The Phase 2 threads.ts comment
   update now names `documents` and the non-serializing full-row lookups.
5. **The dedupe key must be collision-safe.** Accepted. The key is
   `JSON.stringify([title, context ?? null, source.data])`, and a missing `context` and
   `context: undefined` are treated as the same key.
