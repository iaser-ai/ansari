# PIR Plan: Refresh prototypes/ansari-expo from the Replit design package

## Understanding

`prototypes/ansari-expo` and the Replit build at
`~/Downloads/Ansari/artifacts/ansari/` (upstream sha `6c58e51`, confirmed via
`git log -1` inside `~/Downloads/Ansari`) have diverged in two different
directions from a common ancestor:

- **Replit** rebuilt the entire UI: dark mode, collapsible sidebar, source
  panel, a motion/layout/radius token system, redrawn icons, and near-total
  rewrites of every page and most components.
- **Local** wired the prototype to the real backend: `app/login.tsx` /
  `register.tsx` + `lib/auth/`, the SSE client in `lib/api/`, and the PIR #65
  streaming reconciler (`lib/chat-reconcile`, `lib/chat-trace`).

Per the architect's decision (recorded in the issue and reaffirmed in the
kickoff message), this PIR takes the Replit design as source of truth for
**layouts, assets, pages, and components**, and leaves the real-backend wiring
(`lib/api/`, `lib/auth/`, `lib/chat-reconcile`, `lib/chat-trace`) in the tree
untouched but **disconnected** — nothing in the new pages imports them. A
follow-up issue re-wires auth + SSE onto the new design. This plan is a large,
mostly mechanical file port with a handful of judgment calls, listed below.

### Investigation findings that shape the port

- **`lib/config.ts`** (Replit) is imported only by `server/serve.js` and
  `scripts/dev.js` — both explicitly out of scope ("Don't bring"). It has zero
  consumers in `app/`, `components/`, or `hooks/`. **Not porting it** — it
  would be dead code with no importer.
- **`lib/insets.ts`** and **`lib/time.ts`** (local, current) are each used only
  by files this port removes or replaces: `screenInsets` by
  `app/index.tsx`, `app/chat/[id].tsx` (both fully replaced by Replit
  versions, which use `useSafeAreaInsets()` directly — grepped, confirmed no
  `screenInsets`/`lib/insets` reference anywhere in the Replit tree) and
  `components/AuthForm.tsx` (removed); `timeAgo` by
  `components/HistorySheet.tsx` (removed, and grepped — no `timeAgo`
  equivalent anywhere in the Replit tree). Both become dead code once their
  only callers are gone. **Deleting `lib/insets.ts` and `lib/time.ts` +
  `lib/time.test.ts`.**
- **`lib/sample-citations.ts`** and **`lib/suggested-topics.ts`** (local) are
  consumed by `lib/api/mappers.ts` and `lib/api/hooks.ts` respectively — both
  files stay (out-of-scope re-wire code, untouched). **Keeping both**, even
  though the issue's file list doesn't call them out, because deleting them
  would break `lib/api/`'s existing typecheck/tests.
- **`components/ErrorBoundary.tsx`** is byte-identical between local and
  Replit (`diff` confirms). Not in the issue's new/updated list. **No change.**
- **The `@workspace/api-client-react` bridge already has everything the new
  design needs.** Grepped all ~11 import sites in the Replit tree
  (`app/_layout.tsx`, `app/index.tsx`, `app/chat/[id].tsx`,
  `components/{AnswerMessage,AnswerProse,SourceFolio,SourcePanel,SourceStack,
  SafetyCard,CitationChip,Sidebar}.tsx`) against
  `vendor/api-client-react/generated/api.ts` and `api.schemas.ts`: every
  function (`setBaseUrl`, `useCreateConversation`, `useListConversations`,
  `useListSuggestedQuestions`, `useSendMessage`, `useGetConversation`,
  `getListConversationsQueryKey`, `getGetConversationQueryKey`,
  `getListSuggestedQuestionsQueryKey`) and every type (`Citation`, `Message`,
  `SafetySignal`) is already exported. **No stubbing needed** — just the path
  alias.
- **`app/_layout.tsx` calls `setBaseUrl(`https://${process.env.EXPO_PUBLIC_DOMAIN}`)`**,
  a Replit-workspace-specific env var we don't set. This resolves to a bogus
  base URL, so the `useCreateConversation` / `useListSuggestedQuestions` calls
  the new `index.tsx` makes will fail over the network at runtime (visible as
  an error/empty state, not a crash — react-query handles it). This is
  expected and matches the issue's framing ("will not run end-to-end against
  staging until [the re-wire] lands"); documenting it in the README rather
  than fixing it, since fixing it means wiring `lib/api/` in, which is the
  follow-up issue's job.
- **Web font loading regresses.** Replit's `useAppFonts.web.ts` returns `true`
  unconditionally because `public/index.html` (excluded — "Don't bring:
  ...public/") declares `@font-face` + preloads for all thirteen font files.
  Without it, `useFonts()` never runs on web and the browser falls back to a
  system font for Amiri/Inter/Literata. Porting the two hook files as the
  issue specifies (native still loads real fonts via `useFonts`); documenting
  the web font gap as a known limitation rather than inventing a font-loading
  strategy outside this issue's scope.
- **Metro path alias needs an explicit resolver entry.** The existing
  `@/*` → `./*` alias already works today with nothing beyond a `tsconfig.json`
  `paths` entry (Expo's Metro config picks it up), but `@workspace/api-client-react`
  looks like a real scoped package name, which Metro will otherwise try to
  resolve through node_modules resolution first. Per the issue, adding both a
  `tsconfig.json` path AND a Metro `resolver.extraNodeModules` entry pointing
  at `vendor/api-client-react`.
- **Test runner: keeping vitest.** The repo standard is vitest (issue's own
  stated preference), the prototype's `vitest.config.ts` already aliases
  `react-native` → `react-native-web` and scopes `include` to
  `lib/**/*.test.{ts,tsx}` / `components/**/*.test.{ts,tsx}`, and there are
  only 3 Replit `lib/*.test.ts` files to port (`ambientNight.test.ts`,
  `keyboard.test.ts`, `markdown.test.ts`) — all pure-function tests with no
  DOM/RN dependency, no reason to introduce a second test runner for the
  prototype. Porting: convert `import assert from 'node:assert/strict'` +
  `import { describe, it } from 'node:test'` to
  `import { describe, expect, it } from 'vitest'`, convert `assert.equal(a, b)`
  → `expect(a).toBe(b)` to match the local convention (see
  `lib/markdown.test.ts` today), and drop the `.ts` extension from the
  module-under-test import (Replit's `allowImportingTsExtensions` support is a
  `node --test` requirement we don't need). `lib/markdown.test.ts` gets fully
  replaced by the Replit version (811 lines vs. local's 202 — `lib/markdown.ts`
  itself is rewritten, so the old tests no longer apply).

## Proposed Change

Port `~/Downloads/Ansari/artifacts/ansari/` into `prototypes/ansari-expo/`
directory-by-directory, replacing/adding what Replit changed, deleting what's
tied to the old wiring, and leaving `lib/api/`, `lib/auth/`,
`lib/chat-reconcile.ts`, `lib/chat-trace.ts` (+ their tests) untouched and
disconnected. Add the `@workspace/api-client-react` bridge (tsconfig + Metro).
Rewrite `package.json` deps, `app.json`, and `README.md` to reflect the new
state. Port the 3 Replit `lib/*.test.ts` files to vitest syntax.

## Files to Change

### `app/`
- `app/_layout.tsx` — replace with Replit version (root layout: fonts, theme,
  sidebar/account chrome, toast stack, message action sheet, web manners).
- `app/index.tsx` — replace with Replit version (~1180 lines, home screen).
- `app/chat/[id].tsx` — replace with Replit version (~906 lines, chat screen).
- `app/+not-found.tsx` — replace with Replit version.
- `app/about.tsx` — new file, copy from Replit.
- `app/login.tsx`, `app/register.tsx` — **delete** (out of scope; return in the
  re-wire follow-up).

### `components/`
New (copy from Replit): `Sidebar.tsx`, `SidebarDrawer.tsx`, `SourcePanel.tsx`,
`SourceFolio.tsx`, `SourceStack.tsx`, `MessageActionSheet.tsx`,
`ThinkingLine.tsx`, `ToastStack.tsx`, `AnsariMarkBrass.tsx`,
`AnsariMarkPulse.tsx`, `AnsariMarkSpin.tsx`, `BrassSendButton.tsx`,
`EdgeSwipe.tsx`, `Placeholder.tsx`, `PressableScale.tsx`, `Sheet.tsx`,
`SearchField.tsx`, `KeyboardAvoidingViewCompat.tsx`, `AccountChrome.tsx`,
`AnswerProse.tsx`, `AskedQuestion.tsx`, `SwipeToReveal.tsx`.

Updated (overwrite with Replit version): `AmbientVideo.tsx`,
`AnsariWordmark.tsx`, `AnswerMessage.tsx`, `ChatInput.tsx`, `CitationChip.tsx`,
`ErrorFallback.tsx`, `GlassCircleButton.tsx`, `HeaderBar.tsx`,
`KeyboardAwareScrollViewCompat.tsx`, `PaperBackground.tsx`, `SafetyCard.tsx`.

Unchanged: `ErrorBoundary.tsx` (byte-identical — verified via `diff`).

Deleted: `AuthForm.tsx`, `HistorySheet.tsx`, `CitationSheet.tsx`,
`WebNavButton.tsx`, `AnswerMessage.test.tsx`.

### `constants/`
New: `motion.ts`, `radius.ts`, `layout.ts`, `featured.ts`, `ansariMark.ts`.
Updated: `colors.ts` (dark mode, stone/night ramps, emerald → ink).

### `hooks/`
New: `useAppFonts.ts`, `useAppFonts.web.ts`, `useKeyboard.ts`,
`useKeyboard.web.ts`, `useSidebarCollapsed.ts`, `useSidebarDrawer.ts`,
`useSourcePanel.ts`, `useScreenLandmark.ts`, `useOverlayFocus.ts`.
Updated: `useColors.ts`, `useScheme.ts`.
Unchanged: `useDesktop.ts` (byte-identical — verified via `diff`).

### `lib/`
New (design helpers, copy from Replit): `ambientNight.ts`, `hijri.ts`,
`haptics.ts`, `toast.ts`, `semantics.ts`, `messageActions.ts`, `announce.ts`,
`askExit.ts`, `clipboard.ts`, `link.ts`, `keyboard.ts`.
Updated: `color.ts`, `markdown.ts`, `notice.ts`, `web.ts`.
Deleted: `insets.ts`, `time.ts`, `time.test.ts` (dead after the app/component
port — see Understanding).
Not ported: `config.ts` (dead — only consumed by excluded `server/`/`scripts/`).
Unchanged/kept for the follow-up (do not touch): `api/` (all files),
`auth/` (all files), `chat-reconcile.ts` (+ test), `chat-trace.ts` (+ test),
`sample-citations.ts`, `suggested-topics.ts`.

Test ports (node:test → vitest, see Understanding for the exact conversion):
- `lib/ambientNight.test.ts` — new
- `lib/keyboard.test.ts` — new
- `lib/markdown.test.ts` — replace local version wholesale

### `assets/`
- `assets/images/icon.png` — replace (redrawn).
- `assets/images/adaptive-icon.png`, `adaptive-icon-background.png`,
  `splash-icon.png`, `splash-icon-dark.png` — new.
- `assets/icon-source/figma-bronze-mark.png`, `figma-paper-frond.png` — new dir.
- `assets/video/ambient-shadow-desktop.mp4` — new (local currently has only
  the `.webm` + poster for desktop; add the missing `.mp4`).
- `assets/video/ambient-shadow.mp4`, `.webm`, `ambient-shadow-poster.jpg`,
  `ambient-shadow-desktop.webm`, `ambient-shadow-desktop-poster.jpg` — replace
  with Replit's updated versions.
- `assets/images/grain.png` — leave as-is (verify byte-identical during
  implementation; only replace if it actually differs).

### Root config files
- `app.json` — merge in: `splash.dark` variant
  (`splash-icon-dark.png` / `#13100E`), root + `ios`/`android`/`web`
  `backgroundColor: #E7E5E4`, `android.adaptiveIcon`, iOS
  `infoPlist.CADisableMinimumFrameDurationOnPhone: true`. Keep local-specific
  `web.favicon` (Replit's `app.json` doesn't set one; local's is intentional)
  and drop Replit's `expo-router` plugin `origin` option (a Replit-hosting
  artifact, not applicable here — confirm during implementation that dropping
  it doesn't regress anything Expo Router needs).
- `tsconfig.json` — add
  `"@workspace/api-client-react": ["./vendor/api-client-react/index.ts"]` to
  `compilerOptions.paths`. Do **not** add `allowImportingTsExtensions` (a
  `node --test` requirement, not needed under vitest/Metro).
- `metro.config.js` — add
  `config.resolver.extraNodeModules = { '@workspace/api-client-react': path.resolve(__dirname, 'vendor/api-client-react') }`.
- `babel.config.js`, `.gitignore`, `expo-env.d.ts` — no changes (`babel.config.js`
  is byte-identical to Replit's; local `.gitignore` is already a deliberately
  curated standalone-project version — verified it already ignores `.expo/`,
  `.env`, `*.tsbuildinfo`, etc., nothing new needed).
- `.env.local.example` — keep, but update its comment to note the base URL
  isn't currently wired into any request (the new pages don't read it) until
  the re-wire follow-up.

### `package.json`
Add to `dependencies`: `@react-navigation/native@7.3.13`.
Add to `devDependencies`: `expo-navigation-bar@~5.0.10`.
Remove from `devDependencies`: `@expo-google-fonts/spectral` (replaced by
Literata, which is already present).
Leave untouched: `expo-secure-store`, `@testing-library/*`, `jsdom`, `vitest`
(still needed by `lib/auth/` and the vitest test suite), the `expo-video` /
`@expo-google-fonts/literata` entries already present in `dependencies`.
Scripts stay as-is (`start`, `test`: `vitest run`, `typecheck`) — Replit's
`dev`/`build`/`serve` scripts belong to the excluded `server/`/`scripts/`.

### `README.md`
Rewrite to describe the current (post-port) state honestly:
- The app is now on the Replit-sourced dark-mode design (sidebar, source
  panel, new tokens) but **not wired to any backend** — `lib/api/`,
  `lib/auth/`, `lib/chat-reconcile`/`lib/chat-trace` remain in the tree
  disconnected, pending the re-wire follow-up issue.
- `app/index.tsx` / `chat/[id].tsx` call the vendored
  `@workspace/api-client-react` hooks directly (`useCreateConversation`,
  `useListSuggestedQuestions`, `useSendMessage`, `useGetConversation`) against
  a base URL that resolves to nothing real (`setBaseUrl` in `_layout.tsx`) —
  network calls will visibly fail; this is expected, not a bug.
- Drop the "Quick start (runs against staging)" narrative, the registration/
  guest-account warnings, and the streaming-chat / auth sections that describe
  wiring no longer connected to the UI (keep them out, don't just mark
  stale — a reader landing on this file should not have to guess which
  paragraphs still apply).
- Update "Layout" section for the new `app/`/`components/` contents.
- Update "Source + SHA" section: two imports now — the design (`artifacts/ansari/`
  from `~/Downloads/Ansari`, upstream sha `6c58e51`) and the original API
  client vendoring (unchanged, already documented).
- Keep the `--ignore-workspace` explanation (still accurate and still the
  install footgone this project needs documented).

### Not brought over (per issue)
`server/`, `public/`, `scripts/`, `docs/`, `BROWSERS.md`, root-level
`PERFORMANCE.md` rewrite (local's own `PERFORMANCE.md` stays untouched —
confirm during implementation whether its content still applies post-port; if
it references removed files, trim those references only), `icon-verification.png`.

## Risks & Alternatives Considered

- **Risk: the vendored `@workspace/api-client-react` surface silently drifts
  from what Replit's newest components expect** (e.g., a field on `Citation`
  a new `SourceFolio`/`SourceStack` component reads that our vendored schema
  lacks). Mitigation: this was checked directly against the generated schema
  file for every current import site and all types/functions match; `pnpm
  typecheck` in the implement phase is the final gate — a real gap surfaces
  there, and the issue's instruction is to stub it minimally rather than build
  it out.
- **Risk: Metro's `extraNodeModules` alone doesn't correctly resolve TypeScript
  types for `@workspace/api-client-react`.** Mitigation: `tsconfig.json` paths
  is what TS/tsc actually reads for typechecking; the Metro entry is only for
  the bundler at runtime. Both are being added, matching the issue's explicit
  instruction.
- **Risk: dropping `lib/insets.ts`/`lib/time.ts` turns out to be wrong** if
  some Replit file not yet read at plan time references them under a
  different import path. Mitigation: `pnpm typecheck` will fail loudly with an
  unresolvable import if so — cheap to catch, cheap to reverse (re-add the
  file) before the dev-approval gate.
- **Risk: `app.json`'s `expo-router` plugin `origin` option** (Replit sets it
  to `https://replit.com/`) **might matter for deep-linking/SSR in ways not
  obvious from reading the file.** Alternative considered: keep it. Rejected
  for now (it's a Replit-hosting concern, and the prototype has never used
  it) but flagged explicitly above so it gets a second look during
  implementation if `expo start` misbehaves.
- **Alternative considered: adopt `node --test` for the whole prototype**
  (matching Replit exactly, zero test-syntax conversion). Rejected — the issue
  itself states vitest is preferred and matches the repo, the prototype
  already has a working vitest setup with only 3 files to port, and keeping
  one test runner avoids a second, differently-configured test entry point in
  a repo that already standardized on vitest.
- **Alternative considered: fix the web font-loading gap in-scope** (e.g., add
  `@font-face` CSS some other way instead of via the excluded `public/`).
  Rejected — out of this issue's stated scope (`public/` is explicitly
  excluded), and the acceptance criteria only requires the design to *render*,
  not pixel-perfect font fidelity on web; documenting it in the README instead.

## Test Plan

- **Unit tests**: `pnpm test` (vitest) green, including the 3 newly-ported
  `lib/*.test.ts` files (`ambientNight.test.ts`, `keyboard.test.ts`,
  `markdown.test.ts`) and the untouched `lib/api/`, `lib/auth/`,
  `lib/chat-reconcile.test.ts`, `lib/chat-trace.test.ts` suites (must still
  pass unmodified — they don't touch anything this PIR changes).
- **Typecheck**: `pnpm install --ignore-workspace && pnpm typecheck` clean in
  `prototypes/ansari-expo` — this is where a missed
  `@workspace/api-client-react` export or a dangling import (e.g. a leftover
  reference to a deleted `lib/insets.ts`) will surface.
- **Manual (web)**: `pnpm start`, open the web build. Verify: home screen
  renders with dark-mode-capable styling, sidebar (desktop) / sidebar drawer
  (narrow width) opens and closes, chat screen route (`/chat/[id]`) renders,
  source panel opens from a citation affordance, about page renders. Toggle OS
  color scheme (or use whatever in-app control exists) and confirm dark mode
  applies. Expect and do not treat as a bug: `useCreateConversation`/
  `useListSuggestedQuestions` network calls failing (no real backend wired).
- **Manual (native, best-effort)**: if an iOS/Android simulator is available,
  boot the app and confirm the redrawn icon/splash screen (light and dark
  variants) show correctly, since those are native-only surfaces web can't
  verify.
- **Cross-check removed features**: confirm `/login` and `/register` routes no
  longer exist (expected — Expo Router should 404 or the routes simply aren't
  registered), and that nothing in the new `app/`/`components/` tree imports
  the deleted `AuthForm`/`HistorySheet`/`CitationSheet`/`WebNavButton`.
