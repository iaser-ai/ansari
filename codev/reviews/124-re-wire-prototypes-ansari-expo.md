# PIR Review: Re-wire prototypes/ansari-expo onto the new design (auth, real API, streaming)

Fixes #124

## Summary

PR #123 (issue #121) ported the Replit dark-mode design onto
`prototypes/ansari-expo` but left it disconnected from this repo's backend. This
PR reconnects it: every screen now imports the `apps/api` adapter (`@/lib/api`)
instead of the vendored `@workspace/api-client-react`; `AuthProvider` is mounted
with real login/register screens rebuilt in the dark-mode token language; and
the chat screen drives the PIR #65 reconciler + retrieval trace so answers
stream incrementally again. Auth is **accountless-optional** (product call by
Omar): Ansari works signed-out, "Log in" is an add-on from the rail, no forced
redirect. Prototype-side only — no `apps/` or `packages/` changes.

## Files Changed

(vs merge-base `644b406`)

- `codev/plans/124-re-wire-prototypes-ansari-expo.md` (+357 / -0) — plan
- `codev/projects/124-re-wire-prototypes-ansari-expo/status.yaml` (+21) — porch
- `codev/state/pir-124_thread.md` (+95) — builder thread
- `prototypes/ansari-expo/README.md` (+? / -?) — "Current state" rewrite
- `prototypes/ansari-expo/app/_layout.tsx` (+124 / -) — base URL, retry policy,
  `AuthProvider`, `AuthGate`, login/register routes, rail gated off auth routes
- `prototypes/ansari-expo/app/chat/[id].tsx` (+166 / -) — `onEvent` streaming,
  `reconcileThread`, done hand-off, `keyFor`, `send()` baseline guard
- `prototypes/ansari-expo/app/index.tsx` (+2 / -2) — import swap
- `prototypes/ansari-expo/app/login.tsx` (+6 / -0) — new
- `prototypes/ansari-expo/app/register.tsx` (+6 / -0) — new
- `prototypes/ansari-expo/components/AuthForm.tsx` (+480 / -0) — new, the auth
  form in the dark-mode token language
- `prototypes/ansari-expo/components/Sidebar.tsx` (+155 / -) — real auth
  affordances, signed-in state, corrected privacy copy
- `prototypes/ansari-expo/components/AccountChrome.tsx` (+108 / -) — real auth
  links, signed-in state
- `prototypes/ansari-expo/components/ThinkingLine.tsx` (+56 / -) — renders the
  live retrieval trace
- `prototypes/ansari-expo/components/{AnswerMessage,AnswerProse,SafetyCard,SourceFolio,SourcePanel,SourceStack,CitationChip}.tsx`
  (+2 / -2 each) — type-only import swap
- `prototypes/ansari-expo/package.json` (+2 / -2) — `@react-navigation/native`
  → `^7.3.18`

## Commits

- `a9a52ba` [PIR #124] Repoint imports to @/lib/api; wire AuthProvider + base URL
- `f9f454f` [PIR #124] Auth screens in the dark-mode token language
- `533f31e` [PIR #124] Wire the incremental-render reconciler into the chat screen
- `43fc29b` [PIR #124] Accountless-optional auth affordances (product call: Omar)
- `e18a847` [PIR #124] Bump @react-navigation/native to ^7.3.18
- `0bd7f50` [PIR #124] README: describe the working end-to-end flow
- `23e79a3` [PIR #124] Order the done hand-off effect after the drawn-set declaration
- `85093c6` [PIR #124] Thread: implement-phase log
- `751691d` Merge remote-tracking branch 'origin/develop' into builder/pir-124

## Test Results

- Prototype `pnpm typecheck`: ✓ clean
- Prototype `pnpm test`: ✓ 218 tests pass (0 new — see below)
- Repo-root `turbo build` (porch `build` check): ✓ after `set -a; . apps/api/.env.ci; set +a`
  in the shell (the check needs the CI dummy env the same way CI does)
- Manual verification: Omar tested the running worktree against staging and
  approved the `dev-approval` gate. Two follow-ups he raised — web fonts fall
  back to a system font, and citations don't render — are **not regressions
  from this PR** (see "Things to Look At").

### No new automated tests — rationale

The behavior this PR relies on is already covered by suites it does not touch:
`lib/chat-reconcile.test.ts` (synthetic bubble, landed-answer, echo identity),
`lib/chat-trace.test.ts` (`traceReducer` / `formatTraceLine` honesty rules),
`lib/api/{streaming,chat-stream}.test.ts` (single-POST SSE, `onEvent` delivery,
401 retry), `lib/auth/*`. The remaining work is screen-level integration glue
(animation gating, the done hand-off, the session gate, the auth form) — exactly
what PIR's `dev-approval` gate has the human verify by running the worktree.
There is no `components/*.test.tsx` render-test infrastructure in the prototype
and standing it up (reanimated + `AnsariMarkPulse` + `useColors` mocks) for
trivial glue was judged not worth it.

## Architecture Updates

No arch changes. `prototypes/ansari-expo` is deliberately outside the pnpm
workspace and the Turborepo task graph; this PR changes no `apps/` or
`packages/` module boundary, config, env surface, or deploy path. The
`arch-critical.md` / `arch.md` facts (auth via `users.is_admin`, `config`-only
env reads, migration/deploy order, Turbo strict-env, Railway dashboard, Vertex
`functionResponse` matching) are untouched.

## Lessons Learned Updates

Two cold-tier bullets added to `codev/resources/lessons-learned.md`:

- Under **Incremental streaming render (issue #65)**: a receiving screen with
  its own mount-animation gate must key that gate on the *reconciled list
  identity*, not the raw message id — otherwise the persisted answer inheriting
  the synthetic bubble's key on the `done` hand-off reads as a fresh row and
  re-animates, defeating the shared-key trick. Seed the "already drawn" set with
  the stream key *synchronously* in the hand-off effect, before the re-render.
- Under **Monorepo migration & verification discipline (spec 48)**: the
  repo-root `turbo build` that porch runs as a gate check needs the CI dummy env
  (`apps/api/.env.ci`) loaded into the shell first
  (`set -a; . apps/api/.env.ci; set +a`) — `apps/api`'s Next.js build evaluates
  its config Zod schema at "collect page data" time. A prototype- or
  docs-only change that touches nothing under `apps/` still can't satisfy that
  check without the env; loading `.env.ci` is what CI does and is not a bypass.
  Do **not** "fix" the unrelated app to make the check green.

## Things to Look At During PR Review

- **Streaming hand-off, no flicker** (`app/chat/[id].tsx`) — the one genuinely
  tricky spot. The new screen has its own `drawn`-set mount-animation gate keyed
  by message id; the reconciler hands a synthetic streaming bubble's key to the
  persisted answer on `done`. The fix: `isNewContent` keys on `keyFor(item)` not
  `item.id`, and the hand-off effect does `drawn.current?.add(streamKey)`
  synchronously before the state updates that trigger re-render. Verify against
  staging: ask a question → in-progress bubble renders deltas + trace lines →
  on `done` it swaps to the persisted message with no re-animation / no
  duplicate / no gap.
- **`AuthGate` is loading-frame-only** (`app/_layout.tsx`) — no forced redirect,
  by product decision. Signed-out users use the app normally; `apps/api` serves
  guest/anon threads. If the product later wants account-first, this is where
  the redirect goes back.
- **`AuthProvider` placement** — inside `QueryClientProvider` (it calls
  `useQueryClient`; a principal change clears the cache) and above
  `GestureHandlerRootView`.
- **`AuthForm` token fidelity** — built from `about.tsx`'s patterns + the
  recessed-bed field style from `SearchField`; not restored byte-for-byte from
  pre-#121. Worth a design eye on web + one native target.
- **Not regressions from this PR, for the reviewer's awareness:**
  - *Web fonts* fall back to a system font — #121 dropped `public/` (fonts +
    `@font-face` shell) as "Replit hosting layer," but `public/index.html` +
    `public/fonts/` is standard Expo web. Diagnosed here, filed as a fast-follow
    issue (688 KB of woff2 + one HTML file, no code change). Native fonts are
    fine.
  - *Citations don't render* — the citation **UI** is fully present and wired
    (`SourcePanel` etc., connected here via `onSourcesOpen`). The **data** is a
    backend gap: `apps/api` discards retrieved source documents (**issue #66**);
    `lib/api/mappers.ts` maps `citations` to `[]` except a khushū'-thread demo
    hack. Out of scope for #124 ("prototype-side wiring only").

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder pir-124 → **Review Diff**
- **Run dev**: VSCode sidebar → **Run Dev**, or `afx dev pir-124`
  (`.env.local` already points at staging)
- **What to verify** (maps to the plan's Test Plan):
  - Register (new email) → land signed in on the home screen
  - Ask a question → answer streams incrementally into an in-progress bubble;
    retrieval trace lines show while it searches; on `done` it swaps to the
    persisted message with no flicker
  - Open a past thread from the sidebar → loads with real messages
  - Log out (rail colophon / desktop account corner) → back to signed-out
  - Log back in → the thread from earlier is still there
  - Guest: "Continue as guest" → signed in; a second guest login reuses the
    device's one guest account
  - Errors: wrong password → inline message; kill network mid-stream →
    `SendFailure` with a working retry, partial answer stays on screen
  - Cross-platform: web (primary) + one native target for register → stream →
    history

## Flaky Tests

None.
