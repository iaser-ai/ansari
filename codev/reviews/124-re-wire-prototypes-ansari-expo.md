# PIR Review: Re-wire prototypes/ansari-expo onto the new design (auth, real API, streaming)

Fixes #124

## Summary

PR #123 (issue #121) ported the Replit dark-mode design onto
`prototypes/ansari-expo` but left it disconnected from this repo's backend. This
PR reconnects it: every screen imports the `apps/api` adapter (`@/lib/api`)
instead of the vendored `@workspace/api-client-react`; `AuthProvider` is mounted
with real login/register screens rebuilt in the dark-mode token language; and
the chat screen drives the PIR #65 reconciler + retrieval trace so answers
stream incrementally again. Auth is **accountless-optional** (product call by
Omar): the reader never sees an auth screen — `AuthProvider` silently
provisions a guest account on first launch (`apps/api` has no true-anonymous
thread path), and "Log in" is an optional upgrade from the rail. Prototype-side
only — no `apps/` or `packages/` changes.

## Files Changed

(vs merge-base `644b406`; excludes `codev/` bookkeeping)

- `prototypes/ansari-expo/app/_layout.tsx` (+124 / -) — base URL
  `resolveBaseUrl()`, ZodError/4xx retry gate, `<AuthProvider>`, `AuthGate`
  (loading-frame-only), login/register routes, rail gated off auth routes
- `prototypes/ansari-expo/app/chat/[id].tsx` (+172 / -) — `onEvent` streaming,
  `reconcileThread`, done hand-off + `keyFor`, `send()` baseline guard,
  composer disabled until data loads
- `prototypes/ansari-expo/lib/auth/context.tsx` (+80 / -) — auto-guest on
  startup + post-logout; `isGuest` on the context; `login`/`register` take a
  `{ guest }` opt
- `prototypes/ansari-expo/lib/auth/store.ts` (+23 / -) — `StoredSession.isGuest`
  persisted in the name blob
- `prototypes/ansari-expo/lib/auth/context.test.tsx` (+63 / -) — 4 tests
  (auto-guest on fresh launch, real-session restore skips it, + the two
  cache-clear regressions updated for the post-logout→guest transition)
- `prototypes/ansari-expo/components/AuthForm.tsx` (+480, new) — the auth form
  in the dark-mode token language
- `prototypes/ansari-expo/components/Sidebar.tsx` (+163 / -) — real auth
  affordances; guest shows the sign-in upsell not "Log out"; logout navigates
  home; corrected privacy copy
- `prototypes/ansari-expo/components/AccountChrome.tsx` (+115 / -) — same, for
  the desktop account corner
- `prototypes/ansari-expo/components/ThinkingLine.tsx` (+56 / -) — renders the
  live retrieval trace
- `prototypes/ansari-expo/app/{login,register}.tsx` (+6 each, new)
- `prototypes/ansari-expo/app/index.tsx` +
  `components/{AnswerMessage,AnswerProse,SafetyCard,SourceFolio,SourcePanel,SourceStack,CitationChip}.tsx`
  (+2 / -2 each) — `@workspace/api-client-react` → `@/lib/api` import swap
- `prototypes/ansari-expo/.env.local.example` (+/-22) — rewritten to match reality
- `prototypes/ansari-expo/README.md` (+147 / -) — "Current state" + auth sections
- `prototypes/ansari-expo/package.json` (+2 / -2) — `@react-navigation/native`
  → `^7.3.18`
- `prototypes/ansari-expo/lib/auth/store.test.ts` (+1) — `isGuest` in a fixture
- `codev/resources/lessons-learned.md` (+3 bullets) — see below

## Commits

- `a9a52ba` Repoint imports to @/lib/api; wire AuthProvider + base URL
- `f9f454f` Auth screens in the dark-mode token language
- `533f31e` Wire the incremental-render reconciler into the chat screen
- `43fc29b` Accountless-optional auth affordances (product call: Omar)
- `e18a847` Bump @react-navigation/native to ^7.3.18
- `0bd7f50` README: describe the working end-to-end flow
- `23e79a3` Order the done hand-off effect after the drawn-set declaration
- `85093c6` Thread: implement-phase log
- `751691d` Merge origin/develop
- `b07b071` Review + retrospective
- `cf47a79` Consultation fixes: composer data-gate, stale env example, logout nav
- `1206346` Consultation round 1: rebuttals + review-file update
- `f00be7d` Auto-guest bootstrap (consult C1; product call: Omar, option A)

## Test Results

- Prototype `pnpm typecheck`: ✓ clean
- Prototype `pnpm test`: ✓ 220 tests pass (2 new in `context.test.tsx` for the
  auto-guest bootstrap; the 3 existing `lib/api` / `chat-reconcile` /
  `chat-trace` suites this PR depends on are untouched and still green)
- Repo-root `turbo build` (porch `build` check): ✓ after
  `set -a; . apps/api/.env.ci; set +a` (the check needs the CI dummy env, same
  as CI)
- Manual verification: Omar tested the running worktree against staging and
  approved `dev-approval`. Two follow-ups he raised (web fonts fall back to a
  system font; citations don't render) are **not regressions** — see below,
  now filed as #129 and tracked under #66.
- 3-way consultation (iteration 1): codex + claude REQUEST_CHANGES (Gemini lane
  skipped — `agy` not installed). Findings addressed — see "Things to Look At".

## Architecture Updates

No arch changes. `prototypes/ansari-expo` is deliberately outside the pnpm
workspace and the Turborepo task graph; this PR changes no `apps/` or
`packages/` module boundary, config, env surface, or deploy path. The
`arch-critical.md` / `arch.md` facts are untouched.

## Lessons Learned Updates

Three cold-tier bullets in `codev/resources/lessons-learned.md`:

- Under **Incremental streaming render (#65)**: a receiving screen with its own
  mount-animation gate must key it on the reconciled list identity, not the raw
  message id — otherwise the persisted answer inheriting the synthetic bubble's
  key on the `done` hand-off re-animates. Seed the "drawn" set with the stream
  key synchronously in the hand-off effect.
- Under **Monorepo migration & verification discipline (#48)**: a product/design
  decision that assumes a backend capability must be checked against the backend
  — the "accountless-optional" call was approved on the premise that `apps/api`
  serves anonymous threads; it doesn't (hard 401 without a token), and the gate
  was still built exactly to spec. The 3-way consult caught it.
- Also under **#48**: the repo-root `turbo build` porch gate-check needs
  `apps/api/.env.ci` loaded into the shell (`set -a; . apps/api/.env.ci; set +a`)
  even for a change touching nothing under `apps/` — `apps/api`'s Next.js build
  evaluates its config Zod schema at "collect page data" time. Loading `.env.ci`
  is what CI does; it is not a bypass.

## Things to Look At During PR Review

- **Auto-guest bootstrap** (`lib/auth/context.tsx`) — the answer to the
  consultation's blocking finding (both reviewers, HIGH: signed-out users 401
  on every thread call; `apps/api` has no anonymous path; the accountless
  approval's premise was wrong). Omar chose **Option A**: silently provision a
  guest. Review points:
  - Startup: `loadSession()` → nothing stored → `loginAsGuest()` inline,
    **staying `loading`** so no screen mounts and 401s in the gap. Offline →
    `applySession(null)` → the app is signed-out and shows its own load errors.
  - Post-logout: a `status === 'signedOut'` effect (guarded by a
    `reguesting` ref, one attempt per transition) re-provisions the guest.
    `logout()` from a real account → `clearSession()` keeps the guest
    credentials → re-guest logs back into the *same* device guest, threads
    intact.
  - `StoredSession.isGuest` rides in the existing name blob (absent → `false`).
    `login`/`register` take `{ guest }`; only `loginAsGuest` passes it.
  - "Log out" is **hidden for a guest** — a guest logging out just re-guests, so
    the rail / account corner show the sign-in upsell instead (my call, per the
    architect's "hide it, or keep it as a no-op-ish re-guest").
  - Operational: every fresh browser/device mints one persistent staging
    account (credentials cached and reused). Accepted for a throwaway prototype.
- **Streaming hand-off, no flicker** (`app/chat/[id].tsx`) — the other tricky
  spot. The new screen's `drawn`-set mount-animation gate is keyed by message
  id; the reconciler hands a synthetic streaming bubble's key to the persisted
  answer on `done`. Fix: `isNewContent(keyFor(item))`, and
  `drawn.current?.add(streamKey)` synchronously in the hand-off effect before
  the re-render. Verify against staging: ask → in-progress bubble renders deltas
  + trace lines → on `done` it swaps to the persisted message with no
  re-animation / duplicate / gap.
- **Composer disabled until data loads** (`chat/[id].tsx:780`, was consult
  finding) — `disabled={conversationQuery.isError || !conversationQuery.data}`.
  `ChatInput` is non-editable and non-sending while disabled, so a follow-up
  typed while an existing thread loads can no longer be silently lost.
- **`AuthForm` token fidelity** — built from `about.tsx` patterns + the
  recessed-bed field style from `SearchField`. Worth a design eye on web + one
  native target.
- **Not regressions from this PR (now filed):**
  - #129 — web fonts fall back to a system font; #121 dropped `public/` (fonts +
    `@font-face` shell) treating it as Replit-specific when it's standard Expo
    web. Fix is ~700 KB of woff2 + one HTML file, no code change.
  - #128 — a thread-typed follow-up isn't echoed until the post-`done` refetch,
    so the streamed answer briefly leads its own question. Pre-existing from
    #121, conspicuous now that streaming is back. Fix = generalise `ECHO_ID` in
    the reconciler; out of #124's "wiring, not behavior change" scope.
  - Citations don't render — the UI is fully wired (`SourcePanel` etc., via
    `onSourcesOpen`); the data is a backend gap (`apps/api` discards retrieved
    documents — **#66**). `lib/api/mappers.ts` maps `citations` to `[]` except a
    khushū'-thread demo hack.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder pir-124 → **Review Diff**
- **Run dev**: VSCode sidebar → **Run Dev**, or `afx dev pir-124`
  (`.env.local` already points at staging)
- **What to verify** (maps to the plan's Test Plan + the consult findings):
  - Open a fresh browser → the app is usable immediately, **no auth screen**
    (auto-guest). Ask a question → the answer streams into an in-progress
    bubble; retrieval-trace lines show while it searches; on `done` it swaps to
    the persisted message with no flicker.
  - Open a past thread from the sidebar → loads with real messages.
  - "Log in" (rail / desktop corner) → register a real account → the guest's
    threads are replaced by the new account's (principal transition clears the
    cache); the corner now shows the name + "Log out".
  - Log out → drops back to the device guest (no auth screen); the guest's
    earlier threads are back. Log back in → the account's thread is there.
  - Composer: open a thread on a throttled connection and type immediately — the
    field is disabled until the thread loads (no lost message).
  - Errors: wrong password → inline message; kill the network mid-stream →
    `SendFailure` with a working retry, partial answer stays on screen.
  - Cross-platform: web (primary) + one native target for the ask → stream →
    history loop (also exercises `expo/fetch` streaming + `expo-secure-store`).

## Flaky Tests

None.
