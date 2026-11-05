# Review: issue #330, root `pnpm test` under load (cap vitest workers)

## Pre-registered protocol for the A/B (written before any of these runs)

Declared 2026-10-28, before the runs below, at the architect's direction, so that no load level is chosen after seeing results.

- **Arms.** CAPPED = the root script as shipped at the time (`turbo run test -- --maxWorkers=4`; after the PR #323 merge it is `turbo run test --filter=!ansari-mcp -- --maxWorkers=4`). UNCAPPED = `turbo run test --`, the pre-fix script, run as `pnpm exec turbo run test --`. Both arms use `TURBO_FORCE=true`, so nothing comes from the cache, and both load `apps/api/.env.ci` and `apps/auth/.env.ci`.
- **Order.** The arms alternate (CAPPED, UNCAPPED, CAPPED, …) to cancel machine drift. Each scenario gets at least 5 pairs.
- **Gate.** Each run starts only when no vitest process from any worktree is alive. The sampler records any foreign vitest that appears mid-run (`foreign_vitest` max), and every overlapped run is reported, not dropped.
- **Scenario 1, concurrent vitest (the failure actually observed).** Two root runs start together in this worktree, with no busy loops. In each arm both copies are capped or both are uncapped. A pair-run is red if either copy exits non-zero.
- **Scenario 2, the #301 harness.** One root run with 28 busy-loop processes on 14 cores.
- **Escalation.** 42 busy loops are run only if both scenarios stay green on both arms.
- **Reporting.** Red/green rates are reported for both arms, whatever they show. If UNCAPPED also stays green, the negative test is recorded as not reproduced, and the PR stands on the fork reduction and the idle wall time.
- Wall time and peak fork counts per package are recorded for every run.

## Summary

The root `pnpm test` runs four vitest suites at once under turbo (`apps/api`, `apps/auth`, `apps/frontend`, `packages/auth`). Each suite defaults to `availableParallelism() - 1` workers in run mode: 13 on the 14-core development machine (read from vitest 4.1.11 `resolveMaxWorkers`, and the same in vitest 3.2.7). That came to about 50 forks before anything else on the machine, and the pglite setup hooks crossed the 30 s deadline whenever the machine was also busy.

**Fix:** the root script now caps each suite's pool. `"test": "turbo run test --filter=!ansari-mcp -- --maxWorkers=4"`. The `--filter=!ansari-mcp` came from PR #323, merged in at d0b573d3; see "Develop merge" below. The A/B and the proofs before that section ran `turbo run test -- --maxWorkers=4`, which passes the same flag to the same four vitest suites. The four vitest configs and CI are untouched. A pin test (`apps/api/tests/root-test-script.test.ts`) asserts the flag. The root `package.json` is added to `ansari-api#test`'s turbo inputs so that removing the flag busts the cache. No per-test or per-hook deadline was changed.

### Why the root script and not the configs (architect decision, option b)

CI runs on `ubuntu-latest` (4 vCPU) and uses the same configs. A `maxWorkers: '25%'` in a config would give CI one worker. An absolute `4` in each config would slow every solo `pnpm api test` on a development machine from 13 workers to 4. The failure exists only when the suites run together, so the cap goes only on the aggregate command. Passthrough arguments are part of turbo's task hash. The new flag therefore changes the cache key only for tasks run through the root `pnpm test`. CI's `turbo run test:coverage --filter ansari-api...` and `turbo run test --filter ansari-auth...` / `ansari-frontend...` pass no arguments, so they keep their defaults and their cache keys.

## Measurements

All runs: root run with `TURBO_FORCE=true`, `.env.ci` of apps/api and apps/auth loaded, 14-core machine shared with other builders. Forks were sampled every ~0.5 s per vitest main process. Vitest 3 renames its main process to `node (vitest)`, so the frontend's main was located by its working directory. Each run started only when no vitest from any worktree was alive. A foreign vitest that appeared mid-run is recorded, not dropped.

### Worker counts (peak forks, one root run)

| Package | Before (default) | After (`--maxWorkers=4`) |
|---|---|---|
| apps/api | 14 | 4-5 |
| apps/auth | 11 (11 files) | 4-5 |
| apps/frontend (vitest 3.2.7) | 14-15 | 5-6 |
| packages/auth | 13 | 4-5 |
| Aggregate | 49-51 | 17-18 |

The extra fork above 4 appears in the samples briefly, around worker replacement. Every package's turbo log shows `vitest run --maxWorkers=4`, and no package reported a min/max worker conflict.

### Idle wall time (no harness; the machine's own load was about 12-30)

| | Runs | Median |
|---|---|---|
| Before | 116, 103, 100 s | 103 s |
| After, CLI flag (`cap4-idle`) | 88, 85, 85 s | 85 s |
| After, shipped script (`after-idle`) | 113\*, 83, 94 s | 94 s |
| cap 3, for comparison | 144\*, 93, 88 s | 93 s |

\* A spir-329 vitest overlapped the run (up to 4 foreign mains).

The idle run got faster, not slower. apps/auth sets the wall time: `tests/cutover/copy.test.ts` is one file of 64 sequential tests (about 85 s idle), and no worker cap can shorten a single file.

### Choosing 4 over 3 (28 loops)

Both caps were 3/3 green under the 28-loop harness. Cap 3 was slower idle (93 s against 85 s), so the measurement chose 4.

### Pre-registered A/B (interleaved, gated, 5 pairs per scenario)

**Scenario 1: two root runs started together, no busy loops** (the failure actually observed). Machine load 10-105.

| Pair | CAPPED | UNCAPPED |
|---|---|---|
| 1 | green, green (155 s) | red, red (87 s) |
| 2 | green, green (185 s) | red, red (60 s) |
| 3 | green, green (143 s) | red, red (65 s) |
| 4 | green, green (132 s) | red, red (58 s) |
| 5 | green, green (129 s) | red, red (49 s) |

CAPPED: 5/5 pairs green (10/10 copies). UNCAPPED: 5/5 pairs red, both copies each time. The uncapped failure was always `packages/auth`, with about ten files failing on `Error: Hook timed out in 30000ms` (12-20 per pair). These were `auth.http`, `auth.integration`, `config/{credentials,options,rate-limit,rate-limit-store,sign-up,tokens}`, `schema/auth-schema` and `migration/auth-journal-parity`. That is the issue's harness run 3 signature. Peak forks per pair were about 35 capped and about 100 uncapped. The sampler's printed `total` double-counts with two copies running; the per-package sums are correct.

**Scenario 2: the #301 harness, 28 busy loops.** Machine load spiked to 250-550 during this block, far above the harness, from processes outside this run. The arms alternate, so both were exposed.

| Pair | CAPPED | UNCAPPED |
|---|---|---|
| 1 | green (221 s) | green (284 s) |
| 2 | green (382 s) | red (176 s): api `legacy-users-contract` 30 s hook, `window-migration` 30 s test |
| 3 | **red** (374 s): apps/auth `tests/limits.test.ts:263`, test body 30 s | green (263 s) |
| 4 | green (288 s) | red (77 s): packages/auth `rate-limit`, `sign-up` 30 s hook |
| 5 | green (291 s) | red (236 s): api `tests/auth/layer.test.ts` |

CAPPED: 4/5 green. UNCAPPED: 2/5 green.

The capped red came at a 1-minute load of 249 and a 5-minute load of 376. `limits.test.ts:263` sends 202 sequential requests in a single test body. That is a CPU-bound test body on a saturated machine, not concurrent setup, and the cap cannot shorten one test's own work. No deadline was raised for it, per the issue.

### Other loaded runs (28 loops, before the A/B)

| Set | Result |
|---|---|
| before (uncapped), `before-load-1..3` | 2/3 red (api 30 s hook/test). spir-329 overlapped both red runs, with load up to 162. |
| `cap4-load-1..3` (CLI flag) | 3/3 green |
| `cap3-load-1..3` | 3/3 green |
| `after-load-1..3` (shipped script) | 3/3 green |
| `neg-load-1..3` (uncapped, calm machine) | **3/3 green**: the 28-loop harness alone did not reproduce red. That is why the architect asked for the A/B, with scenario 1. |

### Acceptance

- **3 green in a row under the harness.** Met on the calm 28-loop runs: `cap4-load-1..3` and `after-load-1..3`, 6/6 green. Missed once under the background spike in scenario 2 (`load-3-capped`, `limits.test.ts:263`). That red is an open observation: not fixed, and no deadline raised.
- **Idle wall time within +10%.** Met: the median went from 103 s to 85-94 s.
- **Negative test.** Reproduced by scenario 1: uncapped 5/5 pairs red, capped 0/5 red, same conditions, interleaved. The 28-loop harness alone reproduced red in only 5 of 11 uncapped runs on this machine (before 2/3, neg 0/3, A/B 3/5).
- **No deadline raised.** Met.

### Pin test, proven loud on a warm cache

`turbo run test --filter ansari-api`, without `--force`:

| Step | Cache | Result |
|---|---|---|
| flag present | hit | green |
| flag removed | **miss** | **red** at `root-test-script.test.ts:22` |
| flag restored | hit | green |
| control: `$TURBO_ROOT$/package.json` input removed, flag removed | **hit** (stale) | green: without the input, the pin is silent |

### spir-329's two 100 s hooks (input for revisiting them)

Under the cap at 28 loops (`cap4-load-1..3`, 30 s deadlines on develop), `apps/auth/tests/secrets.test.ts` took about 8.5 s in total and `tests/cutover/copy.test.ts` passed 64/64 (226-274 s for the file). Both passed at 30 s in every capped run here, including the scenario 1 pairs. The 100 s may be revisitable once this cap lands. Per-hook times were not instrumented here.

## CMAP review (PR #332)

- **codex: REQUEST_CHANGES.**
  - (1) `test:coverage` lacked the root `package.json` input, and CI runs the pin through it. **Fixed** with a `test:coverage` block in `apps/api/turbo.json`. Overriding `inputs` replaces the inherited list, so `$TURBO_DEFAULT$` and `.env.ci` are repeated. Dry-run proof: with the block, removing the flag moves `ansari-api#test:coverage`'s hash (f0ac13d3 → 0ff54eeb); without it, the hash stays at ccded238. `outputs` remain `coverage/**`.
  - (2) The regex accepted `--maxWorkers=999` or a duplicate overriding flag. **Fixed**: the pin asserts the exact script. `=64` now failed with `expected 'turbo run test -- --maxWorkers=64' to be 'turbo run test -- --maxWorkers=4'` (pre-merge output). After the PR #323 merge, the pin asserts `turbo run test --filter=!ansari-mcp -- --maxWorkers=4`.
  - (3) "BUGFIX should not add `codev/reviews/*`." **Declined**: the architect asked for this review and its evidence.
- **claude: APPROVE.** Its regex note is covered by codex (2). It rated the `test:coverage` gap as separate; it is fixed here anyway, since the edit is three lines in a file already in scope. It also noted that `4` is absolute, so on a machine with 4 or fewer cores the root run allows up to 4 workers per suite, where the default would be 3 or fewer. That is accepted: the measurement was taken on the 14-core development machine, the root run is a development-machine command, and CI never runs it.
- **gemini:** the lane was skipped because the `agy` CLI exited with code 3 (a tooling failure, not a verdict).

## Develop merge (PR #323, 2026-10-30)

PR #323 changed the root script to `turbo run test --filter=!ansari-mcp --`. `ansari-mcp` runs `tsx --test`, node's test runner, which would reject `--maxWorkers`, so the filter stays. Develop was merged in (d0b573d3, no rebase). The script is now `turbo run test --filter=!ansari-mcp -- --maxWorkers=4`, and the pin asserts that exact string. A dry run shows `--maxWorkers=4` reaching `@ansari/auth`, `ansari-api`, `ansari-auth` and `ansari-frontend#test`, with `ansari-mcp` excluded. The warm-cache proof was re-run:

| Step | Cache | Result |
|---|---|---|
| flag present | miss, then hit | green, green |
| flag removed | **miss** | **red** at `root-test-script.test.ts:24` |
| flag restored | hit | green |

## Lessons

- A harness ratio is a proxy. The failure in this issue was concurrent vitest runs, and 28 busy loops reproduced it in only 5 of 11 uncapped runs (0 of 3 on a calm machine). Reproduce the real scenario before trusting a proxy's negative.
- Pre-register the protocol and interleave the arms. Scenario 2's background spike would have looked like a regression or a fix if the arms had run in blocks.
- Vitest 3 renames its main process to `node (vitest)`. A sampler that matches `vitest.mjs` silently counts the frontend as zero workers. Prove a sampler against a known run first.

## Flaky Tests

None skipped. `apps/auth/tests/limits.test.ts:263` timed out once at 30 s on a machine at load 250-375 (capped arm, scenario 2). It is noted here and not changed.
