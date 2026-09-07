# pir-124 thread — Re-wire prototypes/ansari-expo onto the new design (issue #124)

## 2026-09-07 — PLAN phase

Follow-up to #121 / PR #123. The Replit dark-mode design is now source of truth
for `prototypes/ansari-expo` but disconnected from the backend. This issue
re-wires auth + real `apps/api` SSE + the PIR #65 streaming reconciler onto it.

### Investigation findings

- **`lib/api` is a genuine drop-in.** Confirmed by inspection: `lib/api/index.ts`
  re-exports the same hook names the new pages call; `lib/api/types.ts` re-exports
  `Citation`/`Message`/`SafetySignal`/… from the *same*
  `vendor/api-client-react/generated/api.schemas.ts` file the components import
  from. Zero type reconciliation. 11 import sites; 9 are a pure specifier swap.
- **`lib/auth/context.tsx` is complete and self-wiring.** `AuthProvider`
  registers its token getter + 401 handler with both the vendored `custom-fetch`
  runtime and `lib/api/auth-bridge.ts` (streaming path). Just needs mounting
  inside `QueryClientProvider`. `login`/`register`/`loginAsGuest`/`logout`/
  single-flight `refresh` all present. `context.test.tsx` mocks store+api.
- **Auth UI was deleted in #121** — `app/login.tsx`, `app/register.tsx`,
  `components/AuthForm.tsx`, `lib/insets.ts` all gone. Rebuilding AuthForm in the
  new token language (reference: `app/about.tsx` masthead pattern).
- **Streaming**: pre-#121 `chat/[id].tsx` (git `be7788d`) shows the exact
  `onEvent` + `reconcileThread` + `traceReducer` + done-hand-off wiring pattern.
  Porting it onto the *new* screen, which added `drawn`-set animation gating —
  main integration risk: gate on `keyFor(item)` not `item.id` so the persisted
  answer doesn't re-animate when it replaces the synthetic bubble.
- **`_layout.tsx`**: `setBaseUrl(`https://${EXPO_PUBLIC_DOMAIN}`)` → issue says
  `apiBaseUrl()`, real export is `resolveBaseUrl()`. `.env.local` symlink
  already sets `EXPO_PUBLIC_API_URL=https://api-staging.askansari.ai`.
- **`AppFrame`** renders the rail/AccountChrome for every route — needs gating on
  auth routes.
- **Baseline green**: `pnpm typecheck` clean, `pnpm test` 218/218 across 12 files.

### Open question for Omar (plan-approval gate)

Sidebar/AccountChrome copy assumes "no accounts ever" (Replit's real "Ansari 4"
product copy). Does the prototype keep the accountless framing with auth as an
optional add-on, or return to account-first (pre-#121)? This decides the session
gate shape in `_layout.tsx`. **Recommending accountless-optional** (lowest risk,
matches shipped direction, `lib/auth` + `apps/api` already support it). Stream 5
(copy changes) not implemented until Omar answers.

### Also folding in (architect-suggested)

`@react-navigation/native` bump 7.3.13 → ^7.3.18 (expo-router peer warning) —
one line, we're in the nav layer.

### Status

Plan drafted → `codev/plans/124-re-wire-prototypes-ansari-expo.md`. Committing,
then `porch done` → plan-approval gate.

## 2026-09-07 — IMPLEMENT phase

Plan APPROVED (Omar). Product call: **accountless-optional** — no forced
redirect, AuthGate holds only the loading frame, "Log in" is an optional
add-on from the rail/account corner, signed-in state in the rail colophon.

Implemented in 7 commits (a9a52ba..23e79a3):

1. `a9a52ba` — 11 import sites → `@/lib/api`; `_layout` base URL
   (`resolveBaseUrl()`), ZodError/4xx no-retry policy, `<AuthProvider>`,
   `AuthGate` (loading frame only), login/register routes, `AppFrame`
   rail-gated off auth routes.
2. `f9f454f` — `components/AuthForm.tsx` + `app/login.tsx` / `register.tsx`
   in the dark-mode token language (brass mark, serif title, recessed-bed
   fields, guest + switch links).
3. `533f31e` — streaming: `useSendMessage` `onEvent` (text deltas +
   `traceReducer`), `reconcileThread` replaces the inline reconciliation,
   `landedAnswer` → done hand-off, `keyFor`, `send()` baseline guard,
   `ThinkingLine` renders the live trace.
4. `43fc29b` — Sidebar/AccountChrome: "Log in"/"Sign up" open real screens;
   signed-in name + Log out; privacy copy corrected.
5. `e18a847` — `@react-navigation/native` `^7.3.18` (clears peer warning).
6. `0bd7f50` — README "Current state" + related sections rewritten.
7. `23e79a3` — reorder hand-off effect after `drawn` decl (readability).

**Animation-gating × hand-off fix (architect's flagged risk):** `isNewContent`
now keys on `keyFor(item)` not `item.id`; the hand-off effect adds the stream
key to `drawn` synchronously before the re-render, so the persisted answer
inheriting the synthetic bubble's key never re-animates. Verify manually at
dev-approval (no flicker on `done`).

**Checks:** prototype `pnpm typecheck` clean, `pnpm test` 218/218 (no new
tests — the pure reconciler/trace/streaming/auth behavior I depend on is
already fully covered; the screen-level glue is what the dev-approval gate
has the human run. No `components/*.test.tsx` infra exists and adding a
half-mocked render test for trivial glue isn't worth it — noted for review).

**Blocker at the gate:** porch's repo-root `build` check fails on
`ansari-auth#build` (missing `unrun` module, issue #122, unrelated —
prototype is outside the workspace/turbo graph). Architect will do a
documented manual bypass (as for #121) if #122 isn't fixed by gate time.
