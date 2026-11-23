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
