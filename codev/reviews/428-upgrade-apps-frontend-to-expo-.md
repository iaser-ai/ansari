# PIR Review: Upgrade apps/frontend to Expo SDK 58

Fixes #428

## Summary

`apps/frontend` moves from Expo SDK 57 to SDK 58 (React Native 0.88, React 19.3), done with Expo's own tooling (`expo install expo@^58`, `expo install --fix`, `expo-doctor`) rather than hand-picked versions. The SDK required a few code and config changes: RN 0.88 strict ref types, keeping one web bundle, and unwiring Uniwind from Metro, which broke every icon font on native. Two owner-requested changes ride along: a Uniwind bump and the removal of the unused `zod-validation-error`.

## The SDK 58 versions, as the tooling selected them

`expo install --fix` chose every SDK-pinned version below; none was hand-picked.

| Package | SDK 57 | SDK 58 |
|---|---|---|
| expo | ~57.0.27 | ~58.0.26 |
| react-native | 0.86.3 | 0.88.1 |
| react / react-dom | 19.2.3 | 19.3.0 |
| @types/react / @types/react-dom | ~19.2.15 / ^19.2.4 | ~19.3.0 / ^19.3.0 |
| react-native-gesture-handler | ~2.32.0 | ~3.3.0 (major; the legacy `Gesture.*` builder API is deprecated, not removed, and is kept) |
| react-native-reanimated / -worklets | 4.5.1 / 0.10.1 | 4.7.1 / 0.13.0 |
| react-native-screens | ~4.26.0 | ~4.30.1 |
| react-native-safe-area-context | ~5.7.0 | ~5.11.1 |
| react-native-keyboard-controller | 1.21.9 | 1.22.7 |
| react-native-svg / react-native-web | 15.15.4 / ^0.21.2 | 15.16.0 / ^0.21.4 |
| the 20 `expo-*` modules, `@expo/metro-runtime` | 57.x | 58.x (e.g. expo-router ~58.0.32, expo-video ~58.0.14, expo-updates ~58.0.22); expo-web-browser is ~58.1.0 rather than 58.0.x because that is the range SDK 58's `bundledNativeModules.json` pins, the tooling's choice, not mine |
| babel-preset-expo / eslint-config-expo | ^57.0.14 / ^57.0.2 | ^58.0.26 / ^58.0.4 |

React stays at the SDK's 19.3.0 in the frontend. `apps/api`'s 19.3.1 (PR 435) is separate and intended.

## What changed beyond the version bump

- **RN 0.88 strict types** (`7463b92e`): refs typed as `TextInputInstance` / `ScrollViewInstance` / `ViewInstance`, `TextInputKeyPressEvent`, and `ListFooterComponent` given `undefined` instead of `null`. Types only; no runtime change.
- **One web bundle** (`555bc9ef`): expo-router 58 turns on async routes for web by default (16 chunk files instead of 1). Behind Caddy's `try_files {path} /index.html`, a chunk removed by a later deploy is served as `index.html` with a 200, so a tab opened before a deploy breaks on its first visit to an unloaded route. `app.json` sets `["expo-router", { "asyncRoutes": { "web": false } }]`, the documented opt-out, to keep SDK 57's single bundle.
- **Uniwind unwired from Metro** (`aaf4cff8`, owner decision): Uniwind's Metro wrapper redirects every `react-native` import to its own re-export list. That list lacks RN 0.88's new exports such as `AssetRegistry`, which expo-asset 58 imports, so with the wrapper every `@expo/vector-icons` font failed on native (`Cannot read property 'getAssetByID' of undefined`). I proved it both ways on the iOS 27.2 simulator: errors with the wrapper, none and icons rendered without it. Uniwind is unused in the app (0 `className`, 0 imports); the package and the `gen:types` chain stay, and the web export and Docker web image still build.
- **uniwind ^1.14.0** (`8aaeed82`, owner decision): **this bump does NOT fix the icon failure.** 1.14.0, the latest on 2026-11-24, still lacks `AssetRegistry` in its shim. `gen:types` output is byte-identical to 1.12.2's.
- **zod-validation-error removed** (`d2fbfc22`): the owner's direct request, **not part of the SDK upgrade**. It was imported nowhere, and its 3.x line peers on zod ^3, unmet since the frontend moved to zod 4.6.7.
- **`.env.local` wins in dev bundles** (`e9b89d2b`, docs only): in SDK 58, a development bundle (`expo start`) reads the `.env*` files at runtime through `expo/virtual/env` and merges them OVER the shell's variables, even with `EXPO_NO_DOTENV=1`. `EXPO_PUBLIC_API_URL=… expo start` is therefore silently overridden by `.env.local`. Exports (`expo export`, the web image, EAS builds) still inline the shell's values. The frontend README and CONTRIBUTING now say to edit `.env.local` for a dev build.
- **className guard** (review round 1): `tsconfig.json` still includes `uniwind-env.d.ts`, so `<View className="…">` typechecks but does nothing while Uniwind is unwired. `lib/no-classname.test.ts` scans every JSX attribute under `app/` and `components/` with the TypeScript AST and fails on any `className`. I proved it both ways: a `className` planted at `components/SourceStack.tsx:185` failed it, and removing it passed. The test also checks a planted case and near-misses (comments, strings, `classNames`, `containerClassName`) in-file.
- **Docs**: `metro.config.js` comment, frontend README (SDK line, Uniwind section, React Compiler note), `arch.md`, the EAS update workflow header, and three comments this PR made false (`.gitignore`, `eslint.config.mjs`, `babel.config.js`).

## OTA safety: the fingerprint proof

`runtimeVersion` uses `policy: fingerprint`, so no config change was needed. Measured with `npx expo-updates fingerprint:generate` before and after the upgrade:

| Platform | SDK 57 | SDK 58 |
|---|---|---|
| iOS | `3920495a15d8ad5e57f1ad6f3da31a7cace8826b` | `adf2951d584e8cef0146aad29460347c97c49cb3` (50 sources changed) |
| Android | `120d9adb39f19771fdcfa9249c407274f4639fbf` | `53dc6e23885d2feea58b28c69b2e4303f760fea8` (48 sources changed) |

An update built on SDK 58 never reaches an SDK 57 binary. The rule: **ship a new binary (EAS Build) before publishing SDK 58 updates**; an update alone reaches no one. `RELEASE.md` records this in its own commit, **`f2ffb25e`**, for the main architect. Nothing under `.github/` changed: EAS CLI 24.12.1 needed no bump.

## packages/auth's lockfile entry changes (one line)

`packages/auth` ships in the auth image, and its lockfile importer changes by one line. `@better-auth/expo` stays at **1.7.7**. Only its peer-resolution suffix moves to the SDK 58 versions now in the workspace (expo 58.0.26, expo-constants 58.0.16, expo-linking 58.0.17, expo-secure-store 58.0.3, expo-web-browser 58.1.0). All are **optional** peers of `@better-auth/expo`. The server imports only its root entry (`dist/index.js` and `dist/version-Bhp0O2mQ.js`), which requires no expo-\* package: its only external imports are `@better-auth/core/api`, `better-auth`, `better-auth/api` and `zod`.

Checked on 88cbf76c:
- **Boot check:** the production-shaped auth boot check passes 10/10 on a cold build.
- **Auth image:** `apps/auth/Dockerfile` builds, and the container boots with NODE_ENV=production.
- **Inside the image:** no expo-\* package resolves from `packages/auth`, and `@better-auth/expo` loads.
- **Image size:** the image's pnpm store holds unlinked expo packages, 70 directories on develop and 74 here (+57 MB). This was already the case on develop.

Details are in the PR comment.

## Files Changed

- `pnpm-lock.yaml` (+1565 / -2383), regenerated by pnpm, never hand-edited
- `apps/frontend/package.json` (+39 / -40)
- `apps/frontend/README.md` (+17 / -8)
- `apps/frontend/metro.config.js` (+10 / -9)
- `apps/frontend/app.json` (+6 / -1)
- `apps/frontend/components/ChatInput.tsx` (+4 / -6)
- `apps/frontend/components/AmbientVideo.tsx` (+3 / -3)
- `apps/frontend/components/SourceStack.tsx` (+2 / -1)
- `apps/frontend/app/index.tsx` (+2 / -2)
- `apps/frontend/app/chat/[id].tsx` (+1 / -1)
- `apps/frontend/.eas/workflows/update.yml` (+2 / -1)
- `RELEASE.md` (+3 / -1)
- `CONTRIBUTING.md` (+2 / -1)
- `codev/resources/arch.md`, `codev/resources/lessons-learned.md`, `codev/resources/lessons-critical.md`
- `codev/plans/428-upgrade-apps-frontend-to-expo-.md`, `codev/reviews/428-upgrade-apps-frontend-to-expo-.md`, `codev/state/pir-428_thread.md`, `codev/projects/428-…/status.yaml`

## Commits

- `ba6c3163` frontend: Expo SDK 58 via expo install / expo install --fix
- `7463b92e` frontend: RN 0.88 strict ref and event types
- `555bc9ef` frontend: keep the single web bundle (asyncRoutes.web false)
- `f2ffb25e` RELEASE.md: an SDK upgrade changes the update fingerprint
- `4f8e280a` eas update workflow: note that an SDK upgrade needs a new build first
- `aaf4cff8` frontend: unwire Uniwind from Metro (owner decision 2026-11-24)
- `8aaeed82` frontend: uniwind ^1.14.0 (owner decision)
- `a5d55825` arch.md: frontend on SDK 58 / RN 0.88 / React 19.3; Uniwind not wired
- `e9b89d2b` docs: SDK 58 dev bundles let .env files win over the shell
- `d2fbfc22` frontend: drop unused zod-validation-error (owner request)
- plus plan, thread and porch commits, and three merges of `develop` (dotenv 18; zod 4.6.7 / vitest 5.1.1 / api react 19.3.1; api next 15.5.29 / sharp). Each regenerated the lockfile with `pnpm install`; zod, dotenv, eslint, vitest, eslint-config-next, next and sharp are identical to `develop`.

## Test Results

- `npx expo-doctor`: ✓ 20/20
- lint: ✓ 0 errors; typecheck: ✓; frontend tests: ✓ 813 passed (63 files: the 809 plus the 4 className-guard tests)
- **What the vitest suite does not prove:** `vitest.config.ts` aliases `react-native` to `react-native-web`, so the tests run the web branch only. They are **not** evidence for gesture-handler 3, worklets on the UI thread, expo-video native or SecureStore; those rest on the device checks below.

**Lint baseline, per rule** (frontend eslint, develop `cf584b6f` vs this PR's head):

| Rule | develop | this PR |
|---|---|---|
| import/first | 36 | 36 |
| import/no-duplicates | 2 | 2 |
| react-hooks/globals | 2 | 2 |
| react-hooks/immutability | 3 | 3 |
| react-hooks/refs | 9 | 9 |
| react-hooks/set-state-in-effect | 12 | 12 |
| **total** (errors) | **64** (0) | **64** (0) |

The sets are identical: every React Compiler rule (`react-hooks/*`) fires on the same files the same number of times on both. No compiler decision changed. eslint-config-expo 58.0.4 still ships eslint-plugin-react-hooks v7 (7.1.1), like 57.
- web export: ✓ one bundle; Docker web image (`Dockerfile.web`): ✓ builds and serves one bundle
- porch build and tests checks: ✓ (API suite run with `apps/api/.env.ci`, as CI does)
- Built web `dist/` in headless Chrome: ✓ 12 routes, no page errors, no error boundary

Verified by me:
- **iOS 27.2 simulator (iPhone 18 Pro), dev build**: launches, icons render, no JS errors. I could not drive taps there, so **iOS interaction was tested by the owner, not by me**, at the dev-approval gate: the composer riding the keyboard on iOS and every swipe (sheet drag, swipe-to-reveal, edge swipe, toast, mark spin) were the owner's device checks.
- **Android emulator (API 36.1), dev build, against staging**: fresh guest session, a question typed and sent, answer streamed to completion with Sources (Qur'an and Hadith pills, hadith grades, footnotes), on the final head with zod 4.6.7. Composer rides the keyboard.

Verified by the owner (dev-approval, 2026-11-24): the device test list (iOS and Android dev builds, real-device timing, mobile web in the iOS Simulator).

Not verified: an Android release build. R8 is now on by default in SDK 58 release builds; the optional `preview` EAS build check was left to the owner.

## Owner checks requested at review round 1 (answers recorded when relayed)

- Native SDK 58 build against staging, open an emailed password-reset link (`ansarichat://reset-password?token=…`): the form appears, the reset succeeds, and the token is gone from the route params (`app/reset-password.tsx:55-66` relies on a same-path `router.replace`). *Pending.*
- Optional: install the SDK 58 build over an existing SDK 57 build and confirm the session survives (SecureStore). *Pending.*

## Pre-existing bug found: Retry brings the answer back without sources

Not caused by this PR or by zod 4. Proposed as its own issue; not filed.

- **Reproduction** (Android dev build, staging): ask a question, cut the network after part of the answer has streamed (`adb shell svc wifi disable; adb shell svc data disable`), wait for "Answer not delivered", restore the network, tap Retry. The full answer returns, but with raw `[1, 2]` citations and no Sources section.
- **Same on both**: the zod 4.6.7 head and the zod 3.25.76 control (`e9b89d2b`) behave identically. A cut BEFORE any text (during search) retried WITH sources on zod 3.
- **Code path**: Retry calls `send(retryQuestion)` (`apps/frontend/app/chat/[id].tsx:854`). `sendMessage`'s `onSuccess` (`:319`) invalidates the detail query, whose queryFn `loadConversationDetail` (`apps/frontend/lib/api/decode.ts`) refetches `/documents` in parallel with the thread. So the client does ask for the sources again. The gap is in what `/documents` returns for, or how `joinThreadDocuments` joins, an answer that follows a failed partial turn. Likely server side (spec 168 derivation after an error turn) or the join; not pinned.
- **Proposed issue title**: "Retry after a mid-stream failure shows the answer without sources".

## Dependabot

- **#432** (`@expo/metro-runtime` 57.0.16 → 58.0.17): fully superseded, this PR sets `~58.0.17`.
- **#433** (`expo-video` 57.0.5 → 58.0.14): fully superseded, this PR sets `~58.0.14`.
- #343 and the frontend half of #215 (named in the issue) are already closed; this PR covers both.

## Proposed note for issue #264

> Uniwind is installed but no longer wired into Metro (#428): through uniwind 1.14.0 its `react-native` shim lacks RN 0.88's `AssetRegistry`, which breaks every icon font on native. Re-wiring needs an upstream release that forwards the new RN exports, verified on a native build. Until then `apps/frontend/lib/no-classname.test.ts` fails on any `className` under `app/` and `components/`; remove that test when re-wiring.

## Architecture Updates

COLD `codev/resources/arch.md`: the frontend entry now says SDK 58 / RN 0.88 / React 19.3, that Uniwind is installed but not wired (and why), that the web export is one bundle on purpose (`asyncRoutes.web: false`, and the Caddy `try_files` reason), that this narrows the stale-tab window without closing it, and the className guard. No HOT change: none of these changes a cross-cutting rule.

## Lessons Learned Updates

COLD `codev/resources/lessons-learned.md`: a new "Expo SDK 57 → 58 (issue #428)" section covering:
- a Metro wrapper that shims `react-native` breaks on an RN bump, far from where it fails;
- `.env*` files win over the shell in SDK 58 dev bundles;
- one bad device session is not a regression;
- refreshing the stale `@expo/dom-webview` peer after every merge;
- `expo install` still appends no-op plugins;
- how to drive an Android emulator for a native check.

HOT `lessons-critical.md`: the map line for SDK upgrades now names #428. No new hot lesson.

## Things to Look At During PR Review

- **`pnpm-lock.yaml`** is large but tool-generated. Each `develop` merge took `develop`'s lockfile and regenerated it. The task-15s3 packages and next/sharp were checked byte-identical to `develop`.
- **`@expo/dom-webview`** came back as 57.0.1 from `develop`'s lockfile on every merge and was refreshed to 58.0.2 each time. A future merge of an old lockfile can bring it back; `expo-doctor` catches it.
- **gesture-handler 3** keeps the deprecated `Gesture.*` builder API in five components. Moving to the hook API before RNGH removes the builders is a separate follow-up.
- **The `asyncRoutes.web: false` opt-out** is a deliberate behaviour choice beyond the raw upgrade, made to avoid broken tabs after deploys. It **narrows the stale-tab window but does not close it**: a tab holding a pre-deploy `index.html` asks for a bundle hash that no longer exists and gets `index.html` back. `apps/frontend/Caddyfile` sets no cache headers and has no `/_expo/` rule; it is only `file_server` plus `try_files {path} /index.html`. The durable fix is a proposed follow-up, not done here: a 404 instead of the `index.html` fallthrough under `/_expo/`, plus explicit cache headers. Removing the opt-out needs that first.
- **Stale comments**: the three flagged were fixed (`.gitignore:12`, `eslint.config.mjs:27`, `babel.config.js:3`). A repo-wide sweep for present-tense SDK 57 / RN 0.86 claims found **1 more**, fixed (`apps/frontend/README.md`, the React Compiler note). These were kept as dated records: the README's "SDK 54 → 57 port (#262)" table, the lessons-learned #262 section and `app/_layout.tsx:176` ("expo-navigation-bar 57 replaced…", still true). Flag only, not edited: `codev/state/app.md` lines 70 and 83 still say SDK 57 (the app architect's state file).
- **The R8 release build** is not verified.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder pir-428 → **View Diff**
- **Run dev**: `afx dev pir-428`. In SDK 58, `.env.local` decides where a dev build points and wins over shell variables.
- **What to verify**: new iOS and Android dev builds (`pnpm ios:device`, `pnpm android:device`); then sign in, ask a question and watch it stream to the end with sources, open a thread with sources, and check every swipe (gesture-handler 3) and the ambient video on a real device.
