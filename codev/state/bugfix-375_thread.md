# bugfix-375 thread

## Investigate
- Reproduced: with `dist/` built and no `dist-worker/`, `tsx --test test/parity-workers.test.ts` hung until a 60 s timeout killed it (exit 124).
- Root cause as the issue states: the Workers lifecycle test called `startRuntime` before its `try`, so the missing-bundle throw skipped `upstream.close()` and the listening server kept the event loop alive.

## Fix
- `startRuntime` now runs inside the `try`; the `finally` closes the runtime only if it started, and always closes the upstream.
- Regression test `apps/mcp/test/missing-bundle.test.ts` runs the lifecycle test in a child process with the bundle path pointed at a missing file (new test-only `MCP_TEST_WORKER_ENTRY` override in `runtime-harness.ts`), so it exercises the missing-bundle path even where CI has built the bundle. Without the fix it fails after 30 s (child killed); with it, it passes in ~2 s.
- Surprise: a `node --test` child inherits `NODE_TEST_CONTEXT` from the parent run and then exits 0 regardless; the test strips it from the child env.
- Full mcp suite with the bundle built: 148/148 pass; lint and typecheck clean.
