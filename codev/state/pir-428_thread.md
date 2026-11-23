# pir-428 thread — Expo SDK 57 → 58 (apps/frontend)

## 2026-11-24 — plan phase
- Read SDK 58 changelog, upgrade walkthrough, router 57→58 guide, RNGH 3 upgrade guide; pulled bundledNativeModules.json from expo@58.0.26.
- Biggest surprise: SDK 58 pins react-native-gesture-handler ~3.3.0 (major). The 3.3.0 package still exports the `Gesture.*` builder API, deprecated not removed — plan keeps it and verifies gestures on device; hook migration proposed as follow-up.
- App already sets web.output "single" and its own SafeAreaProvider, so the router's server-output and web-insets changes should not bite; both verified in the test plan.
- First grep scan was broken (`\|` in ERE, zero hits incl. control); redone with rg + positive control.
- Architect constraints: don't bump zod/dotenv/eslint/vitest/eslint-config-next (task-15s3 owns), regenerate lockfile via pnpm install after every develop merge, name any .github hunks.

## 2026-11-24 — implement phase
- Plan approved by owner (relayed by security). expo install expo@^58 + --fix: 36 pkgs, matches the bundledNativeModules prediction exactly. expo install appended no-op expo-image/expo-status-bar plugins to app.json — reverted.
- expo-doctor flagged @expo/dom-webview 57.0.1: an auto-installed optional peer that the lockfile kept stale ('*' range). `pnpm update --depth Infinity` was far too broad (1035 lockfile lines, vitest graph) — reverted; expo install + pnpm remove refreshed only it. A filtered `pnpm remove` dropped a `catalogs:` row; `pnpm install --resolution-only` restored it. zod/dotenv/eslint/vitest/eslint-config-next byte-identical to develop.
- RN 0.88 strict types: 6 ref/event type errors, fixed with *Instance types.
- expo-router 58 async web routes split the export into 16 chunks; behind Caddy try_files a deploy would break open tabs. Opted out (asyncRoutes.web false).
- Fingerprints differ 57→58 on both platforms (OTA safety proven).
- Web dist: 12 routes, no page errors. Web-vs-staging Q&A not possible locally: staging rejects localhost origins by design (CORS, then Better Auth 403).
- BLOCKER: on native, every @expo/vector-icons font fails. Uniwind's Metro wrapper shims `react-native` with a fixed export list lacking RN 0.88's AssetRegistry (still missing in uniwind 1.14.0). Proven both ways on the iOS 27.2 simulator. Asked architect: (A) unwire withUniwindConfig [recommended], (B) pnpm patch, (C) custom resolver.

## 2026-11-24 — implement phase, continued
- Owner decision (via security): option A + bump uniwind. Unwired withUniwindConfig; uniwind ^1.14.0 (does NOT fix icons; gen:types byte-identical). Docs: metro.config.js, frontend README (4), arch.md (1). turbo.json / package.json '//' make no wiring claim: untouched.
- Web export + Docker web image build and serve one bundle. iOS (27.2 sim) and Android (API 36.1 emulator) dev builds launch with icons.
- Android "send does nothing" chase: NOT a regression. SDK 58 dev bundles read .env* at runtime via expo/virtual/env and merge them OVER process.env (EXPO_NO_DOTENV ignored), so my worktree's .env.local (localhost) beat the shell's staging URLs. Exports still inline shell values (verified: dist-staging has staging, no localhost). Found with an on-screen state probe after console proved unreachable (RN 0.88 console goes only to DevTools) and CDP via Metro failed. Controls: SDK 57 from a clean worktree worked; SDK 58 from a clean worktree (no .env.local) streamed a full answer with footnotes on Android. Documented in frontend README + CONTRIBUTING.
- Merged develop (dotenv 18): lockfile taken from develop and regenerated with pnpm install; the stale @expo/dom-webview 57 came back from develop's lockfile and was refreshed the same tool-only way. task-15s3 packages identical to develop. metro 0.87.3 now present beside 0.87.1 (RN community-cli-plugin float; Expo bundles with 0.87.1).
- Pitfalls for the next builder: uiautomator can't dump while the ambient video plays; adb taps on the send button move with the keyboard; my AVD pir428-phone exists because Medium_Phone_API_36.1's /data was full of other projects' apps.
