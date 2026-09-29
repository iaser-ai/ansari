# PIR Plan: Re-wire prototypes/ansari-expo onto the new design (auth, real API, streaming)

## Understanding

PR #123 (issue #121) made the Replit dark-mode design the source of truth for
`prototypes/ansari-expo`'s `app/`, `components/`, `constants/`, `hooks/`, and
most of `lib/` — but deliberately did **not** reconnect it to this repo's real
backend. The real-backend modules from the earlier pass are all still in the
tree, untouched, with passing tests, but nothing imports them:

- `lib/api/` — the `apps/api` adapter (zod wire schemas, single-POST SSE
  reader, mappers). Its barrel (`lib/api/index.ts`) is explicitly *"a drop-in
  replacement for `@/vendor/api-client-react`… only their import specifier
  changes"*: it exports the same hook names the new pages already call
  (`useListConversations`, `useGetConversation`, `useCreateConversation`,
  `useSendMessage`, `useListSuggestedQuestions` + matching query-key helpers),
  and `lib/api/types.ts` re-exports `Citation` / `Message` / `SafetySignal` /
  etc. from the **exact same** `vendor/api-client-react/generated/api.schemas.ts`
  file the new components import types from. **Verified by inspection** — there
  is zero type incompatibility to reconcile.
- `lib/auth/` — token store (`store.ts`), session context (`context.tsx`:
  `AuthProvider` / `useAuth` with login / register / guest / logout /
  refresh-on-401), guest credential generator. `context.tsx` registers its
  token getter and 401 handler with both the vendored `custom-fetch` runtime
  *and* `lib/api/auth-bridge.ts` (the streaming path's auth seam) — so once
  `AuthProvider` is mounted, every transport picks up the bearer token with no
  further wiring. No UI entry point exists: `app/login.tsx` / `app/register.tsx`
  and the `AuthForm` component were deleted in #121.
- `lib/chat-reconcile.ts` / `lib/chat-trace.ts` — the PIR #65 incremental-render
  reconciler (pure functions: synthetic in-progress bubble, identity
  reconciliation of the carried-in question, landed-answer detection, the
  live retrieval trace). Unimported.

The current wiring is broken by design: every data screen imports the **vendored**
`@workspace/api-client-react` client directly, and `app/_layout.tsx` calls its
`setBaseUrl(`https://${process.env.EXPO_PUBLIC_DOMAIN}`)` — a Replit-workspace
variable nothing in this repo sets — so requests resolve against no host and
every fetching screen errors/empties. Chat is a plain mutation with no `onEvent`,
so answers never stream.

This issue is **wiring, not behaviour change** to those four modules (the issue
and their own test suites say they are already correct). Baseline confirmed
green in the worktree: `pnpm typecheck` clean, `pnpm test` = 218 passing across
12 files (incl. `chat-reconcile`, `chat-trace`, `api/*`, `auth/*`).

### Task-checklist term corrections (found during investigation)

- The issue says swap in `lib/api/config.ts`'s **`apiBaseUrl()`**. The actual
  export is **`resolveBaseUrl()`** (reads `EXPO_PUBLIC_API_URL`, defaults to
  `https://api-staging.askansari.ai`, trims trailing slash). Plan uses the real
  name.
- `.env.local` is symlinked into the worktree with
  `EXPO_PUBLIC_API_URL=https://api-staging.askansari.ai` already set (Omar), so
  staging works on a fresh `expo start` with no extra config.

## Proposed Change

Six work streams, in dependency order. Streams 1–2 are the mechanical spine;
3–4 are the real work; 5 is gated on a product call; 6 is docs.

### 1 — Repoint imports `@workspace/api-client-react` → `@/lib/api` (mechanical)

11 import sites. For the 9 type-only / hook sites it is literally the specifier:

```diff
-} from '@workspace/api-client-react';
+} from '@/lib/api';
```

- `components/AnswerMessage.tsx:21` — `type { Citation, Message }`
- `components/AnswerProse.tsx:26` — `type { Citation }`
- `components/SafetyCard.tsx:6` — `type { SafetySignal }`
- `components/SourceFolio.tsx:9` — `type { Citation }`
- `components/SourcePanel.tsx:20` — `type { Citation }`
- `components/SourceStack.tsx:23` — `type { Citation }`
- `components/CitationChip.tsx:6` — `type { Citation }`
- `components/Sidebar.tsx:42-47` — `getListConversationsQueryKey`,
  `useDeleteConversation`, `useListConversations`, `type Conversation`
- `app/index.tsx:79` — `getListConversationsQueryKey`,
  `getListSuggestedQuestionsQueryKey`, `useCreateConversation`,
  `useListSuggestedQuestions`
- `app/chat/[id].tsx:80` — `getGetConversationQueryKey`,
  `getListConversationsQueryKey`, `useGetConversation`, `useSendMessage`,
  `type Message` (this file also gets stream work — stream 4)

After this, nothing imports the bare `@workspace/api-client-react` specifier.
The `tsconfig.json` `paths` entry and the `metro.config.js`
`resolver.extraNodeModules` entry for it become dead but harmless (the vendored
files stay — `lib/api` and `lib/auth` still import them via the `@/vendor/…`
alias). **Leave both alias entries in place** — removing them is unrelated
risk; note their new vestigial status in the README (stream 6).

### 2 — `app/_layout.tsx`: base URL, AuthProvider, session gate, routes

- Replace `import { setBaseUrl } from '@workspace/api-client-react'` +
  `setBaseUrl(`https://${process.env.EXPO_PUBLIC_DOMAIN}`)` with:
  ```ts
  import { setBaseUrl } from '@/lib/api';
  import { resolveBaseUrl } from '@/lib/api/config';
  setBaseUrl(resolveBaseUrl());
  ```
- Port the pre-#121 `QueryClient` retry policy (the "loud failure" gate): a
  `ZodError` or a 4xx `ApiError` must **not** be retried into a spinner — a
  shape mismatch has to surface as `isError`. (`lessons-critical`: prefer loud
  failures.)
- Mount `<AuthProvider>` (from `@/lib/auth/context`) **inside**
  `<QueryClientProvider>` (it calls `useQueryClient`) and above
  `GestureHandlerRootView` — i.e. wrap the existing
  `GestureHandlerRootView…MessageActionSheet` subtree.
- Register the two auth routes in `RootLayoutNav`'s `<Stack>`:
  `<Stack.Screen name="login" />`, `<Stack.Screen name="register" />`.
- Add a session gate. Shape depends on the stream-5 product call:
  - **account-first** → port pre-#121's `AuthGate` (segments-based redirect:
    signed-out → `/login`; signed-in on an auth route → `/`; a quiet
    `ActivityIndicator` while `status === 'loading'` or a redirect is imminent,
    so no protected screen mounts its queries early).
  - **accountless-optional** → no forced redirect; `AuthGate` only holds the
    `loading` frame, and `/login` `/register` are reachable on demand from the
    sidebar / account chrome. Protected data still works signed-out because
    `apps/api` accepts guest/anon threads. *(Recommended — see stream 5.)*
- `AppFrame` currently renders `<Sidebar/>` / `<SidebarDrawer/>` (and
  `<AccountChrome/>` on desktop) for **every** route. Gate these on
  `!isAuthRoute` (derived from `usePathname()`, same pattern as the existing
  `reading` check) so the login / register screens render clean over the shared
  paper without the rail. Keeps the "mounted once above the navigator"
  invariant for every non-auth route.

### 3 — Auth screens in the new visual language

New files, built from the new design tokens (not restored byte-for-byte):

- `components/AuthForm.tsx` — one presentational form, `mode: 'login' | 'register'`.
  Visual language from `app/about.tsx` + the token system: centred masthead
  (`AnsariMarkBrass`), `fonts.display*` for the title, `PaperBackground` is
  already under it via `AppFrame` (do **not** re-wrap — draw onto the shared
  paper), `KeyboardAvoidingViewCompat`, `useSafeAreaInsets` + `phoneGutter`.
  Fields use `colors.card` / `colors.inputRim` / `colors.inputRimFocus` /
  `colors.foreground`; primary button `colors.primary` / `colors.primaryForeground`;
  errors `colors.destructive`; the "or / continue as guest" divider and the
  login↔register switch link as in pre-#121. Wires `useAuth()` →
  `login(email, password)` / `register({email,password,firstName,lastName})` /
  `loginAsGuest()`. Reports errors inline (`AuthError.message` carries the
  server `detail`); on success the auth status flips and the gate (or an
  explicit `router.replace('/')`) navigates.
- `app/login.tsx` → `<AuthForm mode="login" />`
- `app/register.tsx` → `<AuthForm mode="register" />`

Scope guard (from the issue): fit the existing dark-mode token system, no new
visual design work.

### 4 — Streaming render in `app/chat/[id].tsx`

Reconnect `lib/chat-reconcile.ts` + `lib/chat-trace.ts`, porting the pre-#121
wiring pattern onto the **new** screen (which must keep its glide-in transition,
non-inverted `FlatList`, `scrollPending` / `atBottom` / jump-to-latest, source
panel, `drawn`-set animation gating, `carriedInWait`, `SendFailure`).

- `useSendMessage`: add the top-level `onEvent` option (sibling of `mutation`,
  per `SendMessageOptions`): `text` → `setStreamingText(p => p + event.content)`
  (guard `typeof event.content === 'string'` — `consume()` fires `onEvent`
  before validating); `tool_call` / `tool_result` →
  `setTrace(p => traceReducer(p, event))`. Leave partial `streamingText` intact
  on error.
- State: `streamingText`, `trace`, `keyOverrides`, `turnSeq` (ref), `streamKey`
  (ref), `sentAtCount` (ref, `null` ≠ `0`).
- Replace the inline `messages` `useMemo` with `reconcileThread({ serverMessages,
  q, conversationId, streamingText, streamKey: streamKey.current, sentAtCount:
  sentAtCount.current })`; take `{ messages, landedAnswer }` from it.
- Done hand-off effect: when `streamingText && landedAnswer`, set
  `keyOverrides[landedAnswer.id] = streamKey.current`, clear `streamingText` +
  `trace` in the same commit.
- `keyExtractor` → `keyFor(m) = keyOverrides[m.id] ?? m.id`.
- `send()`: require `conversationQuery.data` to have **resolved** before sending
  (the reconciler baseline is the persisted message count; `?? 0` would read an
  unloaded thread as empty and clear the stream). Capture
  `sentAtCount.current = data.messages.length`, bump `turnSeq`, set
  `streamKey.current`, reset `streamingText` / `trace`. Composer stays disabled
  until `conversationQuery.data` (defence in depth).
- **Animation-gating × hand-off (main integration risk).** The new screen gates
  entrance animations with `isNewContent(item.id)` against a `drawn` ref-set. On
  hand-off the persisted answer's real id is new to that set, so it would
  re-animate the instant it replaces the synthetic bubble — a flicker the whole
  reconciler exists to prevent. Fix: gate on `keyFor(item)` (not `item.id`), and
  when writing a `keyOverride` also `drawn.current.add(streamKey)` — so the row
  keeps one stable identity across the swap and never counts as new twice.
- `ThinkingLine`: extend with an optional `trace?: TraceEntry[]` prop. When
  non-empty, render `trace.map(formatTraceLine)` as stacked lines (keep
  `AnsariMarkPulse`, `fonts.displayItalic`, the existing row layout); empty →
  today's single "Searching the sources…" line. The `ListFooterComponent`
  passes `trace` while `awaitingAnswer && !streamingText`; once text streams the
  synthetic bubble carries it and the footer steps aside (matches pre-#121
  `ThinkingIndicator`).
- `SendFailure`: keep the new component; also trigger it on a
  `type:"error"` SSE frame (surfaces as the mutation's `onError`), retry via the
  captured last question.

### 5 — Sidebar / AccountChrome accountless copy — **OPEN QUESTION, needs Omar**

Not implemented until Omar decides at the plan-approval gate. The strings /
affordances that assume "no accounts ever" (Replit's real "Ansari 4" product
copy, not placeholders):

- `components/Sidebar.tsx`
  - `showLogin()` (line ~285) — toast *"Sign-in is on the way … Signing in … is
    coming."* → should navigate to `/login`.
  - `showPrivacy()` (line ~279) — *"There are no accounts yet, so nothing here
    is tied to your name"* → factually wrong once accounts return.
  - The "Keep what you've learned / Sign in and your questions stay with you"
    callout + "Log in" button — copy is already sign-in-shaped; the button
    target changes from toast → `/login`.
- `components/AccountChrome.tsx` (desktop top-right) — `showLogin` / `showSignUp`
  toasts → `/login` / `/register`.
- Whether signed-in state shows anywhere (name/email, "Log out") in the rail
  colophon and/or `AccountChrome`, and whether the guest→account framing stays.

**The product call (issue's "Open question):** does the prototype keep "Ansari 4"'s
accountless framing with auth as an optional add-on, or return to the
account-first flow the pre-#121 prototype had? This decides stream 2's gate
shape and how much of the above copy changes.

- **Recommendation: accountless-optional.** Lowest-risk, matches the shipped
  "Ansari 4" direction, and `lib/auth` already supports it (guest login, and
  `apps/api` serves anon threads). Auth becomes: sidebar/account-chrome "Log in"
  → real screen; signed-in state shown in the colophon; no forced redirect.
- If Omar wants **account-first**, stream 2 ports the full `AuthGate` redirect
  and the sidebar callout/affordances get a heavier rework.

Plan-approval will present exactly this choice; implementation of stream 5
follows the answer.

### 6 — README "Current state"

- Rewrite `## Current state: design only, not wired (issue #121)` to describe a
  working end-to-end flow against staging (register → ask → stream → history →
  logout/login), mirroring what #121 rewrote away from.
- Update `## Auth & token storage (kept, disconnected)` → connected.
- Update `## The `@workspace/api-client-react` bridge` — note the app now imports
  `@/lib/api`; the bare-specifier alias remains only as a vendored-runtime
  resolution path and is no longer used by app code.
- Revisit `## Known gaps from the port` (web fonts gap is unrelated, keep).
- Fix consistently — `lessons-critical`: a partial docs fix makes several docs
  disagree.

### 7 — Minor: `@react-navigation/native` peer bump (architect-suggested)

`package.json` pins `@react-navigation/native` at `7.3.13`; expo-router's
transitive deps want `^7.3.18` (install-time peer warning). Bump to `^7.3.18`
(resolves to the latest 7.3.x). We're already in the nav/auth layer, the
lockfile is gitignored, and the diff is one line. Fold it in; verify the peer
warning is gone and typecheck/tests still pass.

## Files to Change

**Imports (stream 1)** — specifier swap only:
- `prototypes/ansari-expo/components/AnswerMessage.tsx:21`
- `prototypes/ansari-expo/components/AnswerProse.tsx:26`
- `prototypes/ansari-expo/components/SafetyCard.tsx:6`
- `prototypes/ansari-expo/components/SourceFolio.tsx:9`
- `prototypes/ansari-expo/components/SourcePanel.tsx:20`
- `prototypes/ansari-expo/components/SourceStack.tsx:23`
- `prototypes/ansari-expo/components/CitationChip.tsx:6`
- `prototypes/ansari-expo/components/Sidebar.tsx:42-47`
- `prototypes/ansari-expo/app/index.tsx:79`

**Layout / gate (stream 2):**
- `prototypes/ansari-expo/app/_layout.tsx` — base URL, `QueryClient` retry
  policy, `<AuthProvider>`, `AuthGate`, `login`/`register` `Stack.Screen`s,
  `AppFrame` rail-gating on auth routes.

**Auth screens (stream 3):**
- `prototypes/ansari-expo/components/AuthForm.tsx` — new
- `prototypes/ansari-expo/app/login.tsx` — new
- `prototypes/ansari-expo/app/register.tsx` — new

**Streaming (stream 4):**
- `prototypes/ansari-expo/app/chat/[id].tsx` — `onEvent`, reconciler + trace
  wiring, `keyFor`, done hand-off, `send()` baseline guard, animation-gating fix
- `prototypes/ansari-expo/components/ThinkingLine.tsx` — optional `trace` prop

**Accountless copy (stream 5 — pending product call):**
- `prototypes/ansari-expo/components/Sidebar.tsx` — `showLogin` nav, privacy
  copy, callout button target
- `prototypes/ansari-expo/components/AccountChrome.tsx` — link targets, maybe
  signed-in state

**Docs / deps:**
- `prototypes/ansari-expo/README.md`
- `prototypes/ansari-expo/package.json` — `@react-navigation/native` `^7.3.18`

**No changes** to `lib/api/**`, `lib/auth/**`, `lib/chat-reconcile.ts`,
`lib/chat-trace.ts`, or their tests (issue is explicit; behaviour is already
correct). No changes to `apps/api` (out of scope).

## Risks & Alternatives Considered

- **Risk — streaming hand-off re-animates under the new `drawn`-set gating.**
  The new `chat/[id].tsx` gates entrances on message id; the pre-#121 screen
  had no such gate. Mitigation in stream 4: gate on `keyFor(item)` and seed the
  `drawn` set with the stream key on hand-off. Verify manually (no flicker on
  `done`) and consider a `chat-reconcile` test only if a pure seam emerges —
  the fix is screen-side.
- **Risk — `AuthProvider` ordering / cache clears.** `applySession` and failed
  `refresh` call `queryClient.clear()` on every principal transition (by
  design: guest→register on one device). Must sit inside `QueryClientProvider`.
  Startup restore fires one `clear()` before the first screen paints — harmless.
- **Risk — `AppFrame` "mounted once" invariant.** Gating the rail on auth routes
  must not remount it for normal navigation. Use the same `usePathname()`
  derivation the `reading` flag already uses; the rail stays mounted for every
  non-auth route exactly as today.
- **Risk — SSE against real staging.** `lib/api/streaming.ts` issues exactly one
  POST and has its own 401→refresh→retry; `expo/fetch` streams `response.body`
  on web and native. Covered by `streaming.test.ts` / `chat-stream.test.ts`.
  Manual verification is the real check (`lessons-critical`: "tests pass" ≠ "it
  works").
- **Alternative — keep the vendored client, just fix its base URL.** Rejected:
  the vendored orval client targets a *different* API contract; `lib/api` is the
  adapter that maps `apps/api`'s wire shapes onto the shared schema types. The
  issue is explicit that `lib/api` is the target.
- **Alternative — restore pre-#121 `login.tsx` / `AuthForm.tsx` / `chat/[id].tsx`
  byte-for-byte.** Rejected by the issue: auth screens must fit the new dark
  design, and the new chat screen carries substantial design work (glide
  transition, source panel, jump-to-latest, a11y announcements) that must be
  preserved — only the streaming plumbing is ported.
- **Alternative — remove the dead `@workspace/api-client-react` alias.**
  Deferred: out of scope, and the entries are inert. Documented instead.

## Test Plan

**Automated (acceptance gate):**
- `pnpm install --ignore-workspace` — clean, and the `@react-navigation/native`
  peer warning is gone.
- `pnpm typecheck` — clean.
- `pnpm test` — all 12 suites / 218 tests still green (`chat-reconcile`,
  `chat-trace`, `api/*`, `auth/*` unchanged and must not regress). Add a
  `ThinkingLine` render assertion for the `trace` branch only if a jsdom
  component test fits the existing setup; otherwise cover via manual.

**Manual against real staging (`EXPO_PUBLIC_API_URL` from `.env.local`), the
issue's acceptance walk — `pnpm start`, web first:**
1. Register (new email) → land signed in on the home screen.
2. Ask a question → answer **streams incrementally** into an in-progress bubble;
   the retrieval trace shows live tool lines ("Searching hadith for … — N
   results") while it searches.
3. On `done` the in-progress bubble **swaps to the persisted message with no
   flicker / no re-animation / no duplicate**.
4. Open a past thread from the sidebar → it loads with real messages + citations;
   open the source panel from a citation.
5. Log out → back to signed-out state (rail/account-chrome copy per stream 5).
6. Log back in → the thread from step 2 is still in the sidebar and opens.
7. Guest path: "Continue as guest" → signed in as guest; ask a question; the
   device reuses its one guest account on a second guest login.
8. Error paths: wrong password → inline error; kill network mid-stream →
   `SendFailure` with a working retry; partial answer stays on screen.

**Cross-platform:** web (primary) + at least one native target (iOS or Android
simulator) for the register → stream → history loop; confirm `expo/fetch`
streaming and `expo-secure-store` token persistence both work on native.
