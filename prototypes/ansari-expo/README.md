# Ansari Expo prototype

An Expo (SDK 54) mobile/web prototype of the Ansari app, wired to run **end to end
against this repo's real backend** (`apps/api`). You can register, log in, list past
threads, open one, ask a question, and watch the answer stream back.

It lives in `prototypes/` and is deliberately **outside** the pnpm workspace and the
Turborepo task graph (`pnpm-workspace.yaml` globs only `apps/*` and `packages/*`). Do
**not** move it under `apps/`, add it to the workspace, or wire it into CI — it targets a
different toolchain and installs its own isolated `node_modules`.

## Quick start (runs against staging — nothing to run locally)

By default the prototype talks to the deployed **staging** backend
(`https://api-staging.askansari.ai`). You do **not** run a database, and you do **not**
run `apps/api` locally — just start the app:

```bash
cd prototypes/ansari-expo
pnpm install --ignore-workspace   # see note below — the flag matters
pnpm start                        # expo start
```

Then: **register a new account → you're signed in → ask a question → the answer streams
in → open History to see the thread → Log out → log in again → the thread is still there.**

> **Why `--ignore-workspace` is required.** This prototype sits inside the repo, which is a pnpm
> workspace. On `pnpm install`, pnpm walks UP the directory tree, finds the root
> `pnpm-workspace.yaml`, and installs **that workspace** (its `apps/*` + `packages/*`) — not the
> package in your current directory. Since `prototypes/` isn't matched by the workspace globs,
> the prototype's own `package.json` is skipped entirely and no `node_modules` is created here.
> `--ignore-workspace` tells pnpm to ignore that root workspace file and treat this directory as
> a standalone project, so it installs *these* dependencies into an isolated `node_modules` here.
> That `node_modules`, any lockfile it writes, and `.expo/` are gitignored — and the root
> `pnpm-lock.yaml` is never touched.
>
> **Isolation proof:** this PR added dev dependencies to the prototype (`vitest`, `jsdom`,
> `@testing-library/react`, `expo-secure-store`) and the root `pnpm-lock.yaml`,
> `pnpm-workspace.yaml`, `package.json`, and `turbo.json` all stayed **byte-identical** — the
> strongest evidence that `prototypes/` sits outside the workspace.

### ⚠️ Registration creates a REAL staging account

The register screen writes a **real user row into the staging database**, and the tokens
you receive are **real staging credentials**. Use a throwaway email/password. This is fine
for a staging prototype; it is not a sandbox that resets.

### Pointing at a different backend

Set `EXPO_PUBLIC_API_URL` (a full URL, scheme included) in a `.env.local` (gitignored — copy
`.env.local.example`) to override the default, e.g. a personal tunnel or a locally-run
`apps/api`:

```bash
cp .env.local.example .env.local
# EXPO_PUBLIC_API_URL=http://localhost:3000   # then restart `expo start`
```

`EXPO_PUBLIC_*` vars are inlined at bundle time, so restart `expo start` after editing.

## What to expect on screen (and what is empty *by design*)

Against `apps/api`, some UI is intentionally inert — this is **not** a bug:

- **Citations are SAMPLE DATA, not real output.** `apps/api` returns no structured citations,
  so to keep the citation UI demonstrable the adapter attaches a **fixed sample set**
  (`lib/sample-citations.ts`) to the **first assistant answer** of a thread **about khushu'** —
  the one answer those sources support — and to nothing else. Ask *"How can I develop khushu' in
  my prayer?"* to see the source pills, and tap one to open the `CitationSheet`; follow-up
  questions in that thread and every other thread show no citations. These samples are **not
  derived from the answer** above them; real, answer-derived citations arrive with **issue #66**.
  The pills appear in the footnote list only — the model emits no inline `[1]`/`[2]` markers, so
  none are injected into the text.
- **No safety cards.** `apps/api` emits no safety signal, so `SafetySignal` is always `null`
  and `SafetyCard` never appears.
- **Suggested questions are a static, hardcoded list.** They live in
  `lib/suggested-topics.ts`. `apps/api` has no suggested-questions endpoint — don't go
  hunting for one.
- **History search is title-only, client-side.** `apps/api`'s `GET /api/v2/threads` ignores query
  params and returns only `[{thread_id, thread_name, source, created_at, updated_at}]` — no message
  bodies — so the search box filters the loaded threads by **title (`thread_name`) only**, in the
  adapter's list hook. **Message/answer text is not searchable** (matching it client-side would mean
  fetching every thread); this is a deliberate prototype limitation, **not** a bug — don't file
  "search doesn't find message text". Matching is case-insensitive; an unnamed thread
  (`thread_name: null`) matches nothing and clearing the box restores the full list.

Because a correct-but-empty screen and a *broken* integration look identical here, the data
adapter validates every response with **zod and throws on any shape mismatch** (react-query
then shows an error state, never a silently-empty list). See `lib/api/wire-schemas.ts` and
the loud-failure tests in `lib/api/decode.test.ts`. Run them with `pnpm test`.

## Streaming chat — a known PROTOTYPE LIMITATION

The chat answer is delivered over Server-Sent Events. This prototype **buffers the whole
stream and shows a spinner ("Searching the sources…") until the answer is complete**, then
renders it in one go.

**This is a prototype limitation, not the intended UX.** The real app should render tokens
**incrementally** as they arrive. A frontend developer porting this must **not** copy the
spinner-until-done behaviour — the streaming reader (`lib/api/streaming.ts`) already
delivers each `text` event to an `onEvent` callback, which is the seam a live-render
implementation hooks into.

## Auth & token storage

Register/login/refresh/logout hit `apps/api`'s `/api/v2/users/*`. The auth screens also offer
**Continue as guest** (mirroring the main app), which signs you in with a random
`guest_<random>@ansari.chat` / "Welcome Guest" account so you can try the flow without inventing
an email.

> **Guest accounts are REAL, PERSISTENT staging users.** Each *newly minted* guest is a real row
> in the staging database that stays there (it is not a sandbox that resets). To avoid minting a
> new user on every tap, a device **remembers its guest credentials and reuses them**: tapping
> "Continue as guest" again on the same device — including after logging out — signs back into
> the *same* account rather than creating another. A different device, or the same device after
> its stored credentials are cleared, creates a new real account (so ten fresh devices tapping
> once each leave ten staging users).

Tokens are stored with
`expo-secure-store` on native (Keychain/Keystore) and attached as `Authorization: Bearer`
to every request; a 401 triggers a single silent refresh, and a failed refresh returns you
to the login screen. Tokens are never logged and never written to a committed file.

> **Web token storage caveat.** `expo-secure-store` does not exist on web, so on web the
> tokens are kept in `localStorage`, which is **XSS-reachable in principle**. That is
> acceptable **only** because these are staging credentials in a throwaway prototype. **Do
> not carry this pattern into the real app** — production web auth should use httpOnly
> cookies or an equivalent, not `localStorage`.

## Known backend quirk (staging CORS)

Staging responds with `Access-Control-Allow-Origin: *` together with
`Access-Control-Allow-Credentials: true` — a spec-invalid pairing. It's harmless here
because the prototype authenticates with **bearer headers, not cookies**; it would only bite
a cookie-based client. Noted so nobody mistakes it for a prototype bug.

## Source + SHA

- Imported from a separate Replit pnpm monorepo at local path
  `/Users/amrmohamed/Downloads/Ansari`, source commit **`896cd4c`**.
- Only two things were imported: the Expo app (`artifacts/ansari/`) and the React API client
  it depended on (`lib/api-client-react/src/` → `vendor/api-client-react/`).
- The vendored client was generated (orval) for a **different** "Ansari 4" API. Its runtime
  `custom-fetch.ts` (base URL + bearer wiring, and the React Native `response.body`
  workaround) is reused; its generated hooks/schemas are replaced by the adapter in
  `lib/api/`, which targets `apps/api`.

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
  app/                       Expo Router screens (index, chat/[id], login, register, _layout)
  components/                UI components (StyleSheet.create) incl. AuthForm
  lib/api/                   the apps/api adapter — zod schemas, mappers, hooks, SSE reader
  lib/auth/                  token store (secure-store/localStorage), session context, auth API
  lib/suggested-topics.ts    the static suggested-questions list
  constants/ hooks/ lib/     colors, color-scheme hooks, small utilities
  assets/                    fonts + ambient video
  vendor/api-client-react/   the imported orval client's runtime (custom-fetch.ts is reused)
```
