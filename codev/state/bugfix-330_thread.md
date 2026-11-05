# bugfix-330 thread

## Investigate (2026-10-28)
- Architect fix proposal (issue #330 comment): maxWorkers per vitest config first, turbo --concurrency only if needed; no timeouts. Scope: four vitest configs + root package.json test script only.
- Defaults read from source: vitest 4 (api, auth, packages/auth) `resolveMaxWorkers` = availableParallelism()-1 = 13 on this 14-core box; vitest 3 (frontend) same, pool forks.
- Sampler gotcha: vitest 3 retitles its main to `node (vitest)`, so a `vitest.mjs run` match misses the frontend; placed by cwd via lsof.
- Baseline idle run 1 (load 20 at start, one spir-329 vitest overlapped briefly): green, 116 s wall. Peak forks: api 14, auth 11 (file-capped), packages/auth 13, frontend 14 alone. apps/auth is the critical path (113 s for 11 files).
- secrets.test.ts / cutover/copy.test.ts (spir-329's 100 s hooks) are on develop at 30 s; my runs exercise them at 30 s.
- Baseline (before): idle 116/103/100 s (median 103), peak ~50 forks; loaded (28 loops) 2/3 red in apps/api (30 s hook/test timeouts), spir-329 vitest overlapped both red runs.
- Architect chose option (b): cap the aggregate in the root script only (`turbo run test -- --maxWorkers=4`); configs and CI untouched, because a `'25%'` config cap would give 4-vCPU CI one worker.
- cap=4 via CLI: idle 88/85/85, loaded 3/3 green, forks 4-5/package (17-18 total), all four packages incl. vitest-3 frontend got the flag. cap=3: loaded 3/3 green, idle 93/88 (+144 overlapped) -> picked 4.
- apps/auth wall is bounded by cutover/copy.test.ts alone (64 tests, one file, ~85 s idle, 226-274 s loaded); a worker cap cannot shorten it.
- Under load at cap 4, secrets.test.ts whole file ~8.5 s and copy.test.ts 64/64 passed at the 30 s hook deadline (input for revisiting spir-329's 100 s).
- Architect: add pin test apps/api/tests/root-test-script.test.ts + root package.json as $TURBO_ROOT$ input of ansari-api#test. Warm-cache proof: removing the flag busts the cache and the pin goes red; without the input it is a stale green hit.
- 28-loop negative alone went 3/3 green on a calm machine. Architect: pre-register (eca50af), interleave, add the two-concurrent-root-runs scenario.
- A/B: two concurrent runs: capped 5/5 green, uncapped 5/5 red (packages/auth 30 s hooks). 28 loops (machine load spiked 250-550 from elsewhere): capped 4/5, uncapped 2/5. The capped red is the limits.test.ts:263 test body, at load 376.
- PR #332. CMAP: codex REQUEST_CHANGES (test:coverage input, exact pin) -> both fixed in e225593 with dry-run hash proof; its "no review file" point declined (architect asked for it). claude APPROVE. gemini skipped twice (agy exit 3, tooling). consult needed --issue 330 --project-id bugfix-330 (auto-detect fails with many projects).
- Open observation: apps/auth tests/limits.test.ts:263 test-body 30 s timeout once, capped, at load 249/375. Not fixed; no deadline raised.
- 2026-10-30: merged develop (PR #323 added --filter=!ansari-mcp to the root test script; mcp uses tsx --test, which would reject --maxWorkers). Script now 'turbo run test --filter=!ansari-mcp -- --maxWorkers=4'; pin updated; warm-cache proof re-run: miss/red without the flag, hit/green restored.
