# bugfix-72 thread — Usul timeout retry (issue #72)

## 2026-08-29 — investigate phase

**Code path traced** (root cause confirmed at code level):
- `apps/api/lib/tools/resilience.ts:32` — `TOOL_FETCH_TIMEOUT_MS = 10_000`, single attempt, no retry (deliberate, issue #54).
- `apps/api/lib/tools/usul-client.ts` → `fetchJsonWithTimeout` — one AbortController-bounded attempt; timeout → `ToolFetchError{errorClass:'timeout', attempts:1}`.
- `apps/api/lib/tools/search-mawsuah.ts:117-132` — catch → `reportDegradedTool` + `unavailableResult` (isDegraded).
- `apps/api/lib/facilitator/agent.ts:52` — `T1_DEGRADED_THRESHOLD = 2`; two degraded results in one request short-circuit to synthesis (`agent.ts:741-750`).

**Architect correction received (2026-08-29T20:26Z)**: the issue's cold-start
premise is REFUTED. No idle-based cold start at 15-min scale; production (~1
question/min) never idles that long anyway. Real phenomenon: heavy-tailed
latency (bulk ~1-3.5s, occasional >10s excursions, ~10-15% degraded rate).
The "aborted request warms the instance" experiment is moot — cancelled before
launch. Retry-once-on-timeout is still the candidate fix, justified as
re-sampling a heavy-tailed distribution, IF tail events are time-independent.

**My own measurements so far** (consistent with the correction):
- Unauthenticated probe: fast 401s (~0.5s).
- Authenticated (token via Railway CLI, never logged): 3.14s, 4.17s, 2.75s,
  2.90s after unknown idle — warm-ish baseline ~3s, no 16s cold start seen.

**In flight**: 30-sample distribution measurement (varied Arabic fiqh queries,
~20s spacing, 30s cap), with a paired immediate-retry probe fired whenever a
sample exceeds 10s — directly measures what retry-once-no-backoff buys and
tests temporal correlation. Script + log in session scratchpad
(`latency-sample.sh` / `latency-sample.log`).

**Decision rule agreed with architect**: independent rare tail → retry once on
timeout only; correlated slowness → raising the timeout may be better.

## 2026-08-29 — investigate phase: measurements complete

**30-sample distribution run** (varied Arabic fiqh queries, ~20s spacing, 30s
cap, 15:27–15:38 local): n=30, p50=2.26s, p90=4.02s, p99=5.57s, max=5.57s,
**0/30 over 10s**. Could NOT reproduce a >10s excursion from this vantage point
(matches architect's independent 20-sample run: p99 4.01s, zero over 10s). No
paired retry probes fired. Per the architect's instruction: not forcing a
conclusion from absence — recommendation rests on production data + reasoning.

**Production correlation analysis** (Sentry ANSARI-MULTISAGE-14, 80 events over
55h, scratchpad `sentry-rows.json`):
- Class mix: 58 timeout / 17 http_5xx / 4 network → timeout is ~72% of
  degraded events; retry-on-timeout-only addresses the majority class.
- ~1.06 timeouts/hour, spread across all UTC hours — no bad window.
- 76% of timeouts isolated (no other timeout within ±120s); clusters small
  (4 pairs, 2 triples, none bigger). Apparent excess vs Poisson (24% vs 6.8%
  with a 120s neighbor) is explained by same-turn parallel call batches (2–4
  mawsuah calls/turn) under an INDEPENDENT ~10% per-call timeout probability —
  not by provider-wide bad minutes (which would produce larger clusters).

**Investigate conclusion / fix decision**:
- Root cause: heavy-tailed Usul latency (bulk 1–4s, rare >10s excursions seen
  only from production) × single-attempt 10s timeout × T1=2 hard-error.
- Fix: **retry once, on `timeout` errorClass only, no backoff**, per-attempt
  bound unchanged at 10s. Justification: re-samples a mostly-independent tail
  (expected ~quadratic cut in per-call timeout failures, ~10%→~1%); cannot
  hurt — worst case per-tool 20s, still ≪ the 120s #49 budget; non-timeout
  classes keep failing fast per #54. Benefit could not be measured directly
  from this vantage (stated plainly, per architect).
- Set `ToolFetchError.attempts=2` on retried failures for telemetry.
- Scope: well under 300 LOC (resilience.ts + tests). Flag T1_DEGRADED_THRESHOLD
  question in the PR; do not change it.

**Architect refinement (20:40Z)**: independent verification confirms "mostly
isolated" (87% of timeouts >60s apart; p50 gap ~26 min). Rate corrected: per-call
tail is ~1–3% (not ~10% — 0/50 combined samples rules 10% out at P≈0.5%).
Expected benefit to state in PR: ~85–90% reduction in degraded mawsuah events
(inference from production telemetry, not a measured improvement). The 3 sub-10s
gaps are almost certainly same-turn parallel calls — the exact T1=2 hard-error
scenario; retry helps there too since each call retries independently.

## 2026-08-29 — fix phase

Implemented in `resilience.ts`: extracted the single attempt into private
`fetchJsonAttempt`; public `fetchJsonWithTimeout` now retries exactly once,
immediately, when attempt 1 fails with `errorClass === 'timeout'` — all other
classes still fail fast on attempt 1. Retried failures carry `attempts: 2`
(new exported `TOOL_FETCH_MAX_ATTEMPTS = 2`). Per-attempt timeout unchanged
at 10s; per-tool worst case 20s, inside #49's 120s budget. Comment-only updates
in `usul-client.ts` and `agent.ts` (stale "no retries" wording, T1 exit-time
estimate). NOTE: the retry lives in the shared layer, so Kalemat tools
(quran/hadith) gain it too — intended, flagged in PR.

Tests: regression (timeout → retry → success), double-timeout (attempts=2),
timeout-then-5xx (attempts=2, class from retry), negative suite proving NO retry
for http_5xx/http_4xx/network/too_large/invalid_body (each followed by a
would-succeed response so a wrong retry would be caught two ways), fake-timer
wall-clock bound ≤ 2×10s, end-to-end tool-level recovery + Sentry telemetry
attempts=2. Verified the regression tests FAIL against HEAD's resilience.ts
(12 failures) and pass with the fix (47/47). Full suite 631 passed, 3
pre-existing skips; typecheck + build green. Kalemat hang test updated 1→2
attempts (shared-layer consequence).

## 2026-08-30 — pr phase

PR #76 opened against develop (Fixes #72). Porch checks initially blocked by
stale workspace check config (cwd 'backend', npm) — architect fixed
.codev/config.json (now apps/api + pnpm); checks green.

CMAP verdicts:
- gemini: APPROVE (high confidence, no issues).
- codex: REQUEST_CHANGES — (1) branch 55 commits behind develop → merged
  origin/develop, full suite green post-merge (646 passed); (2) docblock
  overclaimed attempts=2 for raw non-ToolFetchError retry failures → narrowed.
- claude: APPROVE (high confidence) — non-blocking findings, all addressed:
  (1) CORRECTION: agent.ts dispatches tool calls SERIALLY, so my "same-turn
  parallel calls explain sub-10s Sentry gaps" claim was wrong — those gaps are
  concurrent user requests; T1=2 double-timeout is real but serial. PR body
  and this thread hereby corrected. (2) Soft-deadline overrun now doubles
  (10s→20s into the 25s synthesis reserve, worst case ~5s left; 120s hard
  deadline still holds) — recorded in PR as a flagged follow-up, not fixed
  (needs deadline awareness in the resilience layer, out of BUGFIX scope).
  (3) T1 comment tightened to "≤~40s of tool time". (4) Original error kept
  as .cause on the attempts=2 rethrow.

All fixes committed (9972f36, 1fe27e4) and pushed; PR body updated. Full
suite 646 passed / 3 skipped, typecheck + build green on the merged base.
