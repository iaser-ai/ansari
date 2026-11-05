# Specification: Native Google and Apple Authentication (Mobile & Web)

<!--
SPEC vs PLAN BOUNDARY:
This spec defines WHAT and WHY. The plan defines HOW and WHEN.
Implementation phases, detailed code changes, and sequencing live in codev/plans/324-*.md.
-->

## Metadata

- **ID**: spec-324-native-google-apple-auth
- **Status**: draft (in review — PR #328)
- **Created**: 2026-10-25
- **Source**: GitHub issue #324 (`iaser-ai/ansari#324`)
- **Protocol**: PIR

---

## Owner & Architect Guidance (Review Amendments)

1. **Native Modules on Mobile (Non-Negotiable)**: On native iOS and Android, third-party authentication **must use native modules**, not web browser redirects (`expo-web-browser`, Custom Tabs, or `ASWebAuthenticationSession`). Tapping "Continue with Apple" or "Continue with Google" must trigger the OS-native dialogs directly (`expo-apple-authentication` for Apple on iOS; `react-native-nitro-google-signin` for Google on Android and iOS).
2. **Cookie-Free Web ID-Token Flow**: The frontend client (`apps/frontend/lib/auth/api.ts`) is strictly cookie-free (`credentials: 'omit'`). Web social authentication must therefore **not** use browser redirects; instead, it uses in-page ID token acquisition:
   - **Google on Web**: Uses Google Identity Services (GIS). Because GIS only issues ID tokens through its rendered button or One Tap, the web Google button is Google's own rendered button (themed to fit Ansari's design), not a custom `ProviderButton`.
   - **Apple on Web**: Uses `AppleID.auth.signIn({ usePopup: true })`, passing the first-sign-in user name as `idToken.user`.
   - Both return an ID token in the page and POST to the exact same `POST /api/auth/sign-in/social` endpoint as mobile, which answers with the `sessionToken` in the response body.
3. **Platform-Specific Button Visibility**:
   - **iOS**: Renders both "Continue with Apple" and "Continue with Google" (Apple first, per Apple HIG).
   - **Android**: Renders **Google only**. "Continue with Apple" must not appear on Android (`Platform.OS !== 'android'`).
   - **Web**: Renders both (Google via GIS rendered button; Apple via popup button).
4. **Cryptographic Nonce (Replay Protection)**: Every sign-in attempt (native iOS, native Android, and web) must generate a fresh cryptographic `nonce` per attempt and include it with the provider request and the ID token verification payload, ensuring captured tokens cannot be replayed.
5. **Modern Identity Frameworks (Nitro Modules)**: Google authentication on mobile uses `react-native-nitro-google-signin` (Nitro Modules / JSI), which leverages Android's modern Credential Manager (`GetSignInWithGoogleOption`) rather than deprecated legacy Play Services Auth, and the native Google Sign-In SDK on iOS. Google services files (`google-services.json` / `GoogleService-Info.plist`) are optional when an explicit `webClientId` is provided.
6. **Apple Audiences (Web & iOS)**: The backend Apple verifier must accept both `chat.ansari.app` (iOS Bundle ID) and `APPLE_CLIENT_ID` (Web Services ID).
7. **Apple HIG & App Store Compliance**: Apple Sign-In is required on iOS under App Store Review Guideline 4.8 because the app offers third-party authentication. Button appearance and placement must strictly conform to Apple's Human Interface Guidelines.
8. **Two-Token Protocol Parity**: Social sign-in must integrate seamlessly into the monorepo's existing two-token architecture established in #300. Sessions created via Google or Apple receive a Better Auth `sessionToken` and exchange it for an `apps/api` EdDSA JWT via `GET /api/auth/token`.
9. **No Disruption to Existing Auth**: Existing email/password authentication, password reset, guest account auto-provisioning, and account deletion contracts must remain unchanged.

---

## Problem Statement

In issue #245, "Continue with Apple" and "Continue with Google" buttons were introduced to the sign-in sheet (`apps/frontend/components/AuthSheet.tsx`) as presentational UI stubs above the email/password form. When pressed, they currently display an inline notice that the provider is unavailable.

Inspection of the authentication architecture reveals the underlying gaps:

1. **Backend Service (`apps/auth` & `packages/auth`)**:
   - Configures Better Auth solely with `emailAndPassword`. The `socialProviders` configuration is completely absent from `packages/auth/src/index.ts`.
   - `packages/auth/src/env.ts` has no environment variables declared for Google or Apple client IDs or secrets.
   - The backend does not yet validate native OpenID Connect / ID tokens sent directly from mobile SDKs or web JS clients.
2. **Frontend App (`apps/frontend`)**:
   - `lib/auth/api.ts` only supports email/password operations (`/sign-in/email`, `/sign-up/email`). All requests use `credentials: 'omit'` (no cookies anywhere); the app reads `sessionToken` from the response body and sends it as `Authorization: Bearer <sessionToken>`.
   - Browser redirect OAuth breaks this architecture because it relies on server-set cookies on redirect callbacks, which `customFetch` drops.
   - The app has no native authentication modules wired for Apple (`expo-apple-authentication`) or Google (`react-native-nitro-google-signin`).
   - Browser redirect OAuth on mobile introduces poor UX: it switches users out of the application into Safari/Chrome, prompts for third-party cookie permissions, requires deep-link URL scheme handling (`ansarichat://auth/callback`), and fails App Store review standards for frictionless native auth.
   - `AuthSheet.tsx` currently renders "Continue with Apple" unconditionally on all platforms, including Android where Apple Sign-In is unsupported.

### Who is affected and how:
- **Mobile Users (iOS & Android)**: Cannot use single-tap biometric or native OS account sign-in; forced to manually type email and password or remain in unauthenticated guest mode.
- **Product & App Store Release**: Mobile submissions to the Apple App Store will fail Guideline 4.8 if third-party authentication is offered without equivalent native Apple Sign-In support.
- **Web Users**: Cannot use one-tap Google Sign-In or Apple Sign-In within the cookie-free web shell.
- **Security & Infrastructure**: Must ensure incoming third-party tokens are verified fail-closed against provider JWKS/certs with strict audience pinning and per-attempt nonces to prevent token replay attacks.

---

## Current State

Verified directly against the codebase at branch base:

### Backend (`packages/auth` & `apps/auth`)

- **Database Schema (`packages/auth/src/schema.ts`)**:
  - The `auth.account` table already exists with columns suited for OAuth credentials: `id`, `user_id`, `account_id`, `provider_id`, `access_token`, `refresh_token`, `id_token`, `access_token_expires_at`, `refresh_token_expires_at`, `scope`, and a unique constraint on `(user_id, provider_id)`.
  - The `auth.users` table stores `id` (UUID), `email`, `name`, `first_name`, `last_name`, `email_verified`, `image`, and `registered_via`.
  - No database migration is required for social credentials.
- **Better Auth Instance (`packages/auth/src/index.ts`)**:
  - Configures `emailAndPassword`, `session` (30 days, 1-day slide), and plugins: `expo()`, `bearer()`, `jwt()` (EdDSA, 15m expiry), and `admin()`.
  - `trustedOrigins` includes `ansarichat://`, `CORS_ORIGIN`, and dev origins.
  - `socialProviders` is **unset**. Better Auth 1.7.7 provides built-in `verifyProviderIdToken` and `signInSocial` supporting `idToken` payloads at `POST /api/auth/sign-in/social`, but it is currently inactive.
- **Environment Schema (`packages/auth/src/env.ts`)**:
  - Validates `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `CORS_ORIGIN`, `AUTH_LAYER_ORIGIN`, `AUTH_JWT_ISSUER`, `AUTH_JWT_AUDIENCE`, `RESEND_API_KEY`, `FRONTEND_URL`. No OAuth variables exist.

### Frontend (`apps/frontend`)

- **Components (`components/AuthSheet.tsx` & `components/BrandMarks.tsx`)**:
  - Official vector marks `AppleMark` and `GoogleMark` are rendered inside `ProviderButton`.
  - Light and dark styles adhere to Apple HIG and Google branding guidelines.
  - `onPress` sets local state `unavailable` and displays an inline notice.
  - Renders both Apple and Google buttons unconditionally across all platforms (including Android).
- **Client Auth Layer (`lib/auth/`)**:
  - `lib/auth/api.ts` calls `customFetch` for `/sign-in/email`, `/sign-up/email`, `/token`, `/sign-out`, and password reset. Every call uses `credentials: 'omit'`.
  - `lib/auth/context.tsx` provides `AuthProvider`. `startSession()` accepts an `AuthSession`, calls `authApi.mintJwt(sessionToken)`, persists credentials via `saveSession()`, and clears the React Query cache.
  - `lib/auth/store.ts` persists `accessToken`, `sessionToken`, and user names to `expo-secure-store` (native) or `localStorage` (web).

### API Backend (`apps/api`)

- `apps/api` validates incoming `Authorization: Bearer <jwt>` against `apps/auth`'s public JWKS endpoint (`/api/auth/jwks`) statelessly, reading `{ sub, sid }`. It has no dependency on how the session was created and requires no code changes.

---

## Desired State

### 1. Unified Authentication Architecture (Universal ID-Token Path)

All clients (iOS, Android, and Web) use the exact same ID-token exchange contract. No browser redirect callbacks and no cookies are used anywhere.

```
┌────────────────────────────────────────────────────────────────────────┐
│                              FRONTEND                                  │
├───────────────────────────────┬────────────────────────────────────────┤
│     iOS & Android Native      │                  Web                   │
│   (expo-apple-authentication  │   (Google Identity Services iframe     │
│    react-native-nitro-        │    AppleID.auth.signIn popup)          │
│     google-signin)            │                                        │
└───────────────┬───────────────┴───────────────────┬────────────────────┘
                │                                   │
                │ ID Token + Nonce (JSON POST)       │ ID Token + Nonce (JSON POST)
                ▼                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        apps/auth (Better Auth)                         │
│  - POST /api/auth/sign-in/social                                       │
│  - Verifies Apple ID Token via Apple JWKS                              │
│    (aud: chat.ansari.app [iOS] OR APPLE_CLIENT_ID [Web Services ID])   │
│  - Verifies Google ID Token via Google Certs                           │
│    (aud: GOOGLE_CLIENT_ID [Web Client ID])                             │
│  - Verifies payload.nonce matches client nonce (replay protection)    │
│  - Links/creates user in auth.users and auth.account                   │
│  - Issues Better Auth sessionToken (JSON body: { token, user })        │
└───────────────────────────────┬────────────────────────────────────────┘
                                │ GET /api/auth/token
                                │ (Bearer sessionToken, credentials: 'omit')
                                ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        apps/auth JWT Engine                            │
│  - Mints 15-minute EdDSA JWT containing { sub: user.id, sid }          │
└───────────────────────────────┬────────────────────────────────────────┘
                                │
                                ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        apps/frontend Storage                           │
│  - Persists sessionToken & accessToken in SecureStore / localStorage   │
│  - Attaches Bearer accessToken to all apps/api calls                   │
└────────────────────────────────────────────────────────────────────────┘
```

### 2. Platform-Specific Button Visibility Matrix

`AuthSheet.tsx` conditionally renders buttons based on `Platform.OS`:

| Platform | Buttons Shown | Implementation |
| :--- | :--- | :--- |
| **iOS** | **Apple** (primary, top) + **Google** (secondary) | `expo-apple-authentication` + `react-native-nitro-google-signin` |
| **Android** | **Google only** | `react-native-nitro-google-signin` (Apple button hidden) |
| **Web** | **Apple** + **Google** | Apple JS popup (`AppleID.auth.signIn`) + Google Identity Services (GIS rendered button) |

### 3. Cryptographic Nonce Generation & Replay Protection

Before initiating any sign-in flow, the frontend generates a random cryptographic nonce:
- Uses `crypto.getRandomValues(new Uint8Array(32))` (or `expo-crypto` on native).
- On Apple: sends raw or SHA-256 hashed nonce to Apple's auth SDK.
- On Google: passes nonce to Google SDK / GIS.
- Sent in the sign-in request body:
  ```json
  {
    "provider": "apple" | "google",
    "idToken": {
      "token": "<id_token_jwt>",
      "nonce": "<raw_nonce_string>",
      "user": { ... }
    }
  }
  ```
- Backend (`apps/auth`): Better Auth's `verifyProviderIdToken` verifies that `payload.nonce` in the decoded ID token matches the supplied nonce. A captured ID token cannot be replayed without the nonce matching.

### 4. Native Mobile Authentication (iOS & Android)

- **Apple Sign-In (iOS)**:
  - Uses `expo-apple-authentication`.
  - When pressed, checks `AppleAuthentication.isAvailableAsync()`. On iOS 13+, generates nonce $N$ and invokes `AppleAuthentication.signInAsync({ requestedScopes: [FULL_NAME, EMAIL], nonce: hash(N) })`.
  - Retrieves `identityToken` (Apple-signed JWT) and `fullName` (`givenName`, `familyName`).
  - Calls `POST /api/auth/sign-in/social` with payload:
    ```json
    {
      "provider": "apple",
      "idToken": {
        "token": "<apple_identity_token>",
        "nonce": "<raw_nonce>",
        "user": {
          "name": {
            "firstName": "<givenName>",
            "lastName": "<familyName>"
          }
        }
      }
    }
    ```
  - Never opens a browser window, Custom Tab, or `ASWebAuthenticationSession`.
- **Google Sign-In (Android & iOS)**:
  - Uses `react-native-nitro-google-signin` (powered by Nitro Modules / JSI, integrating Android Credential Manager and native iOS Google Sign-In SDK).
  - Initialized with `GoogleOneTapSignIn.configure({ webClientId: GOOGLE_WEB_CLIENT_ID })`. Google services files (`google-services.json` / `GoogleService-Info.plist`) are optional because the explicit `webClientId` and iOS URL scheme provide full configuration.
  - Invokes `GoogleOneTapSignIn.signIn()` which renders the OS-native Google account picker sheet (One Tap / Credential Manager).
  - Retrieves `idToken` from response and calls `POST /api/auth/sign-in/social` with payload:
    ```json
    {
      "provider": "google",
      "idToken": {
        "token": "<google_id_token>",
        "nonce": "<raw_nonce>"
      }
    }
    ```
  - Never opens an in-app browser (`expo-web-browser`) or Custom Tabs.
- **Cancellation & Failure UX**:
  - If a user cancels or dismisses the native dialog (e.g. `ERR_REQUEST_CANCELED` on Apple or user cancellation on Google), the sheet remains open without an error banner.
  - If network or server verification fails, an inline error banner is displayed in `AuthSheet`.

### 5. Web Social Authentication (Cookie-Free)

- **Google on Web**:
  - Google Identity Services (GIS) only issues ID tokens through its official rendered button or One Tap.
  - The Web Google button in `AuthSheet` mounts Google's rendered button via `google.accounts.id.renderButton` (styled with `theme: 'outline'`, shape `pill`, size `large` to match Ansari's design system).
  - GIS triggers an in-page callback with `response.credential` (the Google `idToken`).
  - Frontend posts the token and nonce to `POST /api/auth/sign-in/social`, receives `{ token: sessionToken }` in JSON, and calls `startSession()`.
- **Apple on Web**:
  - Initializes `AppleID.auth.init({ clientId: APPLE_CLIENT_ID, scope: 'name email', redirectURI: FRONTEND_URL, usePopup: true, nonce: N })`.
  - Tapping "Continue with Apple" calls `AppleID.auth.signIn()`.
  - On first sign-in, Apple returns `{ authorization: { id_token }, user: { name: { firstName, lastName } } }`.
  - Frontend posts to `POST /api/auth/sign-in/social` with `idToken.token`, `idToken.nonce`, and `idToken.user`, receives `sessionToken` in JSON, and calls `startSession()`.

### 6. Backend ID Token Verification & User Resolution

- **ID Token Verification**:
  - `apps/auth` verifies incoming `idToken`s fail-closed against provider official public keys:
    - Apple: `https://appleid.apple.com/auth/keys`. Validates `iss === 'https://appleid.apple.com'`, non-expired, and `aud` matches either `chat.ansari.app` (iOS native Bundle ID) **or** `APPLE_CLIENT_ID` (Web Services ID).
    - Google: `https://www.googleapis.com/oauth2/v3/certs`. Validates `iss` in `['accounts.google.com', 'https://accounts.google.com']`, non-expired, and `aud` matches `GOOGLE_CLIENT_ID` (Web Client ID).
  - Validates `nonce` claim against client nonce.
- **Account Linking & Collision Policy**:
  - Both Google and Apple guarantee email verification (`email_verified: true`).
  - If an account already exists in `auth.users` with the same email (e.g. created via email/password or guest promotion):
    - The provider account row is linked in `auth.account` under the same `user_id`.
    - No duplicate user row is created.
    - Password authentication continues to work for that user.
- **Name Handling & Apple Special Case**:
  - Apple only returns `fullName` on the **first authorization**. Subsequent Apple logins omit the name.
  - On first sign-in, any provided `firstName` and `lastName` must be immediately saved to `auth.users`.
  - Apple Private Relay emails (`@privaterelay.appleid.com`) are treated as valid unique email addresses and saved as-is.
- **Client Attribution**:
  - User creation hooks inspect `X-Ansari-Client` to stamp `registered_via` (`ios`, `android`, or `web`).

### 7. Two-Token Protocol Parity

- The response from `apps/auth` contains the Better Auth `sessionToken` and user details in the JSON body:
  ```json
  {
    "redirect": false,
    "token": "<sessionToken>",
    "user": { "id": "<uuid>", "email": "...", "name": "..." }
  }
  ```
- Frontend calls `authApi.mintJwt(sessionToken)` (`GET /api/auth/token` with `Authorization: Bearer <sessionToken>`) to obtain the 15-minute `apps/api` EdDSA JWT.
- Tokens are saved to `expo-secure-store` (native) or `localStorage` (web).
- When `apps/api` returns `401`, the existing single-flight `refresh()` routine calls `GET /api/auth/token` with `sessionToken` and obtains a fresh JWT without user interruption.

---

## Stakeholders

- **Mobile Users (iOS & Android)**: Seamless one-tap native sign-in without leaving the app; clean platform-appropriate buttons (no Apple button on Android).
- **Web Users**: In-page one-tap Google and Apple sign-in without clunky browser redirects or broken cookie states.
- **App Review Teams (Apple App Store / Google Play)**: Full compliance with Apple Guideline 4.8 and Google Play Services standards.
- **Security & Engineering Maintainers**: Robust ID token signature verification, multi-audience support, nonces preventing replay attacks, and clean separation between auth sessions and API access tokens.

---

## Success Criteria

- [ ] **Native Apple Sign-In (iOS)**:
  - Tapping "Continue with Apple" on iOS launches the native system sheet via `expo-apple-authentication`.
  - No web browser, custom tab, or Safari view controller is ever opened.
  - Nonce is generated per attempt and verified by `apps/auth`.
  - Successful sign-in creates or links the user, securely storing tokens in `expo-secure-store`.
  - Works with Apple Private Relay emails (`@privaterelay.appleid.com`).
  - User names provided on first sign-in are captured in `auth.users`.
- [ ] **Native Google Sign-In (Android & iOS)**:
  - Tapping "Continue with Google" on Android and iOS launches the native account picker via `react-native-nitro-google-signin` (Nitro Modules / Credential Manager).
  - No web browser or Custom Tab is opened on mobile devices.
  - Nonce is generated per attempt and verified by `apps/auth`.
  - Successfully verifies `idToken` on `apps/auth` and creates/links the user.
- [ ] **Android Button Visibility**:
  - `AuthSheet` on Android displays only the Google sign-in button. The Apple button is absent from the component tree.
  - A component test proves the Apple button is never rendered when `Platform.OS === 'android'`.
- [ ] **Web Social Sign-In (Cookie-Free ID-Token Flow)**:
  - Google on Web renders GIS official button and issues in-page ID token without full-page navigation.
  - Apple on Web triggers `AppleID.auth.signIn({ usePopup: true })` and issues in-page ID token and first-time name without full-page navigation.
  - Backend returns `sessionToken` in the response body; frontend saves token to `localStorage` and mints API JWT.
- [ ] **Two-Token Parity**:
  - All social sign-ins produce a Better Auth `sessionToken` and immediately mint an `apps/api` EdDSA JWT.
  - Requests to `apps/api` (`/api/v2/threads`, SSE streaming) succeed with the minted JWT.
  - 401 token refresh functions identically to email/password sessions.
- [ ] **Account Linking**:
  - Signing in with Google or Apple using an email already registered via email/password links the provider account without errors or orphaned duplicate users.
  - A user with both email/password and social login can sign in with either credential to access the exact same account.
- [ ] **Cancellation UX**:
  - User dismissing the native Apple or Google dialog leaves the `AuthSheet` intact without displaying an error alert.
- [ ] **Negative / Error Handling Tests**:
  - ID token with an invalid cryptographic signature returns 401 `INVALID_TOKEN`.
  - ID token with expired timestamp returns 401 `INVALID_TOKEN`.
  - ID token with mismatched audience returns 401 `INVALID_TOKEN`.
  - ID token with invalid/mismatched nonce returns 401 `INVALID_TOKEN`.
  - Provider returning no verified email fails closed with 401 `USER_EMAIL_NOT_FOUND`.
- [ ] **Automated Testing & Real Device Verification**:
  - Real DB (pglite) tests in `packages/auth` asserting ID token verification (both iOS bundle ID and Web Services ID audiences), account linking, nonce verification, and JWT minting.
  - Frontend component tests in `apps/frontend` verifying button handlers, cancellation safety, and Android Apple-hiding.
  - Real-device manual check: development build tested on a physical iPhone and physical Android phone.
  - Monorepo checks pass: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.

---

## Constraints

1. **Native-Only on Mobile**: Mobile platforms must never fall back to browser redirects for Google or Apple.
2. **App Store Guideline 4.8**: Apple Sign-In button must use Apple's standard design rules and must be positioned prominently on iOS.
3. **Cookie-Free Architecture**: No cookies may be required for web social authentication; all session management relies on Bearer tokens returned in response bodies.
4. **EAS Prebuild / Native Config**:
   - `expo-apple-authentication` requires the config plugin and Apple Developer entitlement (`com.apple.developer.applesignin`).
   - `react-native-nitro-google-signin` requires `react-native-nitro-modules` and the config plugin (`"react-native-nitro-google-signin"` in `app.json`).
   - Google Services files (`google-services.json` / `GoogleService-Info.plist`) are optional when `webClientId` is explicitly supplied.
5. **Secret Management**:
   - No client secrets may be bundled in the native mobile apps or exposed to client browsers.
   - Provider credentials (`GOOGLE_CLIENT_SECRET`, Apple private keys) live strictly on the backend (`apps/auth`).
6. **Database Conventions**:
   - Zero schema migrations needed (`auth.account` already contains all necessary columns: `provider_id`, `id_token`, etc.). Any future schema modifications must strictly use `drizzle-kit generate` (never `db:push`).
7. **No Anonymous API Bypass**: `apps/api` continues to require a valid Bearer JWT on all protected routes; social auth changes only how sessions are established on `apps/auth`.

---

## Assumptions

1. **Token Cryptography**: Apple and Google issue standard OpenID Connect compliant JWTs whose signatures are verifiable against their published JWKS endpoints (`https://appleid.apple.com/auth/keys` and `https://www.googleapis.com/oauth2/v3/certs`).
2. **Audience Configuration**:
   - For Apple on iOS: `aud` equals `chat.ansari.app` (the iOS Bundle ID).
   - For Apple on Web: `aud` equals `APPLE_CLIENT_ID` (the Apple Services ID).
   - For Google: `aud` equals `GOOGLE_CLIENT_ID` (the Web Client ID configured in Google Cloud Console and passed to `react-native-nitro-google-signin` and GIS).
3. **Portal & Console Registrations**:
   - Google Cloud Console: JavaScript origins authorized for web (`http://localhost:8081`, web domain).
   - Apple Developer Portal: Apple Services ID configured with domains and return URLs.
4. **Email Verification Guarantee**: Google and Apple ID tokens only carry emails that have been verified by the respective identity provider (`email_verified: true`), allowing automatic account linking by email.
5. **Availability on Devices**:
   - Apple Authentication is available on iOS devices running iOS 13+.
   - Google Sign-In is supported on Android devices with Google Play Services (via Credential Manager) and iOS devices running modern iOS.
6. **Stateless API Gateway**: `apps/api` requires zero code modifications or deployments for this feature, as it verifies EdDSA JWTs minted by `apps/auth` statelessly.

---

## Out of Scope

- Additional third-party OAuth providers (GitHub, Microsoft, Facebook, etc.).
- Changes to email/password authentication or guest auto-provisioning rules.
- Account unlinking UI in settings (deferred to future account management features).
