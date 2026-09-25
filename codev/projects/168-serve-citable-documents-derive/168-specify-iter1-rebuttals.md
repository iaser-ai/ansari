# Spec 168 — iteration 1 rebuttals

Gemini: APPROVE. Its one recommendation, that malformed jsonb must not cause a 500, is the same as Codex #4 and is adopted below.

## Codex (REQUEST_CHANGES)

1. **`raw_payload` wording contradiction.** Accepted. The criterion now says `raw_payload` is never serialized in any response and is never selected by derivation. It stays in `messageReadColumns` because replay needs it. The spec also says how to read the ruling's phrase "fully projected out".
2. **`v1/chat/completions` does not persist `tool_calls`.** Accepted, and verified: `route.ts` never passes `toolCalls`. The assumption now names the three persisting routes (`v2/threads/{id}` POST, `/chat`, `mcp-complete`). v1 is explicitly out of scope and fails closed. Test 6a covers a v1-style message.
3. **Decisions left "to be confirmed".** Accepted. The design is now stated as A1 + B1 + C1 + fail closed. Spec approval ratifies it, and any alternative the approver picks means revising the spec before the plan is written.
4. **Malformed jsonb.** Accepted. A new criterion lists the malformed shapes. Each one fails closed per record and never fails the request. Logging carries `{messageId, reason}` only. Test 6a covers these cases through the real handler on pglite.

## Claude (REQUEST_CHANGES; arrived late)

1. **v1 assumption.** Same as Codex #2 and fixed as described there.
2. **Contract test's ordered key set would fail.** Partly disagree. The existing fixture `RECORDS` has no `result_meta`, so it is a legacy row that derives nothing. Its exact key assertions stay green unmodified, and the spec now says so. The underlying gap is real, though, so the spec now fixes `documents` as the last key: after `created_at` on thread and share GET, and after `createdAt` in the snapshot. New tests assert `[...MESSAGE_KEYS, 'documents']`.
3. **The `result_meta` scan could pass vacuously.** Accepted. The scan's seeded fixture must include a `result_meta`-bearing record that derives documents. The pattern is negative-tested against a known-bad line and a near-miss.
4. **In-code invariant comments.** Accepted. `db/schema/messages.ts`, `lib/db/threads.ts` and `lib/db/shares.ts` are now named in the doc-correction criterion.
5. **Runtime validation beyond length.** Accepted, as the malformed-data criterion (same as Codex #4).
6. **"Materially worse" is unfalsifiable.** Accepted. There is now a concrete bound. If median `pg_column_size(tool_calls)` exceeds 14 KB/row (2× the accepted figure), or thread-GET latency exceeds 2× baseline on a 50-message pglite fixture, the PR must flag it to the architect before merge. The data source used must be stated.
7. **Template headings.** Disagree. The spec follows exactly the template porch's specify prompt supplied for this project, which is the canonical interface for this phase. Security and performance content is covered in Constraints, Success Criteria (authorization scoping, cost bound) and Risks.
8. **Minor points.** Accepted. The budget-skip record is now named as the second `result_meta` build site. Its `result_meta` is `[]`, and the spec says `result_meta` is present exactly when the record was written after this change. Helper authorization scoping is now a criterion: the helper runs only after the owner-scoped check, has no authorization of its own, and is not called on unverified ids.
