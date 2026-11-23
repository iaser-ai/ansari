# pir-428 thread — Expo SDK 57 → 58 (apps/frontend)

## 2026-11-24 — plan phase
- Read SDK 58 changelog, upgrade walkthrough, router 57→58 guide, RNGH 3 upgrade guide; pulled bundledNativeModules.json from expo@58.0.26.
- Biggest surprise: SDK 58 pins react-native-gesture-handler ~3.3.0 (major). The 3.3.0 package still exports the `Gesture.*` builder API, deprecated not removed — plan keeps it and verifies gestures on device; hook migration proposed as follow-up.
- App already sets web.output "single" and its own SafeAreaProvider, so the router's server-output and web-insets changes should not bite; both verified in the test plan.
- First grep scan was broken (`\|` in ERE, zero hits incl. control); redone with rg + positive control.
- Architect constraints: don't bump zod/dotenv/eslint/vitest/eslint-config-next (task-15s3 owns), regenerate lockfile via pnpm install after every develop merge, name any .github hunks.
