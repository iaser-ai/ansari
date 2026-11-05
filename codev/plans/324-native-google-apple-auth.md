# Plan: Native Google and Apple Authentication (Mobile & Web)

**Specification**: [codev/specs/324-native-google-apple-auth.md](../specs/324-native-google-apple-auth.md)

---

## Executive Summary

This plan implements the proposed specification for native Google and Apple authentication across mobile (`apps/frontend`) and web, backed by `packages/auth` and `apps/auth`.

Key architectural principles:
- **Universal ID-Token Architecture (Cookie-Free)**: The frontend client (`apps/frontend/lib/auth/api.ts`) operates strictly cookie-free (`credentials: 'omit'`). All platforms (iOS, Android, and Web) acquire an ID token directly on the client and submit it to `POST /api/auth/sign-in/social`, receiving the `sessionToken` in the JSON response body.
- **Native Modules on Mobile (Non-Negotiable)**: On native iOS and Android, authentication uses native OS dialogs. Apple Sign-In uses `expo-apple-authentication` (iOS). Google Sign-In uses `react-native-nitro-google-signin` (powered by Nitro Modules / JSI, integrating Android Credential Manager and native iOS Google Sign-In SDK). Web redirects (`expo-web-browser` / Custom Tabs) on native mobile are prohibited.
- **Web Social Auth (In-Page ID Tokens)**: Web desktop and mobile browsers avoid redirect callbacks:
  - **Google**: Google Identity Services (GIS) issues ID tokens in-page through its official rendered button or One Tap.
  - **Apple**: Sign in with Apple JS (`AppleID.auth.signIn({ usePopup: true })`) issues ID tokens in-page via popup.
- **Platform Button Matrix**:
  - **iOS**: Renders both "Continue with Apple" and "Continue with Google" (Apple first, per Apple HIG).
  - **Android**: Renders **Google only**; the Apple button is hidden (`Platform.OS !== 'android'`).
  - **Web**: Renders both (Google via GIS rendered button; Apple via popup button).
- **Cryptographic Nonce**: Every sign-in attempt generates a fresh cryptographic nonce passed to the provider and verified by `apps/auth` to prevent token replay attacks.
- **Two-Token Protocol Parity**: Third-party logins produce a Better Auth `sessionToken` on `apps/auth`. The frontend exchanges this for a 15-minute EdDSA JWT via `GET /api/auth/token` for stateless `apps/api` access, preserving 401 single-flight token refresh.
- **Zero Schema Migrations**: The `auth.account` table in `packages/auth/src/schema.ts` already contains all necessary columns (`provider_id`, `account_id`, `id_token`, `access_token`, etc.) with `unique(user_id, provider_id)`.
- **Account Linking & Collision Safety**: Verified emails automatically link provider accounts under existing `auth.users` rows without creating duplicates or disrupting password authentication.

---

## Phases (Machine Readable)

```json
{
  "phases": [
    {
      "id": "phase_1",
      "title": "Backend environment, Better Auth social providers, multi-audience, and nonce-verified ID token exchange"
    },
    {
      "id": "phase_2",
      "title": "Frontend native module dependencies and EAS prebuild configuration"
    },
    {
      "id": "phase_3",
      "title": "Frontend universal auth client layer, nonce generation, and ID token exchange"
    },
    {
      "id": "phase_4",
      "title": "AuthSheet UI wiring, platform button matrix, cancellation UX, and real-device check"
    },
    {
      "id": "phase_5",
      "title": "Automated tests, contract verification, and workspace verification"
    }
  ]
}
```

---

## Phase Breakdown

### Phase 1: Backend Environment, Better Auth Social Providers, Multi-Audience, and Nonce-Verified ID Token Exchange

**Dependencies**: None

#### Objective
Enable Google and Apple social providers in `packages/auth` with native/web ID token verification, multi-audience support (iOS bundle ID `chat.ansari.app` and Web Services ID `APPLE_CLIENT_ID`), cryptographic nonce verification, and account linking.

#### Files to Create / Modify
- `packages/auth/src/env.ts`:
  - Add optional OAuth schema keys to `envSchema`:
    - `GOOGLE_CLIENT_ID`: Web Client ID (audience for Android, iOS, and Web ID tokens).
    - `GOOGLE_CLIENT_SECRET`: Client secret for Google provider configuration.
    - `APPLE_CLIENT_ID`: Services ID for Web sign-in (e.g. `ai.askansari.web`).
    - `APPLE_CLIENT_SECRET`: Client secret for Apple provider configuration.
    - `APPLE_BUNDLE_ID`: Defaults to `'chat.ansari.app'` (audience for iOS native Apple ID tokens).
    - `APPLE_TEAM_ID` & `APPLE_KEY_ID`: For Apple configuration.
- `apps/auth/.env.example`: Document the new Google and Apple environment variables.
- `turbo.json`: Add new environment variables to `globalEnv`.
- `packages/auth/src/index.ts`:
  - Configure `socialProviders` in `createAuth()`:
    - `google`: `clientId: env.GOOGLE_CLIENT_ID`, `clientSecret: env.GOOGLE_CLIENT_SECRET`.
    - `apple`: `clientId: env.APPLE_CLIENT_ID`, `clientSecret: env.APPLE_CLIENT_SECRET`.
  - ID Token Verification Configuration (`verifyProviderIdToken`):
    - Google: validates signature against Google certs (`https://www.googleapis.com/oauth2/v3/certs`), validates `iss`, validates `aud === env.GOOGLE_CLIENT_ID`, and validates `payload.nonce === nonce`.
    - Apple: validates signature against Apple JWKS (`https://appleid.apple.com/auth/keys`), validates `iss === 'https://appleid.apple.com'`, validates that `aud` matches **either** `env.APPLE_BUNDLE_ID` (`chat.ansari.app`) **or** `env.APPLE_CLIENT_ID` (Web Services ID), and validates `payload.nonce === nonce`.
  - Ensure `POST /api/auth/sign-in/social` handles `{ provider, idToken: { token, nonce, user } }`:
    - Maps claims (`email`, `emailVerified`, `name`).
    - On first Apple sign-in, persists `name` (`firstName`, `lastName`) passed via `idToken.user.name` into `auth.users`.
    - Handles Apple Private Relay emails (`@privaterelay.appleid.com`).
    - Handles account linking when `auth.users` row already exists with the same verified email.
  - User creation hook (`databaseHooks.user.create.before`) records `registered_via` from `X-Ansari-Client` header.
- `packages/auth/tests/config/social-auth.test.ts` (new):
  - Unit tests using PGlite verifying:
    - Google ID token verification and audience matching.
    - Apple ID token verification with iOS bundle ID audience (`chat.ansari.app`).
    - Apple ID token verification with Web Services ID audience (`APPLE_CLIENT_ID`).
    - Nonce verification (fails closed with 401 `INVALID_TOKEN` if nonce does not match).
    - Account linking: existing email user gains provider account link without duplicate user row.
    - Error handling: expired token (401), invalid signature (401), missing email claim (401).

#### Deliverables
- [ ] `packages/auth/src/env.ts` validates optional Google and Apple OAuth credentials.
- [ ] `packages/auth/src/index.ts` configures `socialProviders` with native/web `idToken` verification, multi-audience Apple support, and nonce checking.
- [ ] First sign-in Apple name capture and Private Relay email persistence implemented.
- [ ] Account linking tested and verified in PGlite.

#### Acceptance Criteria
- [ ] Unset OAuth env vars do not prevent service startup or break existing email/password auth.
- [ ] Valid Google ID token sent to `POST /api/auth/sign-in/social` returns 200 with `{ token, user }`.
- [ ] Valid Apple ID token with `aud: 'chat.ansari.app'` returns 200 with `{ token, user }`.
- [ ] Valid Apple ID token with `aud: env.APPLE_CLIENT_ID` returns 200 with `{ token, user }`.
- [ ] ID token with mismatched or missing nonce returns 401 `INVALID_TOKEN`.
- [ ] Invalid/expired ID token returns 401 `INVALID_TOKEN`.

---

### Phase 2: Frontend Native Module Dependencies and EAS Prebuild Configuration

**Dependencies**: Phase 1

#### Objective
Install and configure `expo-apple-authentication` and `react-native-nitro-google-signin` in `apps/frontend`, updating `app.json` config plugins and native entitlements, while keeping Google services files optional.

#### Files to Create / Modify
- `apps/frontend/package.json`:
  - Add `expo-apple-authentication` (`~57.0.x`).
  - Add `react-native-nitro-google-signin` and peer dependency `react-native-nitro-modules`.
- `apps/frontend/app.json`:
  - Add `"expo-apple-authentication"` to `expo.plugins`.
  - Add iOS entitlement: `"ios.entitlements": { "com.apple.developer.applesignin": ["Default"] }` (or via config plugin).
  - Add `"react-native-nitro-google-signin"` to `expo.plugins`.
  - Add reversed client ID URL scheme under `ios.infoPlist.CFBundleURLTypes` for Google Sign-In redirect handling.
  - Note: `google-services.json` and `GoogleService-Info.plist` are **optional** because `webClientId` is explicitly passed in configuration.
- `apps/frontend/app.config.js` or `app.json`:
  - Declare `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` and `EXPO_PUBLIC_APPLE_CLIENT_ID`.

#### Deliverables
- [ ] `pnpm install` succeeds across the workspace.
- [ ] `npx expo config --type public` in `apps/frontend` resolves without error.
- [ ] Web export (`pnpm --filter ansari-frontend build:web`) continues to compile cleanly.

#### Acceptance Criteria
- [ ] Workspace typecheck (`pnpm typecheck`) and lint (`pnpm lint`) pass with 0 errors.
- [ ] Native module imports do not crash web bundling (`react-native-web` compatibility).

---

### Phase 3: Frontend Universal Auth Client Layer, Nonce Generation, and ID Token Exchange

**Dependencies**: Phase 1, Phase 2

#### Objective
Implement the universal (cookie-free) ID-token sign-in adapters for Apple and Google across iOS, Android, and Web, including per-attempt cryptographic nonce generation, connecting them to `lib/auth/api.ts` and `lib/auth/context.tsx`.

#### Files to Create / Modify
- `apps/frontend/lib/auth/crypto.ts` (new):
  - Helper to generate a cryptographically random nonce string using `crypto.getRandomValues()` (Web) or `expo-crypto` (native), and compute SHA-256 where required.
- `apps/frontend/lib/auth/nativeApple.ts` & `apps/frontend/lib/auth/nativeApple.web.ts`:
  - Platform-split Apple helper:
    - Native (`.ts` / `.native.ts`): checks `AppleAuthentication.isAvailableAsync()`, generates nonce $N$, invokes `AppleAuthentication.signInAsync({ requestedScopes: [FULL_NAME, EMAIL], nonce: hash(N) })`, extracts `identityToken`, `fullName`, and calls `authApi.signInWithIdToken('apple', identityToken, N, user)`.
    - Web (`.web.ts`): loads Apple JS script, initializes `AppleID.auth.init({ clientId, scope, redirectURI, usePopup: true, nonce: N })`, calls `AppleID.auth.signIn()`, extracts `id_token` and first-sign-in `user` name, and calls `authApi.signInWithIdToken('apple', id_token, N, user)`.
- `apps/frontend/lib/auth/nativeGoogle.ts` & `apps/frontend/lib/auth/nativeGoogle.web.ts`:
  - Platform-split Google helper:
    - Native: configures `GoogleOneTapSignIn.configure({ webClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID })`, generates nonce $N$, invokes `GoogleOneTapSignIn.signIn({ nonce: N })`, extracts `idToken`, and calls `authApi.signInWithIdToken('google', idToken, N)`.
    - Web (`.web.ts`): initializes Google Identity Services (`google.accounts.id.initialize({ client_id, nonce: N, callback })`), renders Google button into container, receives `response.credential`, and calls `authApi.signInWithIdToken('google', credential, N)`.
- `apps/frontend/lib/auth/api.ts`:
  - Add `signInWithIdToken(provider: 'apple' | 'google', idToken: string, nonce: string, user?: { name?: { firstName?: string; lastName?: string } })`:
    - Sends `POST /api/auth/sign-in/social` with payload:
      ```json
      {
        "provider": provider,
        "idToken": {
          "token": idToken,
          "nonce": nonce,
          "user": user
        }
      }
      ```
    - Uses existing `customFetch` (`credentials: 'omit'`).
    - Returns `{ token: string, user: AuthUser }` from JSON body.
- `apps/frontend/lib/auth/context.tsx`:
  - Expose `signInWithApple()` and `signInWithGoogle()` on `AuthContext`.
  - When provider returns `sessionToken`, invoke `startSession({ sessionToken, user })` which:
    1. Calls `authApi.mintJwt(sessionToken)` (`GET /api/auth/token`).
    2. Persists `accessToken` and `sessionToken` in `expo-secure-store` / `localStorage`.
    3. Clears React Query cache and sets user state.

#### Deliverables
- [ ] Nonce generation helper implemented.
- [ ] Platform-split Apple and Google auth services implemented (iOS native, Android native, Web GIS/popup).
- [ ] `lib/auth/api.ts` implements `signInWithIdToken` sending token and nonce in JSON body.
- [ ] `lib/auth/context.tsx` provides unified social sign-in methods adhering to Two-Token Protocol.

#### Acceptance Criteria
- [ ] Calling `signInWithIdToken` against `apps/auth` establishes a valid session and mints an EdDSA JWT for `apps/api`.
- [ ] 401 token refresh functions identically to email/password sessions.

---

### Phase 4: AuthSheet UI Wiring, Platform Button Matrix, Cancellation UX, and Real-Device Check

**Dependencies**: Phase 3

#### Objective
Wire social buttons in `AuthSheet.tsx` to active authentication handlers, apply platform button visibility rules (hide Apple on Android), handle cancellation cleanly, and verify on physical devices.

#### Files to Create / Modify
- `apps/frontend/components/AuthSheet.tsx`:
  - Platform button filtering:
    - Render Apple button only on iOS and Web (`Platform.OS !== 'android'`).
    - On Web: render official Google Identity Services button container alongside Apple button.
    - On Mobile (iOS/Android): render `ProviderButton` for Google and Apple (iOS only).
  - Remove `unavailable` local state stub and message.
  - Wire Apple `onPress` to `handleAppleSignIn`.
  - Wire Google `onPress` to `handleGoogleSignIn`.
  - Handle user cancellation:
    - Apple: ignore `ERR_REQUEST_CANCELED` (code 1001) or popup closure without displaying an error.
    - Google: ignore user cancellation without displaying an error.
  - On network or verification failure, display inline error banner using existing error styling.
  - On success, close the sheet via `closeAuthSheet()`.
- `apps/frontend/components/AuthSheet.test.tsx`:
  - Update unit tests: remove tests expecting "not available yet" stub notice.
  - Add test asserting that when `Platform.OS === 'android'`, the Apple button is **not rendered**.
  - Add test asserting that when `Platform.OS === 'ios'`, both Apple and Google buttons are rendered.
  - Add tests verifying provider button click triggers `signInWithApple` / `signInWithGoogle`.
  - Add tests verifying cancellation does not set error state.
  - Add tests verifying backend error sets inline error message.

#### Deliverables
- [ ] `AuthSheet.tsx` enforces platform button matrix (Android shows Google only).
- [ ] Web renders official GIS button and Apple popup trigger.
- [ ] Cancellation UX leaves sheet open with no errors.
- [ ] Success UX dismisses sheet cleanly.
- [ ] Real-device check executed on physical hardware:
  - Physical iPhone: verify Apple native dialog and Google native dialog.
  - Physical Android phone: verify Google Credential Manager dialog.

#### Acceptance Criteria
- [ ] Pressing Apple on iOS launches native Apple dialog.
- [ ] Pressing Google on Android launches native Google Credential Manager sheet.
- [ ] Apple button is absent on Android.
- [ ] Cancelling native dialog shows no error alert or toast.
- [ ] Component tests pass in `vitest`.
- [ ] Manual smoke test passes on physical iOS and Android hardware.

---

### Phase 5: Automated Tests, Contract Verification, and Workspace Verification

**Dependencies**: Phase 1, Phase 2, Phase 3, Phase 4

#### Objective
Execute full automated test suites across all packages, verify contract invariants (multi-audience, nonce validation, account linking), and update operator self-hosting documentation.

#### Files to Create / Modify
- `packages/auth/tests/config/social-auth.test.ts`:
  - Full end-to-end integration tests in PGlite:
    - ID token verification $\to$ session creation $\to$ `GET /api/auth/token` JWT minting $\to$ JWKS validation.
    - Multi-audience validation: both `chat.ansari.app` and `APPLE_CLIENT_ID` succeed for Apple.
    - Nonce validation: replayed token with missing or mismatched nonce fails with 401.
    - Account linking: user registered with email/password signs in with Google/Apple ID token sharing the same email; asserts single `auth.users` row and linked `auth.account` row.
    - Negative tests: tampered JWT signature, expired token, mismatched audience, missing email claim.
- `docs/self-hosting.md`:
  - Document setup steps for:
    - Google Cloud Console: OAuth Web Client ID, authorized JavaScript origins, Android package name.
    - Apple Developer Portal: Services ID, Domains and Return URLs (for popup mode), iOS Bundle ID, Apple Key.
- Monorepo gate verification.

#### Deliverables
- [ ] Complete automated test suite covering positive and negative cases.
- [ ] Documentation updated in `docs/self-hosting.md`.
- [ ] All workspace checks pass cleanly.

#### Acceptance Criteria
- [ ] `pnpm --filter @ansari/auth test` passes (all PGlite tests green).
- [ ] `pnpm --filter ansari-frontend test` passes (including Android button omission test).
- [ ] `pnpm --filter ansari-frontend build:web` succeeds.
- [ ] Workspace-wide commands pass: `pnpm typecheck`, `pnpm lint`, `pnpm test`.

---

## Verification Checklist

| Layer | Check | Command | Target Outcome |
| :--- | :--- | :--- | :--- |
| **Auth Package** | PGlite social auth tests | `pnpm --filter @ansari/auth test` | Multi-audience, nonce, and account linking pass |
| **Frontend Unit** | AuthSheet & component tests | `pnpm --filter ansari-frontend test` | All tests pass, Apple hidden on Android |
| **Web Build** | Metro web export | `pnpm --filter ansari-frontend build:web` | Compiles `dist/` cleanly |
| **Real Device iOS** | Physical iPhone dev build | `npx expo run:ios --device` | Apple and Google sheets open natively |
| **Real Device Android** | Physical Android dev build | `npx expo run:android --device` | Google Credential Manager opens natively |
| **Workspace Lint** | ESLint across packages | `pnpm lint` | 0 errors |
| **Workspace Types** | TypeScript typecheck | `pnpm typecheck` | 0 errors |
| **Workspace Tests** | Full test suite | `pnpm test` | All suites green |

---

## Rollback & Failure Modes

- **Invalid / Replayed ID Token**: If signature is invalid, token is expired, or nonce does not match, returns 401 `INVALID_TOKEN`. Client displays inline error: "Unable to verify sign-in credentials. Please try again."
- **Unverified Provider Email**: Fails closed with 401 `USER_EMAIL_NOT_FOUND`. Account is not created.
- **Provider Outage / Network Error**: Client catches network failure, preserves typed fields, and displays inline error notice.
- **Missing Google Play Services (Android)**: Handled gracefully by `react-native-nitro-google-signin`, surfacing an actionable error without crashing the app.
- **OAuth Credentials Unset on Server**: If self-hoster has not provided Google/Apple credentials, `socialProviders` is inactive; email/password authentication and guest mode continue to function normally.
