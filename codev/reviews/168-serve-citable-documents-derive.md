# Review: Serve citable documents derived from `tool_calls`

## Summary

The sources behind an answer (Qur'an, hadith, tafsir, mawsuah) are now served by deriving them
from the tool records spec 73 already stores. For threads, nothing is stored twice. Share
snapshots DO copy each message's documents at creation (C1, owner-confirmed), so shared threads
carry a second copy in `shares.content`. The work
landed in four phases:

1. Persist each tool's own `citations.enabled` beside every stored tool result.
2. A fail-closed derivation helper.
3. Two dedicated `/documents` endpoints, plus documents copied into share snapshots.
4. Invariant docs and a read-cost report.

Thread GET and share GET are byte-identical to before. There is no schema change and no
migration. One item is open: the endpoint's latency is about 5× thread GET, which trips the
spec's 2× bound. The owner accepted it on 2026-09-24 ("latency difference is expected"): thread GET is unchanged, and the bound was defined against it.

## Spec Compliance

- [x] `GET /api/v2/threads/{id}/documents` returns `{ thread_id, messages: [{ message_id, message_index, documents }] }` in thread order, with the documents in dispatch order, deduplicated, first occurrence kept (Phases 2–3)
- [x] Authorization matches thread GET: identical unauthenticated response, and an identical 404 for foreign and missing threads (Phase 3)
- [x] `GET /api/v2/share/{id}/documents` returns `{ id, messages: [{ message_index, documents }] }` from the snapshot, never reads `tool_calls`, and returns the same 404 as share GET (Phase 3)
- [x] The two endpoints return the same documents field: parity test through the real handlers on a mixed thread (Phase 3)
- [x] `message_index` is correct, asserted against the real thread GET and share GET responses (Phase 3)
- [x] Notices are never documents: all four tools' "No Results", degraded, backstop, tool limit, unknown tool, budget skip. A test shows a status-based rule would admit the notice (Phases 1–2)
- [x] Messages with no citable retrieval are absent, a thread with none returns `messages: []`, and so does a pre-change snapshot (Phases 2–3)
- [x] Thread GET and share GET are byte-identical, including for a thread whose records derive documents. Pinned by fixtures captured from the unmodified handlers in a commit of their own (`73ccb81`) before any code change (Phase 1, held through Phase 4)
- [x] `formatToolResultForGemini` output and the Gemini `functionResponse` are byte-identical. Pinned by a literal-bytes test, and the persisted `content` equals the payload sent (Phase 1)
- [x] No new column and no migration. `DEPLOYED_THROUGH` is not bumped (all phases)
- [x] Legacy rows (no `citations`) and misaligned records yield nothing (Phase 2)
- [x] Malformed jsonb fails closed per record and never fails the request. 11 malformed shapes are covered. Logging is `{messageId, reasons}` only, proven with a sentinel string (Phases 2–3)
- [x] The derivation helper is reached only after authorization: the owner-scoped `findThreadById`, or `createThreadSnapshot`'s ownership check (Phase 3)
- [x] Read cost measured against a concrete bound (Phase 4). Storage: staging median 5.6 KB, inside the 14 KB bound. **Latency: `/documents` median ~4.9–5.0 ms vs thread GET ~0.9–1.0 ms, about 5×, which trips the 2× bound.** Flagged to the architect before the PR as the spec requires; **the owner accepted the ~5× ratio on `/documents` on 2026-09-24**. Side effect found in the integration review: `findShareById` selects the whole `shares.content` jsonb, so public share GET now also detoasts the snapshot's copied documents and discards them. Share GET's bytes on the wire are unchanged, but its read cost grows with the documents of shared threads.
- [x] Raw `ToolCallRecord`s cannot reach a serializer. Only derived blocks leave `lib/db/citable-documents.ts`, `MessageRow` and `messageReadColumns` are unchanged, and a key scan covers every body (Phases 2–3)
- [x] History replay loads neither `tool_calls` nor documents. A turn-2 test checks that no document text reaches the facilitator (Phase 3)
- [x] Negative-tested: every drop site fails its tests when broken and passes when restored. Counts are under Lessons Learned (all phases)
- [x] Real-DB (pglite) coverage through the real route handlers (Phases 1–3)
- [x] `arch-critical.md`, `arch.md` and the in-code comments are amended. A pattern that finds 5 old passages in the pre-change files finds 0 now (Phase 4)

## Deviations from Plan

- **Serving surface (spec and plan, owner direction at the plan gate).** The issue's sibling `documents` key on thread GET and share GET was replaced by dedicated `/documents` endpoints joined by `message_index`. This avoids released mobile builds downloading source texts they cannot use. The owner re-approved the spec at `45e4690`. #161's contract change is posted on the issue for the prototypes architect.
- **Persisted shape (spec, owner review).** It is only `citations: [{enabled}]`, the tool's own flag. `source_type`/`media_type` are not stored; they are filled from the `DocumentBlock` literal types, and a compile-time guard fails the build if either literal is widened.
- **Phase 1.** The plan expected existing exact-record test expectations to need updating. None did, because those tests assert individual fields. I added `tests/tool-citability.test.ts` (not in the plan) to check the four real tools' citability.
- **Phase 2.** I removed an `expectTypeOf` test, because `tsconfig.json` excludes `tests/**` and it could never fail. The output type is pinned by the declared return type, which is checked in `lib/`, plus a runtime key test.
- **Phase 3.** `findCitableDocumentsByThread` returns ordered `{messageId, messageIndex, documents}[]` from one query, instead of a map plus a separate id listing. The index therefore comes from the same result set as the order it describes. The Phase 2 tests were updated to match.
- **Phase 4.**
  - The benchmark is `scripts/bench-documents.bench.ts` with its own `scripts/vitest.bench.config.ts`, because the handlers need `vi.mock`. It is not the plain `scripts/bench-documents.ts` the plan named.
  - The staging storage query was not re-run: the architect ruled that the plan-stage figure stands.
- **PR review fix: a deterministic `id` tiebreaker.** Thread GET (`findMessagesByThread`), `createThreadSnapshot` and `findCitableDocumentsByThread` now all order by (`created_at`, `id`). Messages written in one transaction share `now()`, so a `created_at`-only order is undefined on ties and `message_index` could disagree with thread GET. This touches thread GET's query only for tied timestamps, whose order was undefined before. The byte fixtures (distinct timestamps) are unchanged and pass.
- **Out-of-phase commit (architect-directed).** `7b8a423` adds a per-test 20 s timeout to two pre-existing load-sensitive tests; see Flaky Tests.

## Consultation Feedback

### Specify Phase (Round 1)

#### Gemini
- No concerns raised (APPROVE).

#### Codex
- **Concern**: `raw_payload` wording contradicts replay needing it → **Addressed**: it is never serialized or selected for derivation, and stays in `messageReadColumns` for replay.
- **Concern**: `v1/chat/completions` does not persist `tool_calls` → **Addressed**: that route is explicitly out of scope and fails closed.
- **Concern**: A1, C1 and fail-closed left "to be confirmed" → **Addressed**: they are stated as decided, and approval ratifies them.
- **Concern**: malformed jsonb must not cause a 500 → **Addressed**: new criterion and tests.

#### Claude (arrived late, after the user directed proceeding without it)
- **Concern**: the v1 assumption was wrong → **Addressed** (same as Codex).
- **Concern**: the contract test's ordered key set would break → **Rebutted in part**: the fixture is a legacy row and stays green. The key position was specified anyway, and is moot after F2.
- **Concern**: the key scan could pass vacuously → **Addressed**: it runs over a documents-bearing seed and is negative-tested.
- **Concern**: in-code invariant comments were not in scope → **Addressed**: named in the criteria and fixed in Phase 4.
- **Concern**: runtime validation of jsonb → **Addressed** (malformed-data criterion).
- **Concern**: "materially worse" was unfalsifiable → **Addressed**: bounds set at a 14 KB/row median and 2× latency.
- **Concern**: the spec template lacked sections → **Rebutted**: the spec follows the template porch supplied.
- **Concern**: the budget-skip build site and helper auth scoping → **Addressed**.

### Plan Phase (Round 1)

#### Gemini
- No concerns raised (APPROVE).

#### Codex
- **Concern**: no single citability computation point for #109 → **Addressed**: `citabilityOf()` in `lib/tools/types.ts`.
- **Concern**: the latency method was underspecified → **Addressed**: fixture sizing assertions, a same-process baseline, 20 warm-up and 200 alternated runs, and a check that the derivation path ran.
- **Concern**: how reject reasons reach the logger → **Addressed**: the pure function returns `{documents, rejected}` enum codes, and the wrapper logs `{messageId, reasons}`.

### Implement phase_1 (Round 1)
- No concerns raised. Both Codex and Gemini approved.

### Implement phase_2 (Round 1)
- No concerns raised. Both Codex and Gemini approved.

### Implement phase_3 (Round 1)
- No concerns raised. Both Codex and Gemini approved.

### Implement phase_4 (Round 1)

#### Gemini
- No concerns raised (APPROVE). It warned that the working tree changed mid-review → **N/A**: that was my own separate timeout commit.

#### Codex
- **Concern**: no recorded clean full-suite run after Phase 4 → **Addressed**: at `7b8a423`, 853 passed / 3 skipped, build 4/4, tsc and lint clean.
- **Concern**: staging storage appeared not to be re-run → **Addressed**: the thread log now states it was not re-run, per the architect's ruling.

### Implement phase_4 (Round 2)
- No concerns raised. Both Codex and Gemini approved.

### PR Review (Round 1)

#### Gemini
- No concerns raised (APPROVE). It noted the latency flag as already escalated.

#### Codex
- **Concern**: the latency bound is exceeded (~5× against 2×) and owner approval is pending → **N/A**: it is already escalated and marked as blocking merge in the PR body. The decision belongs to the owner, not the code. Outcome: the owner accepted the ratio on 2026-09-24.
- **Concern**: `message_index` relies on `ORDER BY created_at` only, so ties are undefined → **Addressed**: an `id` tiebreaker in all three thread-order queries, plus an equal-timestamp regression test that fails when the tiebreaker is removed from any one of the three.

## Lessons Learned

### What Went Well

- **Fixtures captured before any code, in a separate commit.** When the serving design moved to F2, the byte-identity guarantee strengthened to "thread GET and share GET never change", and the same fixtures proved it through every later phase with no re-capture.
- **Every drop site was negative-tested.** Counts:

  | Phase | Break | Tests failing |
  |---|---|---|
  | 1 | Citability hard-coded true | 16 |
  | 1 | Flag leaked into the Gemini payload | 1 |
  | 1 | Record builder drops the flag | 7 |
  | 2 | Citability check removed | 7 |
  | 2 | Length check removed | 1 |
  | 2 | Media-type literal widened | `tsc` fails |
  | 3 | Derivation off | 11 |
  | 3 | Off-by-one index | 7 |
  | 3 | Share GET spreads documents | 2 |
  | 3 | No owner scope | 1 |
  | 4 | Stale-wording grep | 5 hits in HEAD, 0 after |
  | PR | Tiebreaker removed from any one of the 3 queries | 1 (each) |

- **Scans caught real problems.** The public-route source scan caught my own comment naming `tool_calls`. The stale-wording grep was proven against the pre-change text before it was trusted.

### Challenges Encountered

- **The design moved twice at the gates.** First, what to persist (from `result_meta` with typing down to only the tool's own flag). Second, where to serve (from a sibling key to dedicated endpoints). Both came from the owner questioning assumptions ("why not decide from the source?", "why is it called documents?"). Each round was cheap because the spec separated storage, derivation and serving as independent decisions (A/B/C/F).
- **An intermittent root-run failure.** It was traced to two pre-existing cold-start tests that exceed the 5 s default under CPU load. Timings on base `c1c198d` were identical, which ruled out a regression. A second false failure (build 3/4) was a stray detached build from my own load test.

### What Would Be Done Differently

- Explain plainly early on that a new key inside existing jsonb is "no schema change". The owner reasonably read "persist a flag" as a database change, and it took several exchanges to settle.
- Run the latency benchmark earlier (Phase 3), so the bound question reaches the owner before the PR rather than at it.

### Methodology Improvements

- porch's consult runs overlap with builder commits in the same worktree. The "repository moved" warnings were benign here, but the review could be pinned to a commit so that concurrent builder work cannot race it.
- The spec template could prompt: "For any derived data, where is each input fact stored today?" That is the question that surfaced the dropped `citations.enabled`.

## Architecture Updates

- Routed: **hot**: rewrote the tool-history fact in `arch-critical.md`. No API response may serialize raw tool records or `raw_payload`. `lib/db/citable-documents.ts` is the one serving reader of `tool_calls` and returns derived blocks only, via the `/documents` endpoints. Thread GET and share GET carry no documents. The fact count is unchanged (10), so no demotion was needed.
- Routed: **cold**: `arch.md`. The Tool-call persistence paragraph was updated (the `citations?` field and the read-path exception), and a new **Citable documents (spec 168)** paragraph covers the flag's origin, derivation, fail-closed rules, the endpoints, `message_index` and the byte-identity fixtures.

## Lessons Learned Updates

- Routed: **cold**: new `lessons-learned.md` section **Derived citable documents (spec 168)**:
  - check that a fact was stored before deriving from it;
  - type-level tests under a `tsc`-excluded dir are vacuous;
  - `vitest` `mergeConfig` concatenates arrays;
  - `( cmd & )` escapes `wait`;
  - fix load-sensitive cold-start tests with per-test timeouts, never by skipping a safety guard;
  - source scans can catch their own comments.
- Routed: **hot (map only)**: added a map entry to `lessons-critical.md` pointing at that section (6 of 12 map slots, 27 of 35 lines). No new hot lesson: none is more cross-cutting than the ten already there.

## Flaky Tests

No tests were skipped. Two pre-existing tests were load-sensitive and have been fixed rather than skipped:

- `apps/api/tests/migration/migration-schema-parity.test.ts`, test "work against the migrations deployed on staging/production".
- `apps/api/tests/eslint-env-guard.test.ts`, test "flags process.env.%s in %s" (the first `it.each` case).

**Failure mode:** `Test timed out in 5000ms` under CPU load. It failed in 2 of 4 root runs with a concurrent build, and once in a plain root run right after a build.

**Evidence it is pre-existing:** normally the parity test takes 0.5–0.7 s, with identical timings on base `c1c198d` (0.70/0.48, 0.68/0.50, 0.74/0.52 s) and on this branch.

**Fix:** a per-test `20_000` timeout on just those two tests, in the separate commit `7b8a423`. The architect directed not to skip them, since the parity test guards the #165 outage class. After the fix, all 4 runs under the same load passed.

## Follow-up Items

- **Latency bound: resolved.** The owner accepted the ~5× ratio on `/documents` on 2026-09-24 (about 5 ms on a 25-answer synthetic thread, 394 KB of source texts). If long production threads ever make it matter, the other options considered were:
  - add a per-message fetch (`?message_id=`);
  - cap the documents per message.
- **#161**: the prototype must switch to a second fetch joined by `message_index`. The contract is posted on the issue.
- **#109**: the SSE `tool_result` frame can reuse `citabilityOf()` to stop reporting notices as results.
- **Citations during streaming** (SSE `done` frame): not in scope, and sources are only available after the answer completes.
- **`v1/chat/completions`** drops `tool_calls`, so its messages never derive documents. That is fine today, and worth knowing if that route's threads ever surface to users.
- **Share GET reads documents it discards**: `findShareById` selects the whole snapshot. A projection that skips `messages[].documents` (or a share-GET-specific select) would remove the extra detoast, if shared threads grow large.
- **Long production threads**: staging threads have 1–3 answers. Re-measure `/documents` latency if production threads prove much longer.
