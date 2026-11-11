# bugfix-366 thread

## Investigate
- Root cause: `ATTRIBUTION` constant in `apps/api/src/app/api/v2/mcp-complete/route.ts:20` hardcodes `[ansari.chat](https://ansari.chat)`; appended to every answer at line 219 (response body and persisted assistant message).
- Only live test touching it (`apps/api/tests/mcp-complete.test.ts` "a normal answer still returns 200 with the attribution footer") asserts loosely `toContain('ansari.chat')`. Two other attribution tests are `it.skip` (pre-existing, JSON shape). Nothing pins the exact text.
- apps/mcp footer regex (`src/view/attribution.ts:16`) already accepts `askansari.ai`; `test/react-answers.ts` ANSWER_B covers it. No change needed there.
- Scope: ~1-line fix + exact-text test. Well within BUGFIX.

## Fix
- `ATTRIBUTION` now links `[askansari.ai](https://askansari.ai)`; rest of sentence unchanged.
- New test pins the exact response body and the persisted assistant content. It fails on HEAD's route (verified by reverting the route) and passes with the fix. The old loose `toContain('ansari.chat')` check now checks `askansari.ai`.
- api: typecheck clean, 87 files / 1147 tests pass. apps/mcp untouched; its suite needs `dist/` (a fresh worktree has none → 10 ENOENT failures until `pnpm build`).
- Architect/owner addition: commit `apps/mcp/.env.example` unchanged (PORT=3000; everything else commented out because set-but-empty MCP_ALLOWED_HOSTS/ORIGINS means allow none). Contents reviewed before committing: no secrets.
