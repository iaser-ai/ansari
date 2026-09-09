# Spec 73 — Phase 2 Iteration 1 Rebuttal

Verdicts: gemini APPROVE, claude REQUEST_CHANGES, codex REQUEST_CHANGES.
Both REQUEST_CHANGES reviews converge on the same two test gaps plus one minor
note. All accepted and fixed; nothing contested. No production logic changed
except the id-uniqueness tweak below.

## Claude #1 / Codex #2 — `ToolResult.degradation` unverified through a real tool

**Accepted, fixed.** The four `search-*.ts` wirings were exercised only via a
mocked `unavailableResult` in the facilitator suite, so a revert would have
silently dropped `error_class`/`attempts` from every persisted record with the
suite green. Now asserted end-to-end from a real `ToolFetchError` through the
tools' own catch blocks:

- `tests/usul-retry.test.ts` — the existing both-attempts-time-out case
  (`describe.each` over SearchMawsuah and SearchTafsir) now asserts
  `result.degradation` equals `{ errorClass: 'timeout', attempts: 2 }`.
- `tests/kalemat-resilience.test.ts` — the hang-past-timeout case
  (`describe.each` over SearchQuran and SearchHadith) asserts the same, and the
  5xx case asserts `{ errorClass: 'http_5xx', attempts: 1, status: 502 }`.

That covers all four tools and both the retried-timeout and single-attempt HTTP
shapes with real fetch/timer behavior (fake timers + AbortSignal), not mocks of
the resilience layer.

## Claude #2 / Codex #1 — degenerate-final and max-iterations error paths untested

**Accepted, fixed.** `tests/facilitator-toolcalls.test.ts` gains:

- *degenerate final*: tool round → two empty `STOP` finals (Inkling stubbed
  unavailable, so the ladder is one same-model retry) → the empty-answer error
  event carries the one recorded pair.
- *max iterations*: ten single-tool rounds → "Maximum iterations reached" error
  carrying all ten pairs, with the first three `ok` and the rest
  `limit_refused` (`duration_ms: null`) — which also pins the consecutive-tool
  limit interaction.

Terminal-path coverage is now 6/6 (both `done` yields; degenerate-final,
synthesis-failure, catch-all, max-iterations errors). Harness note: the
degenerate path lazily reads `config.gemini.model`, so the test now mocks
`@/lib/config` the way `facilitator-empty-final.test.ts` does.

## Claude #3 (minor) — id uniqueness

**Accepted, fixed.** `recordToolUse` ids now embed a per-request sequence
(`tool_<ts>_<seq>_<rand>`), making within-turn uniqueness structural rather
than probabilistic; the timestamp + random tail still separates turns.

## Codex #3 — test execution blocked by sandbox EPERM

Environmental on the reviewer's side, not a finding. Local run after fixes:
71 files / 685 passed / 3 pre-existing skips; typecheck clean.
