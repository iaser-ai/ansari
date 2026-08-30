# PIR Review: ansari-expo prototype against the real apps/api (auth + adapter + SSE chat)

Fixes #63

**Problem** — `prototypes/ansari-expo` was a frozen Replit-era Expo app whose entire data layer
was an orval client for a *different* ("Ansari 4") API with **zero endpoint overlap** with this
repo's `apps/api`, and it had **no auth**. Against our API the whole app was unusable.

**Approach** — a drop-in adapter under `lib/api/` that re-exports the same hook/type names the UI
already imports (8 sites) but is backed by `apps/api`, validating every response with **zod and
throwing on shape mismatch**; a real auth session (register/login/refresh/logout + secure token
storage); and an SSE streaming reader for chat. Everything is inside `prototypes/ansari-expo/`.

**Fix** — the prototype now boots against **staging** (`https://api-staging.askansari.ai`) by
default and runs the full flow: register / continue-as-guest → ask → streamed answer → thread
list → logout → login again.

**Testing** — 37 vitest unit tests (loud-failure gate + SSE + streaming + guest + storage), `tsc`
clean, and the three hard-constraint checks (below). The human verified the live flow on staging
at the dev-approval gate.

## Summary

Makes the `ansari-expo` prototype work end-to-end against this repo's real `apps/api` (deployed
staging), replacing the throwaway "Ansari 4" orval client with a zod-validated adapter that fails
**loudly** on any shape mismatch, a real auth session, and an SSE chat reader. The whole change is
contained in `prototypes/ansari-expo/`; nothing in `apps/`, `packages/`, root config, or the
workspace lockfile is touched.

**Human amendments folded in during the gates (not the builder's invention):**
- **Direct-to-staging** run path (no local Postgres); base URL configurable via
  `EXPO_PUBLIC_API_URL`, defaulting to staging.
- **Continue as guest** — registers/reuses a random `guest_<rand>@ansari.chat` account, mirroring
  the main app (human decision; #63 body updated).
- **Static sample citations** — a fixed, verified set (`lib/sample-citations.ts`) shown under
  khushu' answers so the citation UI is demonstrable; real citations arrive with **#66**.

## Files Changed

`git diff --stat` against the merge-base with `develop` (`48bee0c`), grouped:

**Adapter (`lib/api/`)** — `wire-schemas.ts`, `types.ts`, `mappers.ts`, `decode.ts`, `http.ts`,
`sse.ts`, `chat-stream.ts`, `streaming.ts`, `hooks.ts`, `index.ts`, `auth-bridge.ts` (+ tests
`decode.test.ts`, `sse.test.ts`, `chat-stream.test.ts`).
**Auth (`lib/auth/`)** — `store.ts`, `api.ts`, `context.tsx`, `guest.ts` (+ tests `guest.test.ts`,
`store.test.ts`).
**Screens/UI** — `app/_layout.tsx`, `app/login.tsx`, `app/register.tsx`, `components/AuthForm.tsx`,
`app/index.tsx`, `app/chat/[id].tsx`, `components/HistorySheet.tsx`, and 4 type-only import flips
(`AnswerMessage`, `SafetyCard`, `CitationChip`, `CitationSheet`).
**Data/config** — `lib/sample-citations.ts`, `lib/suggested-topics.ts`, `lib/api/config.ts`,
`.env.local.example`, `package.json` (+`expo-secure-store`, dev `vitest`), `vitest.config.ts`,
`README.md`.
**Codev** — plan, review (this file), thread, project `status.yaml`.

41 files changed, ~3182 insertions, ~181 deletions. (Full per-file stat in the PR's Files tab.)

## Commits

- `ce04ba8` Configurable API base URL (default staging) + static suggested topics
- `066ef9f` apps/api adapter: zod loud-failure decoders, drop-in hooks, SSE reader + tests
- `448744e` Auth: secure token store, session context with refresh-on-401, login/register screens
- `b2a0807` Wire adapter + auth into the app: base URL, AuthProvider/route guard, logout, trim citation copy
- `423fcac` Rewrite prototype README for the staging run path + prototype-limitation notes
- `c3d842d` Add 'Continue as guest' — random guest account registration (matches main app)
- `2edafeb` Static sample citations (khushu-gated) so the citation UI renders; real via #66
- `49c7402` Guest: reuse device's account, prove password scorer + weakened-generator failure, harden README
- `43ea25b` Make three quiet stream/storage failures loud: non-JSON frame, truncated stream, web setItem
- `567bbab` Negative test for loud web setItem: saveSession rejects on missing/throwing localStorage

## Review feedback addressed (integration REQUEST_CHANGES)

The 3-way consultation + main's integration review returned REQUEST_CHANGES. All findings are
fixed on this branch, each with a regression test proven to fail when its guard is removed:

- 🔴 **Double-POST on the no-body path** (`streaming.ts`) — the chat POST was re-sent when
  `response.body` was absent (duplicate message + double model invocation). Now the transport
  issues **exactly one request**: with a streaming body it reads the reader; without one it
  consumes `response.text()` already in hand. The XHR fallback (and its abort gap) is removed.
  Pinned by `streaming.test.ts` (counts requests across expo/fetch **and** XHR; both = 1).
- 🔴 **React Query cache survived logout** (`context.tsx`) — `queryClient.clear()` now runs on
  every principal transition (sign-in, guest sign-in, logout, failed refresh). Pinned by the
  cross-account `context.test.tsx` (seed user A → sign in as B → cache empty; and logout).
- 🟠 **AuthGate rendered the mismatched route during redirect** (`_layout.tsx`) — now renders a
  spinner while `redirecting`, so no protected screen/query mounts signed-out.
- 🟠 **Static citations on unrelated follow-ups** — narrowed to the **first assistant answer** of
  a khushu' thread only (architect's decision); README + module header updated. New
  `decode.test.ts` case asserts follow-ups get `[]`.
- **Malformed `text` SSE frame** (`chat-stream.ts`) — a `text` frame whose `content` isn't a
  string now throws instead of being silently dropped (`chat-stream.test.ts`).
- **History list swallowed errors** — `HistorySheet` now shows an explicit error state on
  `conversationsQuery.isError` instead of an empty "no history" (the empty-vs-broken confusion
  this PR exists to kill).
- **Chat send failures were invisible** — `chat/[id].tsx` shows a "couldn't be delivered" notice
  with retry when a send / SSE `error` frame fails, instead of just dropping the spinner.
- **Honesty**: search placeholder + comments corrected to "title-only, client-side" (no
  server full-text search); `timeAgo('')` → `''` guard (was "NaNd"), pinned by `time.test.ts`;
  `useDeleteConversation` now validates with `messageResponseSchema` (was misleadingly named).

## Test Results

- **Build**: ✓ (porch `build` check green)
- **`pnpm test`** (vitest): ✓ **45 tests**, 8 files. **`tsc --noEmit`**: ✓ clean.
- **Manual (human, staging)**: register / continue-as-guest → ask → streamed answer → thread list
  → logout → login again, verified at the dev-approval gate.

**Negative tests (each proves loud failure — a check that cannot fail is not evidence):**
- `decode.test.ts` — the adapter **throws (ZodError)** on the old Replit `Conversation[]` /
  `ConversationDetail` / `MessageExchange` shapes and on near-misses (wrong-typed `thread_id`,
  numeric message `content`); positive cases decode correctly; sample citations attach only to
  khushu' threads.
- `chat-stream.test.ts` — the SSE reducer **throws** on a non-JSON `data:` frame, **throws** on an
  `{type:"error"}` frame, and **throws** when the stream ends without a `done` frame; a
  `done`-terminated stream resolves.
- `guest.test.ts` — proves the password scorer discriminates (`abcdefgh`→2, `password`→penalised,
  varied→≥5) **and** that a weakened generator (lowercase-only, 8 chars) fails the ≥3 bar, so the
  production assertion genuinely fails if the generator regresses.
- `store.test.ts` — `saveSession` **rejects** when web `localStorage` is missing and when
  `setItem` throws `QuotaExceededError`; resolves with a working stub. Verified it fails when the
  guard is removed (reverting `setItem` to swallowing makes cases (a)+(b) fail; restored → green).

## Hard-constraint verification

```text
# 1) Turbo task graph still resolves to exactly 7 packages
$ pnpm turbo run lint --dry=json | python3 -c "import json,sys;d=json.load(sys.stdin);print(len(d['packages']),d['packages'])"
7 ['@ansari/auth', '@ansari/eslint-config', '@ansari/tsconfig', '@ansari/types', 'ansari-api', 'ansari-auth', 'ansari-frontend']

# 2) Root pnpm-lock.yaml is byte-identical
$ git diff --stat pnpm-lock.yaml
<no output — byte-identical>

# 3) No secrets/artifacts committed (all gitignored, shown by --ignored)
$ git status --porcelain --ignored prototypes/ansari-expo | grep -E '\.env|node_modules|pnpm-lock|\.expo'
!! prototypes/ansari-expo/.env.local
!! prototypes/ansari-expo/.expo/
!! prototypes/ansari-expo/node_modules/
!! prototypes/ansari-expo/pnpm-lock.yaml
```

The prototype stays outside the pnpm workspace: its deps install into an isolated (gitignored)
`node_modules` via `pnpm install --ignore-workspace`, so the root lockfile and the 7-package graph
are untouched.

## Architecture Updates

No changes to `arch-critical.md` / `arch.md`. Everything lives in `prototypes/ansari-expo/`, a
throwaway reference **outside** the pnpm workspace and outside the `apps/`/`packages/` module
boundaries; it introduces no cross-cutting system-shape fact for the main app. The prototype's own
architecture (adapter seam, auth bridge, SSE reducer) is documented in its `README.md` and inline.

## Lessons Learned Updates

No new entries in the capped `lessons-critical.md` / `lessons-learned.md` — the reusable lessons
here **reinforce existing hot-tier entries** rather than add new ones:
- *"a correct empty state and a broken state can look identical, so the adapter must fail loudly"*
  is the existing "prefer failures that are loud over checks that are quiet" lesson, applied to a
  UI whose citations/safety are legitimately empty.
- The negative tests that **fail when the guard is removed** are the existing "a verification
  pattern is code, and untested code is not evidence" lesson.

One prototype-narrow gotcha worth recording here (too specific for the project-wide tier): a
package nested **inside** a pnpm workspace must be installed with `pnpm install --ignore-workspace`,
or pnpm walks up to the root `pnpm-workspace.yaml` and installs the workspace instead — silently
skipping the nested package. Captured in the prototype README.

## Things to Look At During PR Review

- **The loud-failure seam** (`lib/api/decode.ts` + `wire-schemas.ts`): sample citations and
  `preview`/`messageCount`/`safety` are *fields the API never carries* (filled by design), NOT
  silent defaults masking a mismatch — the zod parse upstream throws on a real mismatch. The
  `decode.test.ts` negative cases are load-bearing; don't delete them as redundant.
- **Streaming is buffer-until-done** (`streaming.ts`) — a stated prototype limitation, not the
  intended UX (live rendering is #-follow-up). The reducer already delivers each `text` event to
  `onEvent` for that follow-up.
- **Sample citations are khushu'-gated** (`mappers.ts` `isKhushuThread`) — ask *"How can I develop
  khushu' in my prayer?"* to see them; other threads correctly show none.
- **Web token storage is `localStorage`** (XSS-reachable) — acceptable only for a staging
  prototype; flagged in README as not-for-production.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder `pir-63` → **Review Diff**.
- **Run the app** (interactive):
  ```bash
  cd prototypes/ansari-expo
  pnpm install --ignore-workspace   # isolated, gitignored node_modules
  pnpm start                        # w = web, i = iOS, a = Android; defaults to staging
  ```
  Then: register / **Continue as guest** → ask a question → streamed answer → **History** → **Log
  out** → log in again (thread persists). Ask *"How can I develop khushu' in my prayer?"* to see
  the sample citation pills.
- **Unit tests**: `cd prototypes/ansari-expo && pnpm install --ignore-workspace && pnpm test && pnpm typecheck`.
