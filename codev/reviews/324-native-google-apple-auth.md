# PIR Review: Native Google and Apple Authentication (Frontend Implementation)

Fixes #324
Spec: `codev/specs/324-native-google-apple-auth.md`
Plan: `codev/plans/324-native-google-apple-auth.md`

## Summary

This implements the frontend layers of Spec 324 (Native Google and Apple Authentication across Mobile & Web), strictly scoped to the frontend workspace per user direction.

Key architectural and platform requirements fulfilled:
- **Zero In-App Browser Redirects on Native**: Mobile authentication uses native OS dialogs. Apple Sign-In uses `expo-apple-authentication` (iOS). Google Sign-In uses `react-native-nitro-google-signin` (Credential Manager on Android, Google Sign-In SDK on iOS).
- **Universal Cookie-Free ID-Token Exchange**: The frontend client operates strictly cookie-free (`credentials: 'omit'`). `authApi.signInWithIdToken` submits `{ provider, idToken: { token, nonce, user } }` directly to `POST /api/auth/sign-in/social` and receives the session token in the JSON body.
- **Cryptographic Replay Nonce**: Every sign-in attempt generates a fresh 32-byte (64-character hex) random nonce via `lib/auth/crypto.ts`. Apple Sign-In on iOS hashes this with SHA-256 (`sha256Hex`) before submitting to the Apple SDK while sending the raw nonce to Ansari auth.
- **Platform Button Matrix**:
  - **Android**: Renders **Google only** (`Platform.OS !== 'android'` hides Apple).
  - **iOS**: Renders **Apple (top)** and **Google (secondary)** per Apple HIG.
  - **Web**: Renders Apple popup and Google in-page sign-in adapters.
- **Silent User Cancellation**: Dismissing or cancelling native dialogs (`ERR_REQUEST_CANCELED` on Apple, `isCancelledResponse` on Google) leaves `AuthSheet` intact without displaying an error alert or banner.
- **Two-Token Protocol Parity**: Social sign-ins integrate directly into `AuthContext` via `startSession()`, minting 15-minute EdDSA JWTs via `GET /api/auth/token` with automatic 401 refresh.

## Files Changed

- `apps/frontend/package.json`: Added `expo-apple-authentication`, `expo-crypto`, `react-native-nitro-google-signin`, `react-native-nitro-modules`.
- `apps/frontend/app.json`: Added `expo-apple-authentication`, `react-native-nitro-google-signin` plugin with iOS URL scheme, and `com.apple.developer.applesignin` entitlement.
- `apps/frontend/lib/auth/crypto.ts` (new): Nonce generation and SHA-256 hex hashing with Web Crypto / fallback.
- `apps/frontend/lib/auth/crypto.test.ts` (new): Unit tests for random nonce generation and SHA-256 hashing.
- `apps/frontend/lib/auth/nativeApple.ts` (new): Native iOS Apple Sign-In adapter via `expo-apple-authentication`.
- `apps/frontend/lib/auth/nativeApple.web.ts` (new): Web Apple Sign-In adapter via Apple JS SDK with popup mode.
- `apps/frontend/lib/auth/nativeGoogle.ts` (new): Native Android/iOS Google Sign-In adapter via `react-native-nitro-google-signin`.
- `apps/frontend/lib/auth/nativeGoogle.web.ts` (new): Web Google Identity Services (GIS) adapter.
- `apps/frontend/lib/auth/api.ts`: Added `signInWithIdToken` calling `POST /api/auth/sign-in/social` with `credentials: 'omit'`.
- `apps/frontend/lib/auth/api.test.ts`: Added contract unit tests for `signInWithIdToken`.
- `apps/frontend/lib/auth/context.tsx`: Added `signInWithApple()` and `signInWithGoogle()` with cancellation handling and Two-Token JWT minting.
- `apps/frontend/lib/auth/context.test.tsx`: Added unit tests for social authentication success, JWT minting, cache clearing, and silent cancellation.
- `apps/frontend/components/AuthSheet.tsx`: Wired Apple and Google buttons, removed "not available" stub, and enforced platform button matrix.
- `apps/frontend/components/AuthSheet.test.tsx`: Replaced stub tests with button matrix tests (asserting Apple is absent on Android, present on iOS), click handling, cancellation, and error banners.
- `apps/frontend/vitest.config.ts`: Defined `__DEV__: true` for Node-environment test execution.
- `pnpm-lock.yaml`: Dependency lockfile updates.

## Test Results

- `pnpm --filter ansari-frontend test`: ✓ 61 test files passed, 790 tests passed (including `crypto.test.ts`, `AuthSheet.test.tsx`, `context.test.tsx`, `api.test.ts`).
- `pnpm --filter ansari-frontend typecheck`: ✓ 0 errors.
- `EXPO_NO_TELEMETRY=1 pnpm --filter ansari-frontend build:web`: ✓ Web export succeeded, compiling `dist/` cleanly.
- `pnpm typecheck`: ✓ All 6 workspace packages passed cleanly.
