# PIR Plan: Upgrade apps/frontend to Expo SDK 58

## Understanding

`apps/frontend` is on Expo SDK 57 (`expo ~57.0.27`, `react-native 0.86.3`, `react`/`react-dom 19.2.3`). Issue #428 moves it to SDK 58 with Expo's own tooling (`expo install`, `expo install --fix`, `expo-doctor`). It must not hand-pick versions of SDK-pinned packages, change the auth client contract or the `ansarichat` scheme, or bump anything the SDK does not require. The PR supersedes Dependabot #343 (`expo-video` 58) and the frontend half of #215 (`react-dom` 19.3.x).

Constraints relayed by the architect (2026-11-23):
- Builder task-15s3 is landing zod, dotenv, eslint, vitest and eslint-config-next bumps on `develop`, and those rewrite `pnpm-lock.yaml`. I do not bump those packages. When `develop` moves I merge it, **regenerate the lockfile with `pnpm install` (never hand-merge it)**, and re-run `expo-doctor`.
- Any hunk under `.github/` is named to the architect. The main architect reviews it.
- No AI attribution in commits or the PR.

### What SDK 58 is (from the sources, read 2026-11-24)

Sources: https://expo.dev/changelog/sdk-58, https://docs.expo.dev/workflow/upgrading-expo-sdk-walkthrough/, https://docs.expo.dev/router/migrate/sdk-57-to-58/, the react-native-gesture-handler "upgrading to 3" guide, and `bundledNativeModules.json` from `expo@58.0.26` (the current `latest`).

The versions `expo install --fix` is expected to select. **This is a prediction for review, not a choice. The tool's output is the answer.**

| Package | Now | SDK 58 pin |
|---|---|---|
| react-native | 0.86.3 | 0.88.1 |
| react / react-dom | 19.2.3 | 19.3.0 |
| react-native-gesture-handler | ~2.32.0 | **~3.3.0 (major)** |
| react-native-reanimated / worklets | 4.5.1 / 0.10.1 | 4.7.1 / 0.13.0 |
| react-native-screens | ~4.26.0 | ~4.30.1 |
| react-native-safe-area-context | ~5.7.0 | ~5.11.1 |
| react-native-keyboard-controller | 1.21.9 | 1.22.7 |
| react-native-svg / react-native-web | 15.15.4 / ^0.21.2 | 15.16.0 / ~0.21.4 |
| expo-* (all 20), @expo/metro-runtime, eslint-config-expo | 57.x | 58.x |

Node: SDK 58 needs ≥ 22.13 on the 22 line. `.nvmrc` is `22`, local is 22.23.4, so no change.

### SDK 58 breaking changes checked against this app

I scanned with `rg` across `apps/frontend`, excluding `node_modules`. A first `grep -E` pass returned zero for everything, including the control. That pass was broken (`\|` inside ERE), so it was discarded. The `rg` scan had a positive control: 19 files import `expo-router`.

| Breaking change | Uses in this app | Impact |
|---|---|---|
| RN 0.87 strict TS API: deep `react-native/Libraries/*` imports become type errors; ref types become `*Instance` | 0 deep imports | Typecheck will show any ref-type fallout. Fix in code. Do **not** use the `react-native-legacy-deep-imports` opt-out. |
| RN removals: `InteractionManager`, `Touchable` root export, `NativeMethods`, `Modal animated`, StatusBar `backgroundColor`/`translucent` | 0 / 0 / 0 / 0. Both `<Modal>`s (`components/Sheet.tsx:351`, `components/ErrorFallback.tsx:104`) use `animationType`, not `animated`. `StatusBar` comes from `expo-status-bar` with `style` only (`app/_layout.tsx:182`). | None expected |
| `ImageBackground` deprecated | 0 | None |
| iOS UIScene life cycle (prebuild generates SceneDelegate) | CNG: `ios/` and `android/` are gitignored, with no custom AppDelegate plugin | Prebuild handles it. Needs a **new dev build** on device. |
| Android R8 on by default in release builds | release/preview builds | **Risk:** R8 can strip reflection-used classes in release only. Verify with a `preview` build (see Test Plan). |
| `NODE_ENV` forced to development/production by Expo CLI | 0 `NODE_ENV` reads. Only `.env.local`, which loads in every mode. | None. vitest does not go through Expo CLI. |
| `@expo/fingerprint` default preset becomes `balanced` | `runtimeVersion: { policy: "fingerprint" }` | Native module versions change, so the fingerprint changes. **SDK 58 updates cannot reach SDK 57 binaries.** Verified by hash comparison (Test Plan). |
| expo-router 58: `initialRouteName`, Screen `redirect`/`initialParams`/`navigationKey`, `beforeRemove`, `freezeOnBlur` removed; `useNavigation` throws outside a navigator; dispatch deferred to after commit | 0 uses of any removed prop or API. The root `Stack` (`app/_layout.tsx:285`) is `headerShown: false` with plain `Stack.Screen name=…`. The app uses `router`, `useLocalSearchParams`, `useGlobalSearchParams`, `Redirect`, `Link`, `useFocusEffect`, `useIsFocused`. | Low. Deferred dispatch can reorder `router.replace` inside effects (auth redirects). Covered by the sign-in / sign-out / reset flows in the Test Plan. |
| `web.output` default becomes `server` | `app.json` explicitly sets `"output": "single"` | None. The setting stays explicit. The Caddy SPA deploy (`Dockerfile.web`) is unchanged. |
| Async routes on by default on web | web export | Possible code-split chunks in `dist/`. Load the built `dist/` and walk every route (lesson from #262). |
| Router no longer provides safe-area insets on web | The app mounts its **own** `SafeAreaProvider` (`app/_layout.tsx:9`). `useSafeAreaInsets` is used in `index`, `about`, `share/[id]` and others. | Check notch/home-indicator padding on mobile web in the iOS Simulator. If insets read 0, fall back to CSS `env(safe-area-inset-*)` per the router guide. |
| iOS 26+: Stack headers transparent by default | `headerShown: false` | None |
| expo-glass-effect: `isLiquidGlassAvailable` returns true with the iOS 27 SDK | `components/ChatInput.tsx`, `components/GlassCircleButton.tsx` | The glass path may now render on iOS 27 builds. Look at it on device. |
| expo-image: SVG `var()` fallback now rendered | Check for SVG sources through expo-image (the Ansari mark is `react-native-svg`) | Look at it |
| **react-native-gesture-handler 2 → 3** | `Gesture.Pan()` builder in `Sheet`, `SwipeToReveal`, `EdgeSwipe`, `ToastStack`, `AnsariMarkSpin`; `GestureHandlerRootView` in `_layout` and `Sheet` | In the 3.3.0 package the builder API is still exported (`GestureObjects as Gesture`) and marked `@deprecated`, not removed. `GestureDetector` is now a host view that "is detached and reattached when its place in the hierarchy changes, which cancels an active gesture". **Plan: keep the builder API** (migrating to hooks is not an SDK requirement, so it is out of scope) and verify every swipe on device. Fix only what actually breaks. |

Deprecations with no use here: `withLayoutContext`, `File.md5`, `NativeArrayBuffer`, `@expo/ui` props.

## Proposed Change

All commands run from `apps/frontend`. The lockfile is the single root `pnpm-lock.yaml`.

1. `git merge origin/develop` (to absorb task-15s3's bumps first), then `pnpm install`.
2. `npx expo install expo@^58.0.0`
3. `npx expo install --fix`. This takes every SDK-pinned version as given.
4. `npx expo-doctor`. Repeat until clean. If doctor flags a non-SDK package (for example `@expo/vector-icons` or the `@expo-google-fonts/*` packages), change it only when doctor or the SDK requires it, and say so in the PR.
5. Diff `app.json` and `package.json` after every install (lesson from #262: `expo install` appends plugins and rewrites scripts). Revert anything the tool added that is not required, and justify any addition kept.
6. Diff `pnpm-lock.yaml`. Expected changes are confined to the expo/RN graph. Any unrelated transitive bump gets investigated. No change to the zod, dotenv, eslint, vitest or eslint-config-next entries that `develop` owns.
7. Code fixes, only where typecheck, tests or a device run demand them (strict TS ref types, gesture-handler 3 behaviour, router deferred dispatch).
8. Update the version-pinned comments that name SDK 57 (`babel.config.js`, `app/_layout.tsx:176` expo-navigation-bar note) only where they become false.
9. EAS: `eas.json` `cli.version >= 21.0.0` and the workflows' `eas-version: 24.12.1`. Check that EAS CLI 24.12.1 supports SDK 58 by running a real `development` build. If it doesn't, bump `eas-version` in `.github/workflows/eas-build.yml` and `eas-update.yml` and **name those hunks to the architect**. If it does, nothing under `.github/` changes.
10. Runtime safety for OTA: no config change is needed (`policy: fingerprint`). Prove it: generate the fingerprint (`npx expo-updates fingerprint:generate --platform ios|android`) on `develop` and on the branch, and record that both hashes differ in the review. Add one sentence to `apps/frontend/.eas/workflows/update.yml`'s header (not `.github/`) and to `RELEASE.md` "Native builds and updates": an SDK upgrade changes the fingerprint, so a new binary must ship before updates built on it reach users.
11. When `develop` moves during the work: merge, `pnpm install` to regenerate the lockfile, then re-run `expo-doctor`, typecheck and tests.
12. Update `codev/resources/lessons-learned.md` (SDK upgrade section) and `arch.md` only if something non-obvious turns up.

## Files to Change

- `apps/frontend/package.json`: versions selected by `expo install` / `--fix`
- `pnpm-lock.yaml`: regenerated by pnpm, never hand-edited
- `apps/frontend/app.json`: only what the tool or upgrade guide requires (expected: nothing; `web.output: "single"` stays)
- `apps/frontend/components/{Sheet,SwipeToReveal,EdgeSwipe,ToastStack,AnsariMarkSpin}.tsx`: only if gesture-handler 3 breaks behaviour
- Any file where RN 0.88 strict types fail typecheck
- `apps/frontend/babel.config.js`, `apps/frontend/app/_layout.tsx`: stale SDK-57 comments only
- `apps/frontend/.eas/workflows/update.yml`, `RELEASE.md`: one-sentence fingerprint note
- `.github/workflows/eas-build.yml`, `eas-update.yml`: **only if** EAS CLI 24.12.1 cannot build SDK 58 (named to the architect)
- `codev/state/pir-428_thread.md`, `codev/reviews/428-…md`

Not touched: `apps/frontend/lib/auth/*`, `packages/auth`, the `scheme` field, zod, dotenv, eslint, vitest, eslint-config-next.

## Risks & Alternatives Considered

- **Gesture-handler 3 behaviour change.** The builder API compiles, but `GestureDetector` as a host view may cancel gestures on re-parent (the Sheet drag, swipe-to-reveal, the edge swipe). Mitigation: device check of every gesture. Alternative: migrate to the hook API now. Rejected, because the SDK doesn't require it and it's a refactor of 5 components. Proposed as a follow-up issue.
- **Web-only green hides native breaks** (lesson from #262). Mitigation: real dev builds on iOS and Android, not only the web export.
- **"Export built" is not "bundle runs"** (lesson from #262: router 57 vendored react-navigation). Mitigation: serve the built `dist/` and walk every route in a browser.
- **R8 in Android release.** Debug dev builds won't show it. Mitigation: one `preview` Android build installed and smoke-tested.
- **Lockfile churn against task-15s3.** Mitigation: merge `develop` first and regenerate with `pnpm install`, never resolve lockfile conflicts by hand.
- **Expo Go has no SDK 58 yet.** Irrelevant here: the app uses `expo-dev-client`. A new dev build is required, and old dev builds won't load the new bundle.
- Alternative: hand-bump versions (as Dependabot #343 does). Rejected by the owner's instruction and because one module cannot move ahead of the SDK.

## Test Plan

Automated (all must pass):
- `npx expo-doctor`: no problems
- `pnpm exec turbo run lint typecheck test --filter ansari-frontend...`
- `pnpm exec turbo run build --filter ansari-frontend...` (web export)
- Serve `apps/frontend/dist` and load every route in Chrome over CDP: `/`, `/chat/<id>`, `/share/<id>`, `/about`, `/terms`, `/privacy`, `/login`, `/register`, `/forgot-password`, `/reset-password`, `/delete-account`, plus a 404. Expect no error boundary and no console errors.
- Fingerprint: the iOS and Android hashes differ between `develop` and the branch.
- Invariant greps across the whole repo (`apps/ packages/ codev/resources/`): `ansarichat` and `lib/auth/*` unchanged versus `develop`.

Manual, at `dev-approval`:
- **iOS dev build** (`expo run:ios`, Simulator, then a real iPhone): sign in, ask a question and watch the streamed answer finish (wait for "Ansari has answered"), open a thread from the list, open and drag-dismiss the sign-in sheet, swipe-to-reveal on a thread row, the edge swipe, swipe a toast, spin the Ansari mark, ambient video layer arrival and loop, liquid-glass buttons.
- **Android dev build** (`expo run:android`, emulator or device): the same flows, plus the back gesture.
- **Android `preview` build** via EAS: launch and run the main flows (R8 check).
- **Mobile web in the iOS Simulator** (Safari, via idb): safe-area padding at notch and home indicator, composer focus and keyboard, sign-in sheet `fitToShell`.
- **Timing-sensitive / visual on a real device**: ambient video arrival fade and smoothness, streaming reveal pacing. Compare against a `develop` build where it is a matter of eye.
