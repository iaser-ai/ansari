# PIR Plan: ansari-expo prototype against the real apps/api (auth + adapter + SSE chat)

## Understanding

`prototypes/ansari-expo/` is a frozen Replit-era Expo app whose entire data layer is an
orval-generated client (`vendor/api-client-react/`) for a *different* "Ansari 4" API. That API
has **zero endpoint overlap** with this repo's `apps/api`, and the prototype has **no auth**. This
issue closes the gap **on the prototype side only** — nothing in `apps/`, `packages/`, or root
config changes. The definition of done is a real end-to-end run: register → login → create thread
→ send a message → see the streamed answer → thread list shows it → logout → login again shows it.

**Scope change already applied (architect, 2026-08-27):** the prototype connects **directly to
staging** `https://api-staging.askansari.ai` (verified live: `GET /api/health` 200; unauth
`/api/v2/threads` → 401; CORS preflight from `http://localhost:8081` → 204 with `allow-origin: *`
and `Authorization` allowed, so Expo web works cross-origin). Frontend devs run nothing locally;
the local-Postgres/RELEASE.md path is dropped. Consequences folded into this plan:

- Base URL is configurable via `EXPO_PUBLIC_API_URL`, **defaulting to staging** (the `https://`
  hardcode drops from blocker to hygiene).
- **Register writes real rows into the staging DB**, and tokens are **real staging credentials** —
  so token storage is `expo-secure-store` only, never logged, never in a committed `.env`; the
  register screen and README must say the account is real.
- Known and **not fixed**: staging returns `allow-origin: *` together with `allow-credentials:
  true` (a spec-invalid pairing). Harmless here because we authenticate with bearer headers, not
  cookies; it would only bite cookie auth. Noted in the README.

### What the UI actually consumes (verified)

All UI data flows through 8 imports of `@/vendor/api-client-react`:

| File | Imports |
|---|---|
| `app/_layout.tsx:31` | `setBaseUrl` |
| `app/index.tsx:49-57` | `useListConversations`, `useCreateConversation`, `useDeleteConversation`, `useListSuggestedQuestions`, key helpers, `type Conversation` |
| `app/chat/[id].tsx:41-47` | `useGetConversation`, `useSendMessage`, key helpers, `type Citation`, `type Message` |
| `components/AnswerMessage.tsx:12` | `type Citation, Message` |
| `components/SafetyCard.tsx:6` | `type SafetySignal` |
| `components/CitationChip.tsx:6` | `type Citation` |
| `components/CitationSheet.tsx:26` | `type Citation` |
| `components/HistorySheet.tsx:29` | `type Conversation` |

Field usage that constrains the adapter's output:
- `HistorySheet` renders `conversation.title`, `.id`, `.preview`, `timeAgo(.updatedAt)`.
- `AnswerMessage` iterates `message.citations` (must be an **array**), splits `message.content`
  (must be a **string**), renders `<SafetyCard>` only when `message.safety` is truthy.
- `CitationChip/Sheet`, `SafetyCard` render only when citations/safety exist.

`custom-fetch.ts` is **kept and reused** — it already provides `setBaseUrl`, `setAuthTokenGetter`
(attaches `Authorization: Bearer <token>` before every request), `customFetch`, `ApiError`, and
the RN `hasNoBody` fix (`response.body` is `undefined` in RN even for full payloads). Only the
generated **hooks/schemas** are replaced.

### apps/api shapes (verified against `apps/api/src/app/api/v2/**`)

- `POST /users/register` body `{email, password(8–128), first_name?, last_name?, register_to_mail_list?}`
  → `{status:"success", access_token, refresh_token, token_type:"bearer"}` (**no names**). 409 existing
  email, 400 weak password, 422 validation.
- `POST /users/login` `{email, password}` → `{status, access_token, refresh_token, token_type,
  first_name, last_name}`. 401 `Invalid email or password`.
- `POST /users/refresh_token` `{refresh_token}` → `{access_token, refresh_token, token_type}` (**no
  `status`**). 401 on invalid/expired/reused.
- `POST /users/logout` — Bearer header, no body → `{message}`. (All-device: bumps session_version.)
- `GET /threads` → `[{thread_id, thread_name:string|null, source:string|null, created_at?, updated_at?}]`.
- `POST /threads` `{name?, source?}` → same element shape (single object).
- `GET /threads/{id}` → `{thread_id, thread_name, source, created_at?, updated_at?, messages:[{id,
  role, content:string|ContentBlock[], agent_name:string|null, source:string|null, created_at?}]}`.
  `content` is a **string** for a single text block, a **ContentBlock[]** otherwise.
- `POST /threads/{id}/chat` `{message}` → **`text/event-stream`**. Frames `data: <json>\n\n`:
  `{type:"text",content}`, `{type:"tool_call",name}`, `{type:"tool_result",tool,query,resultCount}`,
  `{type:"error",message}`, `{type:"done"}`, plus `: ping` heartbeat comment lines every ~15s.
- `GET /api/health` → `{status:"ok", service, timestamp}` (503 `{status:"error",...}` on DB fail).
- Every error body is `{detail:string}`. **Any bad/expired access token → HTTP 401** (never 403).

## Proposed Change

Build a **drop-in adapter** under `lib/api/` that exports the same hook names, query-key helpers,
and type names the UI already imports, but backed by `apps/api`. Every response is validated with
**zod v3** and **throws on shape mismatch** (react-query surfaces it as `isError`). Add a real auth
session (register/login screens, secure token storage, bearer wiring, refresh-on-401, logout, route
gating). Add an SSE streaming reader for chat. Then flip the 8 import specifiers from
`@/vendor/api-client-react` to `@/lib/api`. Suggested questions become a static client-side list.

**Loud-failure design (the non-negotiable gate).** The adapter's zod schemas describe the *apps/api
wire shapes* (`thread_id`, `thread_name`, …). Fixtures returning the **old Replit shapes**
(`{id,title,preview}`, `MessageExchange`, …) fail `.parse()` → the queryFn throws → react-query is
`isError`. Fields `apps/api` never provides — `preview`, `messageCount`, `citations`, `safety` —
are filled with documented constants (`''`, `0`, `[]`, `null`), exactly parallel to the issue's
"citations/safety are empty by design". These fills are **not** the silent-default the gate forbids:
the gate forbids defaulting a field that a *shape mismatch* removed; these are fields the API has by
design never carried. This distinction is documented in code comments and the README.

**Streaming decision (stated explicitly, as the issue requires).** The chat screen's `useSendMessage`
**ignores its return value** — on success it invalidates the detail query and re-reads
`GET /threads/{id}`; `sendMessage.isPending` drives the "Searching the sources…" indicator. So the
first PR **buffers the SSE stream to completion** (reassembling `text` events), then resolves; the
persisted answer then arrives via the existing refetch. This is the issue-sanctioned first-PR
approach ("buffering until `done` is acceptable … if the plan says so explicitly"). Live
token-by-token rendering is a documented follow-up (it needs new screen surface to read a partial
buffer). SSE `{type:"error"}` frames reject the mutation → the screen's error path shows.

**Streaming transport.** Use `fetch` from **`expo/fetch`** (Expo SDK 54 streaming fetch; real
`response.body` reader on native *and* web) for the chat POST, decode with `TextDecoder`, and parse
SSE frames (split on `\n\n`, skip lines starting with `:`, JSON-parse `data:` lines, tolerate
multi-chunk events). Documented fallback: XHR `onprogress` reading `responseText` incrementally.
Bearer is attached manually here (this path bypasses `customFetch`).

**Auth session.**
- Token store abstraction: **`expo-secure-store`** on native, `localStorage` on web (SecureStore is
  unavailable on web; documented). Tokens never logged.
- `AuthProvider` (React context) loads tokens on mount → `signedIn|signedOut|loading`; exposes
  `register/login/logout`; registers `setAuthTokenGetter(() => accessToken)` so `customFetch`
  attaches bearer.
- **Refresh-on-401:** `apiFetch` wraps `customFetch`; on `ApiError` 401 it calls
  `POST /users/refresh_token` once, stores the rotated pair, retries once; if refresh itself 401s it
  clears tokens → `signedOut`. A module-level single-flight lock prevents parallel refreshes.
- **Route gating** in `app/_layout.tsx`: unauthenticated users see `login`/`register`; authenticated
  users see the app. Logout clears storage and returns to login. Existing visual language kept
  (`StyleSheet.create`, `useColors`, `fonts`). The current placeholder "Log in" notice
  (`app/index.tsx` `showLogin`) becomes a real logout affordance (in `HistorySheet`).

**Suggested questions.** `lib/suggested-topics.ts` exports a static `SuggestedTopic[]`; the adapter's
`useListSuggestedQuestions` returns it. README states it is static (no endpoint).

**Health check.** Adapter `healthCheck()` targets `/api/health` (not the vendored `/api/healthz`),
zod-validated.

### Implementation order (commits within one PR)

1. **Config + base URL + static topics + health** (low risk): `EXPO_PUBLIC_API_URL` default staging,
   `_layout` base-URL swap, `.env.local.example`, `lib/suggested-topics.ts`, health → `/api/health`.
2. **Adapter + loud failure + shape tests (the gate)**: wire zod schemas, mappers, `apiFetch`,
   drop-in thread hooks (list/create/get/delete), and the negative+positive shape tests. Flip the
   type/hook imports for the thread + component files.
3. **Auth**: token store, auth API + zod, `AuthProvider`, login/register screens, refresh-on-401,
   `setAuthTokenGetter` wiring, route gating, logout affordance.
4. **Streaming chat**: `expo/fetch` SSE reader + parser, `useSendMessage` (buffer-until-done),
   error-frame surfacing, SSE parser unit tests.
5. **README rewrite + final verification**: retitle away from "reference only", document the
   staging run path, the static-suggestions + empty-citations/safety notes placed where a reader
   looks after seeing no chips, and the CORS quirk; run and paste the three hard-constraint checks.

## Files to Change

**New — adapter (`lib/api/`)**
- `lib/api/config.ts` — `resolveBaseUrl()` → `EXPO_PUBLIC_API_URL ?? 'https://api-staging.askansari.ai'`.
- `lib/api/wire-schemas.ts` — zod schemas for apps/api wire shapes (thread, thread list, thread
  detail, message, ContentBlock union, auth responses, health).
- `lib/api/mappers.ts` — wire → UI types; flattens `content` (string | ContentBlock[] → string, else
  throw); fills `preview:''`, `messageCount:0`, `citations:[]`, `safety:null` with comments.
- `lib/api/http.ts` — `apiFetch` (customFetch + single-flight refresh-on-401), error normalization.
- `lib/api/streaming.ts` — `streamChat()` (expo/fetch), `parseSSE()` (heartbeat/multi-chunk tolerant).
- `lib/api/hooks.ts` — `useListConversations`, `useCreateConversation`, `useGetConversation`,
  `useDeleteConversation`, `useSendMessage`, `useListSuggestedQuestions`, `useHealthCheck` + all
  `get*QueryKey` helpers, matching the vendored signatures.
- `lib/api/index.ts` — barrel: re-export hooks + key helpers + UI types (from vendored schemas) +
  `setBaseUrl`/`setAuthTokenGetter`/`customFetch`/`ApiError` (from the kept `custom-fetch.ts`).
- `lib/api/__tests__/wire-schemas.test.ts`, `mappers.test.ts`, `streaming.test.ts` (+ fixtures).

**New — auth + topics**
- `lib/auth/store.ts` — Platform-branched token store (SecureStore native / localStorage web).
- `lib/auth/api.ts` — register/login/refresh/logout fetchers + zod.
- `lib/auth/context.tsx` — `AuthProvider`, `useAuth`, `setAuthTokenGetter` wiring.
- `lib/suggested-topics.ts` — static `SuggestedTopic[]`.
- `app/login.tsx`, `app/register.tsx` — screens (register copy: "creates a real staging account").

**Edited**
- `app/_layout.tsx:31,34` — import `setBaseUrl` from `@/lib/api`; base URL from `config`; wrap tree in
  `AuthProvider`; register `login`/`register` `Stack.Screen`s + auth route guard; tune QueryClient so
  4xx/ZodErrors don't retry.
- `app/index.tsx:49-57`, `app/chat/[id].tsx:41-47` — import specifier `@/vendor/api-client-react` →
  `@/lib/api`; wire logout affordance.
- `components/AnswerMessage.tsx:12`, `SafetyCard.tsx:6`, `CitationChip.tsx:6`, `CitationSheet.tsx:26`,
  `HistorySheet.tsx:29` — type import specifier → `@/lib/api`.
- `.env.local.example` — replace `EXPO_PUBLIC_DOMAIN` with `EXPO_PUBLIC_API_URL=https://api-staging.askansari.ai`.
- `package.json` — add `expo-secure-store`, `expo/fetch` (bundled with expo, no add), and dev-only
  `vitest`; add `"test": "vitest run"`.
- `README.md` — retitle; staging run path; static-suggestions note; empty citations/safety note
  (placed where a reader looks after noticing no chips); CORS-quirk note; real-account warning.

**Untouched (verify): `apps/`, `packages/`, root config, root `pnpm-lock.yaml`, the 7-package turbo
graph.**

## Risks & Alternatives Considered

- **Risk — leaking into the workspace.** Adding deps/tests could drift root `pnpm-lock.yaml` or the
  turbo graph. *Mitigation:* prototype is outside `pnpm-workspace.yaml`; installs run inside the
  prototype (isolated `node_modules`, gitignored lockfile). The plan's Test section runs the two
  hard-constraint commands and fails the phase if either moves.
- **Risk — `expo/fetch` streaming behaves differently on native vs web.** *Mitigation:* parser is
  transport-agnostic and unit-tested against chunk-split fixtures; XHR `onprogress` fallback
  documented; buffer-until-done avoids partial-render edge cases for PR 1.
- **Risk — secure storage on web.** SecureStore throws on web. *Mitigation:* Platform branch to
  `localStorage`; documented that web storage is not hardware-backed (staging creds).
- **Risk — refresh-on-401 storms / races.** *Mitigation:* single-flight lock; one retry; refresh
  failure forces re-login.
- **Alternative — target the base `/threads/{id}` raw-text stream** (its route comment says the real
  frontend uses it). *Rejected:* the issue explicitly names `/chat` with the structured SSE schema; a
  structured protocol is easier to validate and surface errors from. Noted as a fallback if `/chat`
  proves wrong on staging.
- **Alternative — full RN render test** for the gate. *Rejected as the primary test:* heavyweight RN
  renderer infra; the queryFn-level test faithfully proves the error state via react-query's
  documented contract (a throwing queryFn ⇒ `isError`). A render test may be added if cheap.
- **Alternative — rewrite the vendored generated client in place.** *Rejected:* it's a frozen
  reference for a different API; a separate `lib/api/` adapter keeps a clean seam and reuses only
  `custom-fetch.ts`.

## Test Plan

**Automated (vitest, dev-only, inside the prototype):**
- **Shape gate (negative + positive):** `wire-schemas.test.ts` — each apps/api schema **throws** on
  the old Replit shape *and* on a known-good near-miss (e.g. `thread_id` missing), and **passes** on
  the real shape; assert hit counts, not a verdict. `mappers.test.ts` — `listConversations`/
  `getConversation` queryFns given a fake fetch returning old Replit `Conversation[]`/`MessageExchange`
  **reject** (ZodError); given real `/threads` data **return** mapped UI objects with `preview:''`,
  `citations:[]`; `content` as `ContentBlock[]` flattens, an unknown block **throws**.
- **SSE parser:** `streaming.test.ts` — reassembles `text` across chunk splits, skips `: ping`
  heartbeats, surfaces `{type:"error"}`, terminates on `{type:"done"}`.

**Manual (against staging, the definition of done):**
1. `cd prototypes/ansari-expo && pnpm install && pnpm start`; open web + iOS.
2. Register a fresh email → lands signed-in (note: real staging account).
3. Create a thread by asking a question → the "Searching the sources…" indicator shows → the
   streamed answer appears; thread list shows the new thread.
4. Send a follow-up → answer appears.
5. Logout → returns to login → login again → the thread + messages are still there.
6. Point `EXPO_PUBLIC_API_URL` at a fixture server returning old Replit shapes → the list shows an
   **error state**, not an empty list (mirrors the automated gate at runtime).

**Hard-constraint verification (pasted into the PR description):**
- `pnpm turbo run lint --dry=json | python3 -c "import json,sys;d=json.load(sys.stdin);print(len(d['packages']),d['packages'])"` → **exactly 7**.
- `git diff --stat pnpm-lock.yaml` → **empty**.
- No secrets committed; `git status` shows no `.env*`/`node_modules`/prototype lockfile/`.expo/`.

**Cross-platform:** verify the SSE reader and secure storage on **iOS** (SecureStore) and **web**
(localStorage + browser streaming fetch); Android best-effort.
