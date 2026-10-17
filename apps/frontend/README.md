# Ansari — frontend (`apps/frontend`)

The Ansari app: an Expo (SDK 57, React Native 0.86, React 19.2) client for
iOS, Android and web (react-native-web), on the **Replit-sourced design**
(dark mode, collapsible sidebar, source panel, a motion/layout/radius token
system) and **wired end-to-end to this repo's backend** (`apps/api`) — auth,
real thread history, and incremental streaming chat.

It is a member of the pnpm workspace (package `ansari-frontend`) and the
Turborepo task graph: CI runs its lint, typecheck, test and build. Until
issue #262 it lived outside the workspace as the `ansari-expo` prototype under
`prototypes/`, on Expo SDK 54; that history is in the codev records under its
old path.

## How it works: wired to the API (issues #124, #262)

The app went through two rounds of independent divergence from a
common ancestor — an earlier pass that wired it to this repo's real backend
(auth, a hand-built SSE client, an incremental streaming reconciler), and a
separate Replit-hosted pass that rebuilt the entire UI (dark mode, the
sidebar, the source panel). Issue #121 took the Replit design as source of
truth without re-wiring the backend code; **issue #124 reconnected them**.

End to end against `apps/api` (staging by default — see `lib/api/config.ts`):

- Every screen imports the `apps/api` adapter from `@/lib/api` (a drop-in for
  the Replit client's orval hooks: same hook names, same schema
  types). `app/_layout.tsx` resolves the base URL from
  `resolveBaseUrl()` (`EXPO_PUBLIC_API_URL`, defaulting to staging).
- Signing in is a sheet over the current screen (`components/AuthSheet.tsx`,
  raised through `lib/authSheet.ts`): a bottom sheet on a phone, a centred
  dialog on desktop, with Apple/Google buttons that are UI only for now.
  `/login` and `/register` still work as links; they land on `/` with the
  sheet open. `AuthProvider` is mounted in
  `_layout.tsx` and registers the bearer-token + 401-refresh bridges for
  both `custom-fetch` and the SSE path.
- **Sign-in is at `apps/auth`** (`lib/auth/api.ts`, spec 300): sign-in,
  sign-up and sign-out go to `EXPO_PUBLIC_AUTH_URL`, and the session token
  they return is exchanged at `/api/auth/token` for the JWT `apps/api`
  accepts. One bearer transport on web, iOS and Android, no cookies
  (`credentials: 'omit'` on every request); the JWT is attached only to
  `apps/api` requests. A 401 from `apps/api` mints a new JWT from the session
  (single-flight); only a 401 from `/token` signs the device out.
- **Accountless by default, via an auto-provisioned guest.** `apps/api` has
  no true-anonymous path — every thread call needs a bearer token — so on
  first launch (nothing stored) `AuthProvider` silently registers a throwaway
  guest account and caches its credentials; after logging out of a real
  account it drops straight back to that guest. A stored guest is replaced
  only when apps/auth refuses its credentials (401); a rate limit, an outage
  or no network keeps it and surfaces an error. The reader never sees an auth
  screen unless they choose to: "Log in" in the sidebar / the desktop account
  corner raises the sign-in sheet as an optional upgrade, and a real account's name + "Log
  out" then shows in the rail colophon. (Every fresh browser/device mints one
  persistent staging account; see `lib/auth/guest.ts`.)
- Chat streams incrementally: `app/chat/[id].tsx` drives
  `lib/chat-reconcile.ts` / `lib/chat-trace.ts` — a synthetic in-progress
  bubble renders `text` deltas and a live retrieval trace, then hands off to
  the persisted message on `done` with no flicker.

The walk to verify: open a fresh browser (auto-guest, no auth screen) → ask a
question → the answer streams in → open a past thread from the sidebar →
register from "Log in" → the guest's questions are replaced by the new
account's → log out → back to the guest → log back in → the account's thread
is there.

## Development

Install once at the repo root (`pnpm install`; pnpm workspace + Turborepo).
From the repo root:

```bash
pnpm --filter ansari-frontend dev         # expo start (press w / i / a)
pnpm --filter ansari-frontend test        # vitest
pnpm --filter ansari-frontend build:web   # static SPA -> dist/
pnpm --filter ansari-frontend build:icons # regenerate icon rasters + public/ (needs sharp)
```

(`pnpm frontend <script>` is the root alias for the same filter.) Lint and
typecheck run through the graph: `pnpm exec turbo run lint typecheck --filter
ansari-frontend...`. `typecheck` depends on `gen:types` (uniwind codegen), so
run it through turbo, or run `pnpm gen:types` first from this directory.

`lib/api/config.ts` defaults the API and auth base URLs to staging
(`https://api-staging.askansari.ai`, `https://auth-staging.askansari.ai`);
override them together with `EXPO_PUBLIC_API_URL` and `EXPO_PUBLIC_AUTH_URL`
in `.env.local` (see `.env.local.example`). Those are the app's only
environment variables.

Then: home screen (dark-mode-capable, sidebar, ambient palm-shadow layer) →
ask a question and watch the answer stream in → open a past thread from the
sidebar → sidebar collapses/expands (desktop) or opens as a drawer (narrow
width) → open the source panel from a citation → "Log in" (rail or account
corner) → About page.

### Uniwind: installed, wired, unused

`uniwind` and Tailwind are dependencies, `metro.config.js` wraps the config
in `withUniwindConfig` (CSS entry `src/global.css`), and the `gen:types` task
generates `uniwind-types.d.ts` (gitignored; `types.d.ts` and
`uniwind-env.d.ts` are committed). The UI itself is `StyleSheet`-only, and
`app/_layout.tsx` deliberately does **not** import `src/global.css`:
Tailwind's preflight reset would restyle it on the web. Adopting Uniwind
for new UI is a separate product decision.

## What is left of the vendored Replit client

The screens import the `apps/api` adapter from `@/lib/api`, whose hooks keep
the names of the Replit client's orval hooks (`useCreateConversation`,
`useSendMessage`, …). Two vendored files are still live:

- `vendor/api-client-react/custom-fetch.ts` — the fetch runtime (base URL +
  bearer attach, `ApiError`, and the React Native `response.body`
  workaround), used by `lib/api/` and `lib/auth/`.
- `vendor/api-client-react/generated/api.schemas.ts` — types only
  (`Citation`, `Message`, `SafetySignal`, …), re-exported by
  `lib/api/types.ts`.

The orval hooks (`generated/api.ts`), the client's barrel and the
`@workspace/api-client-react` alias were unused and were deleted in #262.
Moving `custom-fetch.ts` into `lib/api/` and replacing the generated types
with a shared contract is #264.

## Test runner

Vitest (`pnpm test`), matching the rest of the repo; CI runs it in the
`frontend` job. `vitest.config.ts` aliases `react-native` to
`react-native-web` and `@` to this directory; component tests opt into jsdom
per file. The 3 Replit
`lib/*.test.ts` files (`ambientNight.test.ts`, `keyboard.test.ts`,
`markdown.test.ts`) were ported from Replit's `node --test` syntax to
vitest's `describe`/`expect`/`it`. `lib/api/`, `lib/auth/`,
`lib/chat-reconcile.test.ts`, and `lib/chat-trace.test.ts` are untouched and
still pass — they don't depend on anything this port changed.

## Auth & token storage

`lib/auth/` (secure token store, session context with refresh-on-401, guest
login) is mounted by `app/_layout.tsx`'s `<AuthProvider>`. On startup with no
stored session it auto-provisions a guest (see "Current state" above); the
sign-in sheet (`components/AuthSheet.tsx`) is an optional upgrade
to a real account. Tokens are held in `expo-secure-store` on native and
`localStorage` on web; a 401 mid-request triggers one single-flight refresh,
and a failed refresh drops back to the device's guest identity. The guest's
email + password persist across logout (`store.ts`) so a device keeps one
guest account rather than minting a new staging user each time. See
`lib/auth/context.tsx` and its tests.

## Source + SHA

- **Design**: imported from a Replit build at local path
  `~/Downloads/Ansari`, `artifacts/ansari/`, upstream commit **`6c58e51`**
  ("Rebuild icons from Figma artwork").
- **API client vendoring** (unchanged from the earlier import): a separate
  Replit pnpm monorepo, source commit `896cd4c` — only the Expo app
  (`artifacts/ansari/`) and the React API client it depended on
  (`lib/api-client-react/src/` → `vendor/api-client-react/`) were imported.
  The vendored client's runtime (`custom-fetch.ts`: base URL + bearer
  wiring, and the React Native `response.body` workaround) is reused by
  `lib/api/` and `lib/auth/`; the client's hooks and barrel were deleted in #262.

## The SDK 54 → 57 port (issue #262)

Pages and components moved verbatim from the SDK 54 prototype, except
for five changes the upgrade forced or exposed:

| Change | Why |
|---|---|
| `StyleSheet.absoluteFillObject` → `StyleSheet.absoluteFill` | RN 0.86 removed it; on native it spread `undefined` (react-native-web still had it, so the web hid the break) |
| `NavigationBar.setButtonStyleAsync` → `NavigationBar.setStyle` | removed in expo-navigation-bar 57; it would throw on Android launch |
| `ThemeProvider`, themes and `useIsFocused` imported from `expo-router` | expo-router 57 vendors react-navigation; the separate `@react-navigation/native` package is a different context (error boundary on web) |
| `Sidebar`'s `style` prop typed as `Animated.View`'s | reanimated 4.5 typing |
| `composerBottomPad` (`constants/layout.ts`) marked `'worklet'` | both screens call it inside `useAnimatedStyle`, which runs on the UI thread on native; unmarked, it threw "Tried to synchronously call a Remote Function". Pre-existing since #121; `lib/worklets.test.ts` now scans every worklet body for unmarked calls |

The React Compiler lint rules from eslint-config-expo 57 are warnings for
now (see `eslint.config.mjs`); fixing them is part of #264.

## Builds

### Native (EAS)

The app builds on [EAS](https://expo.dev/eas) as `@ansari-project/ansari-chat`,
with the legacy store app's identity (`legacy/frontend-app/app.json`): name
"Ansari", bundle id / package `chat.ansari.app`, scheme `ansarichat`
(`packages/auth`'s Better Auth `trustedOrigins` must carry the same scheme).

**Native builds and over-the-air updates go through GitHub Actions.** The
workflows dispatch EAS Build / EAS Update for the profiles and channels in
`eas.json`; see [RELEASE.md, "Native builds and updates"](../../RELEASE.md#native-builds-and-updates)
(added by #268 / PR #269) for the profiles, the environments and who approves
production.

> ⚠️ The `production` channel (`eas update --channel production`) and
> `eas submit` reach real users. Day-to-day work uses `development` /
> `preview`.

**Debugging only — local EAS commands.** When you need to reproduce a build
problem on your own machine, the CLI still works directly. It is not the
supported release path:

```bash
eas build --profile development --platform ios   # local dispatch, debugging only
eas submit --platform android --profile production   # reaches real users — don't, outside a release
```

`eas submit` (Play Store) needs `google-service-account/service-account.json`
locally — gitignored, never committed.

### Web

`pnpm build:web` exports a static SPA to `dist/` (`expo export`), using the
custom shell in `public/index.html`. Deployment is a Caddy-served Docker
image (`Dockerfile.web`, built from the repo root:
`docker build -f apps/frontend/Dockerfile.web .`) on Railway; `railway.toml`
is the reviewable record of the dashboard settings. `EXPO_PUBLIC_API_URL` and
`EXPO_PUBLIC_AUTH_URL` are baked in at build time — set both on the Railway
service, for the same environment (or leave both unset for the staging
defaults); changing either requires a redeploy.

## Layout

```
apps/frontend/
  app/                       Expo Router screens (index, chat/[id], about,
                              login, register, _layout)
  components/                UI components (StyleSheet.create): sidebar, source
                              panel, chat, chrome, sign-in sheet, shared primitives
  constants/                 colors (incl. dark mode), motion, radius, layout tokens
  hooks/                     fonts, keyboard, color scheme, sidebar/source-panel state
  lib/                       design helpers (ambientNight, hijri, haptics, toast, ...)
  lib/api/                   the apps/api adapter (imported from screens as @/lib/api)
  lib/auth/                  token store, session context, auth API, guest login
  lib/chat-reconcile.ts,     the PIR #65 streaming reconciler, wired into
  lib/chat-trace.ts          app/chat/[id].tsx
  lib/document-citations.ts  apps/api /threads/{id}/documents (spec 168) → Citation[], resolving the model's [N] markers
  lib/sample-citations.ts    khushu' fallback demo citations (consumed by lib/api/mappers.ts)
  lib/suggested-topics.ts    static suggested-questions list (consumed by lib/api/hooks.ts)
  assets/                    redrawn icons, ambient-shadow video
  public/                    web shell: index.html, fonts, icons, manifest (scripts/build-icons.mjs)
  src/global.css             Uniwind/Tailwind CSS entry (wired, not imported; see above)
  vendor/api-client-react/   custom-fetch.ts (fetch runtime) + generated/api.schemas.ts (types); see above
```
