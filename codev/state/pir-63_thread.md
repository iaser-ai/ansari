# Builder pir-63 — thread log

Issue #63: make `prototypes/ansari-expo` run end-to-end against the real API.

## Plan phase (2026-08-28)

Investigated prototype + apps/api via two Explore agents. Key facts established:

- **Everything lives in `prototypes/ansari-expo/`.** Prototype is OUTSIDE the pnpm
  workspace; it has its own isolated `node_modules` and a gitignored lockfile, so adding
  deps (expo-secure-store, vitest) does NOT touch root `pnpm-lock.yaml`. Verify this holds.
- **UI consumes vendored orval hooks/types** from `@/vendor/api-client-react` at 8 import
  sites (`_layout`, `index`, `chat/[id]`, `AnswerMessage`, `SafetyCard`, `CitationChip`,
  `CitationSheet`, `HistorySheet`). Types: `Conversation{id,title,preview,messageCount,...}`,
  `ConversationDetail`, `Message{role,content:string,citations[],safety?}`, `Citation`,
  `SafetySignal`, `SuggestedTopic{topic,questions[]}`, `MessageExchange`.
- **custom-fetch.ts is REUSED, not thrown away** — it already has `setBaseUrl`,
  `setAuthTokenGetter` (attaches `Bearer`), and the RN `hasNoBody` gotcha. Only the
  generated hooks/schemas get replaced by an adapter.
- **apps/api shapes confirmed** (register has NO names in response; login DOES; refresh has
  no `status`; threads use `thread_id`/`thread_name`; thread detail `content` is
  `string | ContentBlock[]`; every error body is `{detail}`; 401 on any bad/expired token).
- **Two chat endpoints exist.** `/threads/[id]/chat` = structured SSE JSON (`{type:text|
  tool_call|tool_result|error|done}`) + `: ping` heartbeats. Base `/threads/[id]` = raw-text
  stream. Issue names `/chat` (SSE) → targeting that.
- **`useSendMessage` return value is ignored by the screen** — chat/[id] just invalidates the
  detail query on success and re-reads GET /threads/{id}. So buffer-until-done streaming is
  low-risk and near-zero UI change (issue permits it if stated explicitly). Committing to it.
- **expo-secure-store is NOT a dep yet** — must add. Web has no SecureStore → Platform-branched
  store (SecureStore native / localStorage web), documented.

## SCOPE CHANGE from architect (2026-08-27)

Prototype talks DIRECTLY to staging `https://api-staging.askansari.ai` (verified live). Frontend
devs run NOTHING locally. Dropped the local-Postgres/RELEASE.md run path. Base URL configurable
via `EXPO_PUBLIC_API_URL`, **default = staging**. Register writes REAL staging rows (README +
register screen must say so). Tokens are REAL staging credentials → secure-store only, never
logged, never committed. Known/won't-fix: staging sends `allow-origin: *` + `allow-credentials:
true` (spec-invalid but harmless with bearer) — note in plan/README. Negative-shape test still a
hard gate (more important with a live API).

Plan drafted → `codev/plans/63-prototypes-ansari-expo-run-aga.md`. Awaiting plan-approval gate.
