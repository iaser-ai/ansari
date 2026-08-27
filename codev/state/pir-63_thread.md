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

## Architect resolutions (2026-08-27, at plan gate)

- Callout (1): **stay on `/threads/[id]/chat`** — the base `POST /threads/[id]` runs the same
  facilitator but emits raw text, not structured SSE, so `/chat` is strictly better for error
  surfacing. No fallback needed unless staging contradicts.
- Callout (2): **buffer-until-done accepted**.
- **IMPLEMENT-PHASE TODO (non-blocking):** trim the About copy in `app/index.tsx:331`
  ("every answer cites its sources") since citations are empty against our API.

Plan gate: read by prototypes architect, forwarded to human via main (held in mailbox). Waiting
for human decision relayed by architect before `porch approve`.

## PLAN APPROVED (2026-08-27) — conditions attached (all in #63 scope)

1. **README**: state plainly that buffer-until-done is a **PROTOTYPE LIMITATION**, not intended
   UX; the real app should render incrementally — a frontend dev must not copy the spinner.
2. **README**: web tokens live in `localStorage`, are XSS-reachable in principle, acceptable
   ONLY because it is staging — do not carry the pattern into the real app.
3. Trim About text at `index.tsx:331` ("every answer cites its sources") — false against our API.
- Live-streaming follow-up is a SEPARATE queued issue filed by architect — **don't build it**.
- **dev-approval is the next human gate — stop there and message the architect.**

## Implement phase (2026-08-28)

- **CRITICAL install gotcha:** the prototype now lives INSIDE a pnpm workspace, so a bare
  `pnpm install` from the prototype dir installs the whole ROOT workspace (ignoring the
  prototype's own package.json). Must use **`pnpm install --ignore-workspace`** to get the
  isolated node_modules the README promises. README run instructions updated to match.
- **Never run any `pnpm install` variant from the worktree root** — `--ignore-workspace` from
  root rewrote the root `pnpm-lock.yaml` (12 deletions); restored with `git checkout
  pnpm-lock.yaml`. Always `cd` into the prototype first. Root lockfile is back to byte-identical.
- Added `expo-secure-store ~15.0.8` (SDK-54 bundled version) + `vitest ^3` + `test`/`typecheck`
  scripts to the prototype package.json. Prototype node_modules + its lockfile are gitignored.

### Implementation complete — 5 commits, awaiting dev-approval

1. Configurable base URL (default staging) + static suggested topics + `.env.local.example`.
2. Adapter (`lib/api/`): zod wire-schemas, mappers, `decode.ts` pipeline, `apiFetch`
   (refresh-on-401), `sse.ts` parser, `streaming.ts` (expo/fetch primary + XHR fallback,
   buffer-until-done), drop-in hooks, barrel. Tests: `decode.test.ts` (loud-failure gate,
   old Replit shapes throw) + `sse.test.ts`. 17 tests pass.
3. Auth (`lib/auth/`): secure token store (SecureStore native / localStorage web), session
   context (single-flight refresh, bridge wiring), `AuthForm` + login/register screens.
4. Wire-up: `_layout` base URL + AuthProvider + route guard + retry-tuning; flipped 8 imports
   `@/vendor/api-client-react` → `@/lib/api`; logout in chrome + HistorySheet; trimmed the
   now-false "cites its sources" copy (About + web meta).
5. README rewrite + this thread.

**Verification:** `tsc --noEmit` clean; `vitest run` 17/17; turbo graph = **7 packages**;
root `pnpm-lock.yaml` byte-identical; no `.env`/node_modules/lockfile staged. Streaming +
secure-store validated by module resolution + typecheck; full manual run is the dev-approval
gate (reviewer runs `afx dev pir-63` / Run Dev against staging).

**Not runnable by me headless:** the actual register→ask→stream flow needs an interactive
Expo session — that's the reviewer's job at the gate.

### Gate feedback #1 (2026-08-28): "Continue as guest"

Human asked to replicate the main app's guest login (random `guest_<rand>@ansari.chat` /
"Welcome Guest" account, `register_to_mail_list:false`). Added `lib/auth/guest.ts`
(`generateGuestCredentials`, crypto/Math random, password guaranteed score ≥5 vs backend's
min 3) + a "Continue as guest" button on both auth screens (registers then the route guard
redirects). Verified `@ansari.chat` is NOT reserved by apps/api (only admin emails +
`@system.ansari.chat`). Added `guest.test.ts` (500-iteration email/password-strength check).
tsc clean; 19 tests pass. Gate still pending.

### Amendment: static sample citations (issue #63 comment — human decision, BLOCKS gate)

Implemented `lib/sample-citations.ts` (3 verified citations: Qur'an 20:14 Ta-Ha, Qur'an 23:1-2
al-Mu'minun, Sahih al-Bukhari 528 — Arabic + faithful translations + source urls; Bukhari 528
text cross-checked via web search since sunnah.com 403s automated fetch). Header comment states
they're fixed sample data, not answer-derived, real when #66 ships. Placement = **preferred
(khushu-gated)**: `mapConversationDetail` attaches the set only to assistant messages when the
first user message matches `/khush/i`; every other thread stays `citations:[]`. README citations
bullet rewritten to "sample data by design", names #66, tells the demoer to ask the khushu'
question. Loud-failure gate intact (old shapes still throw; non-khushu fixture still asserts
`[]`). Added 2 decode tests. 21 tests pass.

### Guest feature — architect flagged (2026-08-27)

Architect didn't request it and is confirming with main whether the human asked directly. It came
as a DIRECT human message in my builder pane ("the main application has a login as guest
option... replicate the behavior"). Left as-is, NOT extending, per architect's instruction.
