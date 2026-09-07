# Ansari Expo prototype

An Expo (SDK 54) mobile/web prototype of the Ansari app, on the
**Replit-sourced dark-mode design** (dark mode, collapsible sidebar, source
panel, a motion/layout/radius token system) and **wired end-to-end to this
repo's staging backend** (`apps/api`) — auth, real thread history, and
incremental streaming chat.

It lives in `prototypes/` and is deliberately **outside** the pnpm workspace
and the Turborepo task graph (`pnpm-workspace.yaml` globs only `apps/*` and
`packages/*`). Do **not** move it under `apps/`, add it to the workspace, or
wire it into CI — it targets a different toolchain and installs its own
isolated `node_modules`.

## Current state: wired to staging (issue #124)

This prototype went through two rounds of independent divergence from a
common ancestor — an earlier pass that wired it to this repo's real backend
(auth, a hand-built SSE client, an incremental streaming reconciler), and a
separate Replit-hosted pass that rebuilt the entire UI (dark mode, the
sidebar, the source panel). Issue #121 took the Replit design as source of
truth without re-wiring the backend code; **issue #124 reconnected them**.

End to end against `apps/api` (staging by default — see `lib/api/config.ts`):

- Every screen imports the `apps/api` adapter from `@/lib/api` (a drop-in for
  the vendored `@workspace/api-client-react`: same hook names, same schema
  types). `app/_layout.tsx` resolves the base URL from
  `resolveBaseUrl()` (`EXPO_PUBLIC_API_URL`, defaulting to staging).
- `app/login.tsx` / `app/register.tsx` are back, rebuilt in the dark-mode
  token language (`components/AuthForm.tsx`). `AuthProvider` is mounted in
  `_layout.tsx` and registers the bearer-token + 401-refresh bridges for
  both `custom-fetch` and the SSE path.
- **Ansari works signed-out** — `apps/api` serves guest and anonymous
  threads — so there is no forced redirect. "Log in" in the sidebar / the
  desktop account corner opens the auth screen as an optional add-on;
  signed-in state (name + Log out) shows in the rail colophon.
- Chat streams incrementally: `app/chat/[id].tsx` drives
  `lib/chat-reconcile.ts` / `lib/chat-trace.ts` — a synthetic in-progress
  bubble renders `text` deltas and a live retrieval trace, then hands off to
  the persisted message on `done` with no flicker.

The walk to verify: register → ask a question → the answer streams in → open
a past thread from the sidebar → log out → log back in → the thread is still
there.

## Known gaps from the port

- **Web fonts.** Native builds load the real Amiri/Inter/Literata faces via
  `useAppFonts.ts` (`useFonts`). On web, `useAppFonts.web.ts` returns `true`
  unconditionally — in the Replit source this was safe because
  `public/index.html` preloaded real `@font-face` declarations for all three
  families. That `public/` directory wasn't ported (it's Replit's own
  hosting layer), so **the web build currently falls back to a system font**
  until a repo-appropriate font-loading strategy is added.

## Quick start

```bash
cd prototypes/ansari-expo
pnpm install --ignore-workspace   # see note below — the flag matters
pnpm start                        # expo start
```

Or, from the repo root, use the convenience alias — it runs the
`--ignore-workspace` install (a fast no-op once `node_modules` is current)
and then `expo start` for you:

```bash
pnpm prototype
```

`lib/api/config.ts` defaults the API base URL to staging
(`https://api-staging.askansari.ai`); override with `EXPO_PUBLIC_API_URL` in
`.env.local` (see `.env.local.example`).

Then: home screen (dark-mode-capable, sidebar, ambient palm-shadow layer) →
ask a question and watch the answer stream in → open a past thread from the
sidebar → sidebar collapses/expands (desktop) or opens as a drawer (narrow
width) → open the source panel from a citation → "Log in" (rail or account
corner) → About page.

> **Why `--ignore-workspace` is required.** This prototype sits inside the
> repo, which is a pnpm workspace. On `pnpm install`, pnpm walks UP the
> directory tree, finds the root `pnpm-workspace.yaml`, and installs **that
> workspace** (its `apps/*` + `packages/*`) — not the package in your current
> directory. Since `prototypes/` isn't matched by the workspace globs, the
> prototype's own `package.json` is skipped entirely and no `node_modules` is
> created here. `--ignore-workspace` tells pnpm to ignore that root workspace
> file and treat this directory as a standalone project, so it installs
> *these* dependencies into an isolated `node_modules` here. That
> `node_modules`, any lockfile it writes, and `.expo/` are gitignored — and
> the root `pnpm-lock.yaml` is never touched.

## The `@workspace/api-client-react` alias

The screens import the `apps/api` adapter from `@/lib/api`. `lib/api/`'s
barrel is a drop-in for the vendored `@workspace/api-client-react` — the same
hook names (`useCreateConversation`, `useSendMessage`, …) and the same
generated types (`Citation`, `Message`, `SafetySignal`), which
`lib/api/types.ts` re-exports straight from
`vendor/api-client-react/generated/api.schemas.ts`.

The bare `@workspace/api-client-react` specifier still resolves — via a
`tsconfig.json` `paths` entry and a matching Metro `resolver.extraNodeModules`
entry — but **nothing in `app/` or `components/` imports it any more**.
`lib/api/` and `lib/auth/` reuse the vendored *runtime* (`custom-fetch.ts`:
base URL + bearer attach, and the React Native `response.body` workaround)
under the `@/vendor/...` alias. Removing the bare-specifier alias is a
separate cleanup.

## Test runner

Vitest (`pnpm test`), matching the rest of the repo. The 3 Replit
`lib/*.test.ts` files (`ambientNight.test.ts`, `keyboard.test.ts`,
`markdown.test.ts`) were ported from Replit's `node --test` syntax to
vitest's `describe`/`expect`/`it`. `lib/api/`, `lib/auth/`,
`lib/chat-reconcile.test.ts`, and `lib/chat-trace.test.ts` are untouched and
still pass — they don't depend on anything this port changed.

## Auth & token storage

`lib/auth/` (secure token store, session context with refresh-on-401, guest
login) is mounted by `app/_layout.tsx`'s `<AuthProvider>` and reached through
`app/login.tsx` / `app/register.tsx` (`components/AuthForm.tsx`). Tokens are
held in `expo-secure-store` on native and persisted storage on web; a 401
mid-request triggers one single-flight refresh, and a failed refresh signs
the device out. See `lib/auth/context.tsx` and its tests.

## Source + SHA

- **Design**: imported from a Replit build at local path
  `~/Downloads/Ansari`, `artifacts/ansari/`, upstream commit **`6c58e51`**
  ("Rebuild icons from Figma artwork").
- **API client vendoring** (unchanged from the earlier import): a separate
  Replit pnpm monorepo, source commit `896cd4c` — only the Expo app
  (`artifacts/ansari/`) and the React API client it depended on
  (`lib/api-client-react/src/` → `vendor/api-client-react/`) were imported.
  The vendored client's runtime (`custom-fetch.ts`: base URL + bearer
  wiring, and the React Native `response.body` workaround) is reused by both
  the new design's direct imports and `lib/api/`'s adapter.

## Version gaps a porter into `apps/frontend` will hit

Not defects — the translation list from this snapshot to the real frontend:

| Concern | Prototype | This repo |
|---|---|---|
| Expo SDK | 54 | 57 |
| React Native | 0.81.5 | 0.86.2 |
| TypeScript | 5.9 | 6.0 |
| zod | 3 | 4 |
| Styling | `StyleSheet.create` | uniwind `className` |

## Layout

```
prototypes/ansari-expo/
  app/                       Expo Router screens (index, chat/[id], about,
                              login, register, _layout)
  components/                UI components (StyleSheet.create): sidebar, source
                              panel, chat, chrome, auth form, shared primitives
  constants/                 colors (incl. dark mode), motion, radius, layout tokens
  hooks/                     fonts, keyboard, color scheme, sidebar/source-panel state
  lib/                       design helpers (ambientNight, hijri, haptics, toast, ...)
  lib/api/                   the apps/api adapter (imported from screens as @/lib/api)
  lib/auth/                  token store, session context, auth API, guest login
  lib/chat-reconcile.ts,     the PIR #65 streaming reconciler, wired into
  lib/chat-trace.ts          app/chat/[id].tsx
  lib/sample-citations.ts    sample citation data (consumed by lib/api/mappers.ts)
  lib/suggested-topics.ts    static suggested-questions list (consumed by lib/api/hooks.ts)
  assets/                    fonts, redrawn icons, ambient-shadow video
  vendor/api-client-react/   the imported orval client's runtime (custom-fetch.ts is reused)
```
