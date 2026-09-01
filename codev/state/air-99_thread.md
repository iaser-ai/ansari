# air-99 — Per-turn model provenance (issue #99)

## 2026-09-01 — implement

- Branch base predated #73/#90/#95 merges, which #99 builds on directly
  (messageReadColumns, inkling config, PRIMARY_BACKEND). Merged origin/develop
  into builder/air-99 first; clean merge.
- Migration numbering: `drizzle-kit generate` emitted `0007_eager_shape.sql`
  (journal idx 7); renamed to `0008_model_provenance.sql` and edited the journal
  tag only — same procedure as 0007_tool_calls_persistence (idx 6), per the
  spec-73 lesson. Snapshot stays `0007_snapshot.json` (sequence-named).
- Design: provenance is computed in the facilitator at terminal-yield time from
  `useInklingRung` + config (`{provider, modelId}` on every `done`/`error` that
  a provider served). The gemini `modelId` is the request's configured primary;
  the intra-Vertex 429 fast-failover (#45) is NOT distinguished — it stays
  within provider 'gemini' and the issue's motivation (gemini vs inkling,
  rescues, checkpoints) doesn't need it. Documented in the schema comment.
- `config.gemini` is read lazily only on the gemini path (same rule as the
  ladder's model label): inkling-only deployments have a throwing getter.
  This surfaced immediately — primary-backend.test.ts's config mock throws on
  `config.gemini` suite-wide; its two gemini-path tests now legitimately read
  it, so the mock gained an opt-in `h.geminiConfig` (default: still throws).
- `persistOrphanToolCalls` takes `provenance` as a REQUIRED key (undefined ok)
  so no persist site can silently forget it.
- v1/chat/completions (leaderboard) deliberately untouched: the issue's "three
  persist sites" = spec 73's (threads POST, chat SSE, mcp-complete); the v1
  route has never persisted tool records/orphans either. Its OpenAI response
  `model` field already names the serving id.
- pglite DDL: fresh grep hit 9 `CREATE TABLE messages` + 3 `tool_call_orphans`
  across 9 test files; all patched, hit list recorded in
  tests/model-provenance.test.ts docstring.
- Full suite (76 api + 2 auth files), build, typecheck, lint: green.

## Deploy note (BLOCKING — same class as 0007)

Drizzle lists the new columns in every messages/orphans INSERT: **apply 0008 to
an environment BEFORE code deploys there.** Staging at merge time (architect),
prod at promotion.
