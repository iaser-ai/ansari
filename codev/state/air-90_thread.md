# air-90 thread — Inkling model id + max_tokens env-configurable (issue #90)

## 2026-09-01 — implement phase start

Read issue, inkling-client.ts, config.ts, turbo.json, tests. Shape of the change:

- `lib/config.ts`: new optional env vars `INKLING_MODEL` (default `thinkingmachines/Inkling`)
  and `INKLING_MAX_TOKENS` (coerced int, **8192–16384 window enforced at parse**, default 8192,
  fail fast / no clamping). `config.inkling` grows `model` + `maxTokens`.
- `lib/ai/inkling-client.ts`: drop the hardcoded `INKLING_MODEL` export and
  `INKLING_MAX_TOKENS` const; read `config.inkling.model` / `.maxTokens` at call time
  (consistent with the lazy-getter config pattern).
- `lib/facilitator/agent.ts`: the two log-label uses of the old `INKLING_MODEL` export switch
  to `config.inkling.model` (agent already imports `config`).
- `turbo.json` `globalEnv`: both vars added — they're in the Zod schema (derivation step 1);
  under strict env mode an undeclared var is invisible AND absent from the cache key, so the
  staging override would silently no-op. This is exactly the failure the derivation exists for.
- Docs: `.env.example` + `docs/self-hosting.md`. Noticed `TINKER_API_KEY` was never documented
  in self-hosting.md — adding it alongside the new rows so the Inkling surface is coherent
  (lessons-critical: fix a doc defect everywhere, not just where you're editing).
- Tests: config.test.ts window-validation cases; inkling-client.test.ts updated mock +
  flow-through case; NEW inkling-env-config.test.ts uses the REAL config (no mock) with env
  vars + mocked fetch to pin (a) byte-identical default request payload, (b) tinker:// model
  flow-through, (c) max_tokens flow-through.

Unset-vars behavior is byte-identical by construction (defaults equal old constants); pinned
by full-body equality assert.

## 2026-09-01 — implement complete, PR open

- All checks green: typecheck, full `pnpm test` (70 files, 671 passed / 3 pre-existing skips),
  `pnpm build`, api lint 0 errors (7 pre-existing warnings).
- Diff: ~280 insertions incl. tests/docs; implementation surface itself is tiny. Well within AIR.
- Skipped CMAP: config-only change, per AIR guidance.
- PR #91 open against develop (`builder/air-90`), review embedded in PR body per AIR.
- At the **pr gate** — waiting for human approval. Staging var values (tinker:// LoRA id,
  INKLING_MAX_TOKENS=16384) are the architect's to set post-merge, per the issue's scope.
