# PIR Review: Refresh prototypes/ansari-expo from the Replit design package

Fixes #121

## Summary

Ports `prototypes/ansari-expo`'s UI to the Replit-sourced design package
(`~/Downloads/Ansari/artifacts/ansari/`, upstream sha `6c58e51`, "Rebuild
icons from Figma artwork"): dark mode, a collapsible sidebar, a source
panel, a new motion/layout/radius token system, redrawn icons, and
near-total rewrites of every page and most components. Per the architect's
decision, the port takes the Replit design as source of truth for
layouts/assets/pages/components while leaving the real-backend wiring
(`lib/api/`, `lib/auth/`, `lib/chat-reconcile.ts`, `lib/chat-trace.ts`)
untouched but **disconnected** — nothing in the new pages imports them. The
re-wire is tracked as a separate follow-up, **issue #124**.

Also adds a `@workspace/api-client-react` → `vendor/api-client-react` bridge
(tsconfig path alias + Metro `resolver.extraNodeModules`) so the new pages'
bare-specifier imports resolve without pulling the prototype into the pnpm
workspace, and ports the 3 Replit `lib/*.test.ts` files from `node --test`
to vitest (kept as the prototype's test runner, matching the repo standard).

## Files Changed

100 files changed (+15829 / -3692) across `prototypes/ansari-expo/`
(104 files / +16442 / -3692 for the whole PR, including `codev/`):

- `app/` — replaced `_layout.tsx`, `index.tsx`, `chat/[id].tsx`,
  `+not-found.tsx`; added `about.tsx`; deleted `login.tsx`, `register.tsx`.
- `components/` — 22 new (`Sidebar`, `SidebarDrawer`, `SourcePanel`,
  `SourceFolio`, `SourceStack`, `MessageActionSheet`, `ThinkingLine`,
  `ToastStack`, the three `AnsariMark*`, `BrassSendButton`, `EdgeSwipe`,
  `Placeholder`, `PressableScale`, `Sheet`, `SearchField`,
  `KeyboardAvoidingViewCompat`, `AccountChrome`, `AnswerProse`,
  `AskedQuestion`, `SwipeToReveal`), 11 replaced, 5 deleted (`AuthForm`,
  `HistorySheet`, `CitationSheet`, `WebNavButton`, `AnswerMessage.test.tsx`).
  `ErrorBoundary.tsx` byte-identical, untouched.
- `constants/` — 5 new (`motion`, `radius`, `layout`, `featured`,
  `ansariMark`), `colors.ts` replaced (dark mode, stone/night ramps).
- `hooks/` — 9 new, `useColors.ts`/`useScheme.ts` replaced, `useDesktop.ts`
  byte-identical, untouched.
- `lib/` — 12 new design helpers, `color.ts`/`markdown.ts`/`notice.ts`/
  `web.ts` replaced (`color.ts` turned out byte-identical), `insets.ts` and
  `time.ts` (+ its test) deleted as dead code. `lib/api/`, `lib/auth/`,
  `lib/chat-reconcile.ts`, `lib/chat-trace.ts`, `lib/sample-citations.ts`,
  `lib/suggested-topics.ts` untouched.
- `assets/` — redrawn icon, new adaptive/splash icon set, `icon-source/`,
  updated ambient-shadow `.mp4`/`.webm` files (poster JPGs turned out
  byte-identical to source, not actually changed).
- `app.json`, `tsconfig.json`, `metro.config.js`, `package.json` — merged
  splash/adaptive-icon config, `@workspace/api-client-react` path alias +
  Metro resolver entry, `@react-navigation/native`, `expo-navigation-bar`,
  `expo-clipboard` added, `@expo-google-fonts/spectral` removed.
- `README.md` — rewritten to describe the current (design-only,
  not-wired) state and name issue #124. `PERFORMANCE.md` — flagged stale
  with a note (its claims predate the palm-shadow/React-Compiler changes
  this port reintroduces); not rewritten (out of scope).
- `codev/plans/121-…`, `codev/state/pir-121_thread.md`, this review —
  protocol artifacts.

## Commits

- `ca06c1b` [PIR #121] Plan draft
- `218ddb5` [PIR #121] Port Replit design (app/components/constants/hooks/lib/assets)
- `7497c73` [PIR #121] Add builder thread log
- `a620338` [PIR #121] Reference #124 explicitly in README

## Test Results

- `pnpm typecheck` (in `prototypes/ansari-expo`): ✓ pass
- `pnpm test` (vitest): ✓ pass — 12 files, 218 tests, including the 3
  newly-ported files (`ambientNight.test.ts` 36, `keyboard.test.ts` 6,
  `markdown.test.ts` 94) and the untouched `lib/api/`, `lib/auth/`,
  `lib/chat-reconcile.test.ts`, `lib/chat-trace.test.ts` suites (unaffected
  by this port, still green)
- `expo export --platform web`: ✓ bundles clean, 1538 modules, no errors
- `expo start --web`: ✓ boots; page serves (HTTP 200, correct title, bundle
  loads with no server-side errors). No real browser screenshot taken — the
  claude-in-chrome extension wasn't connected in the builder's session; the
  architect independently ran the prototype for dev-approval.
- Repo-root `porch` `build` check (`turbo run build`): ✗ fails locally on
  `apps/auth` — see "Environment limitation" below. PR #123's own CI run is
  green on `auth`/`frontend`/`gitleaks`.

## Environment limitation: local `build` check vs. issue #122

Porch's `implement`/`dev-approval` `build` check runs `npm run build` →
`turbo run build` across the **whole** monorepo, which fails locally on
`apps/auth`: `tsdown` errors `Failed to import module "unrun". Please
ensure it is installed` — `unrun` is an *optional* peer dependency of
`tsdown` (confirmed in `pnpm-lock.yaml`) that a plain
`pnpm install --frozen-lockfile` doesn't pull in.

Confirmed unrelated to this branch before escalating: this branch's
merge-base with `origin/develop` **is** `origin/develop`'s current tip
(`10c298b`); `apps/auth/package.json` has been untouched since the app was
created in PIR #59 (`21173e1`); this branch never touches `apps/auth`, root
`package.json`, or `pnpm-lock.yaml`; and `prototypes/ansari-expo` is
deliberately outside the Turborepo graph, so nothing in this diff can
affect `turbo build` for any package. The architect independently
reproduced the failure on a clean `develop` checkout and confirmed CI's
`auth` job is green on `develop`'s tip and every recent run — a
**local/macOS-only tsdown/unrun toolchain gap**, filed as **issue #122**.

Because this check hard-blocks both `porch done` (implement) and
`porch approve ... dev-approval` with no scoping/skip flag available, and
fixing `apps/auth` was explicitly out of scope, the architect hand-approved
`dev-approval` in `status.yaml` with a documented note (Omar approved; #122
is environment-only, CI green, unrelated to this branch) after independently
reviewing the diff and running the prototype. `porch done` was then run to
advance to the `review` phase, skipping the checks per porch's own
just-approved-gate short-circuit.

## Architecture Updates

No changes needed. This PIR is a UI-only design port confined to
`prototypes/ansari-expo/`, a standalone project deliberately outside the
pnpm workspace and Turborepo graph — it doesn't touch auth, the database,
the Gemini facilitator, or monorepo build/deploy config, so none of the
"consult before deciding" facts in `codev/resources/arch-critical.md` (or
the cold `arch.md` sections they map to) changed.

## Lessons Learned Updates

- **COLD** `codev/resources/lessons-learned.md`: recommend a new section
  under "Monorepo migration & verification discipline" (or a new
  standalone one) covering:
  - A bulk multi-file `cp`/`mv` shell loop that silently touches zero files
    (a quoting bug collapsed a quoted multi-word variable into one argument,
    `cp` errored, the loop's own "done" echo still printed) is caught by
    `pnpm typecheck` failing on stale imports, not by the loop's own exit
    code. After any such loop, verify file *contents* changed (e.g. `diff`
    against source), not just that the command exited 0.
  - A dependency diff done by eyeballing two `package.json` files missed
    `expo-clipboard` (caught by `pnpm typecheck`'s `Cannot find module`).
    Re-diffing the full dependency **sets** programmatically after the fact
    found no further gaps. Do the programmatic diff first, not as cleanup.
  - Porting a `node --test` suite (raw `.ts` imports, Node's type-stripping,
    no actual type-checking) to a typechecked vitest run can surface latent
    type errors in the **test code itself**, not just application code — one
    ported test here (`ambientNight.test.ts`) relied on `expect().toBe()`
    narrowing a discriminated union the way `node:assert`'s control flow
    never got tsc-checked well enough to catch either; fixed with an
    explicit `if (t.kind !== 'night') return;` guard after the assertion.
- **HOT** `codev/resources/lessons-critical.md`: no new always-on fact —
  the above are useful but narrow (specific to bulk-porting work), not
  "consult before deciding" material for every session.
- **Issue #122** (local-only `tsdown`/`unrun` build-check gap) and the
  resulting manual `dev-approval` bypass are documented above and in
  `codev/state/pir-121_thread.md`, not duplicated into `lessons-learned.md`
  — it's an environment/tooling ticket (#122) with its own lifecycle, not a
  recurring pattern to codify as a lesson yet. If it recurs for other
  builders, that's the signal to promote it.
- **Issue #124** (re-wire auth + `lib/api` SSE client + the PIR #65
  streaming reconciler onto the new design) is the tracked follow-up for
  everything this port deliberately left disconnected — see the prototype
  README's "Current state" section for the up-to-date list of what's
  affected.

## Things to Look At During PR Review

- The `@workspace/api-client-react` → `vendor/api-client-react` bridge
  (`tsconfig.json` `paths` + `metro.config.js` `resolver.extraNodeModules`)
  — the vendored client's existing exports already covered every import
  site the new design needs (checked directly against
  `vendor/api-client-react/generated/api.ts`/`api.schemas.ts`), so no
  stubbing was required. Worth a second look if a future design update adds
  an import site the vendored client doesn't cover.
- `app.json`'s `expo-router` plugin `origin` option (Replit's
  `https://replit.com/`) was deliberately dropped as a Replit-hosting
  artifact — flagged in the plan as worth a second look if `expo start`
  ever misbehaves in a way that looks routing-related.
- The known, documented (not fixed) gaps: web fonts fall back to a system
  font (Replit's `public/index.html` `@font-face` preloads weren't ported,
  by design — `public/` is explicitly excluded), and
  `useCreateConversation`/`useListSuggestedQuestions` network calls fail
  (no real base URL configured) — both called out in the README rather than
  silently left for someone to discover.

### 3-way consultation findings (all COMMENT/APPROVE, none blocking)

- **Gemini lane skipped** (`agy` CLI not installed in this environment) —
  environment limitation, not a finding about the change itself.
- **Codex (COMMENT) + Claude (APPROVE)** independently re-ran
  `pnpm typecheck`/`pnpm test`/`expo export` and confirmed port fidelity via
  their own `diff` against the Replit source. Two factual corrections they
  caught in this review file's first draft, now fixed: the file-count/diff
  stat above (was scoped incorrectly), and the "updated poster" claim (the
  poster JPGs are byte-identical to source — not actually changed).
- **Plan-wording nit (implementation is correct, plan text overstated it):**
  the plan's app.json bullet says "root + ios/android/web
  `backgroundColor: #E7E5E4`," but Replit's own `app.json` only sets
  `backgroundColor` at root/`android`/`web` — there's no `ios.backgroundColor`
  key in the source, so none was added here. The shipped `app.json` matches
  Replit's exactly; only the plan's shorthand was imprecise.
- **Non-blocking suggestions deferred to #124** (both reviewers, consistent
  with the plan's own "don't build out real wiring" instruction): a
  one-line `?? process.env.EXPO_PUBLIC_API_URL` fallback in `_layout.tsx`'s
  `setBaseUrl` call would make the new design testable against staging
  today, at the cost of breaking byte-identity with the Replit source —
  deliberately not done here so the port stays a clean diff against
  upstream; `assets/icon-source/`'s ~2.7 MB of Figma PNGs are design inputs
  rather than runtime assets (plan-listed; whether they belong in git long
  term is a repo-hygiene call for #124, not this PR).

## How to Test Locally

```bash
cd prototypes/ansari-expo
pnpm install --ignore-workspace
pnpm start   # expo start --web, or scan the QR for native
```

Or from the repo root: `pnpm prototype`. See the prototype README's "Quick
start" section for what to expect on screen (and what's expected to error,
per the disconnected-backend state above).
