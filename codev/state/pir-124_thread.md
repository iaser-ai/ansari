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
