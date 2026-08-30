# PIR Plan: Port ansari-frontend@multisage into apps/frontend, fix feedback 422, cut production over

## Understanding

`apps/frontend` currently holds a 3-file HeroUI/Expo-57 skeleton plus identity files
(app.json, eas.json, Dockerfile.web, Caddyfile, brand assets) migrated on Aug 8
(`f396356`). The real production frontend — what `askansari.ai` serves — lives in
`ansari-project/ansari-frontend` @ `origin/multisage` (`a99ba97`): an **Expo SDK 52 /
React Native 0.76.7 / React 18 / NativeWind / Redux Toolkit** app, 228 files under
`src/`. This issue ports that app into the monorepo, fixes the feedback 422 bug in the
ported code, wires env/build args, verifies on staging, and prepares (not executes) the
production cutover.

**The port is a toolchain replacement, not just a `src/` swap.** The skeleton is Expo 57
/ React 19 / uniwind; the source is Expo 52 / React 18 / NativeWind. A faithful port
(web-bundle parity with production) requires the source's dependency set and build
config (babel, metro, tailwind) wholesale. Upgrading to SDK 57 is explicitly not this
issue.

### Feedback 422 root cause (verified end-to-end)

- `src/store/actions/chatActions.ts` (source repo, `addMessage` thunk, ~line 43):
  `const responseMessageId = Helpers.generateUniqueId()` — a fabricated id like
  `"m_kx3..."`, not a UUID. The raw-text stream route (`POST /api/v2/threads/[id]`,
  `apps/api/src/app/api/v2/threads/[id]/route.ts:116`) returns no server message id.
- `apps/api/src/app/api/v2/feedback/route.ts:8-20`: `message_id: z.string().uuid()`
  (and `thread_id` likewise) → fabricated id fails → **422**, swallowed by the UI
  (`sendFeedback` catch just calls `setError`).
- The reconciliation source already exists: `GET /api/v2/threads/[id]` returns
  `messages: [{ id: m.id (real UUID), ... }]`
  (`apps/api/src/app/api/v2/threads/[id]/route.ts:56-57`), and the frontend's
  `fetchThread` thunk → `ChatService.getThread` → `dispatch(setActiveThread(thread))`
  replaces `activeThread.messages` wholesale with the server copy.

Blast radius: 68 thumbs_down ever vs 683 thumbs_up (thumbs-up mostly arrives on
messages viewed after a thread reload, which have real ids; thumbs-down on a
freshly-streamed message always fails).

## Proposed Change

One PR on `builder/pir-75`, in four commits (phases). Staging verification happens
post-merge; production cutover is a runbook in the PR for a human.

### Phase 1 — Port the app

Replace the skeleton with the source tree at `a99ba97` (from `origin/multisage`, NOT
the stale working tree):

- **Copy in**: `src/` (228 files, includes `src/assets`, `src/global.css`),
  `babel.config.js`, `metro.config.js` (Sentry + NativeWind + Reanimated wrappers),
  `tailwind.config.js`, `nativewind-env.d.ts`, `jest.config.js`, `.prettierrc`,
  `public/` (expo export copies it into `dist/` — favicon/manifest/robots.txt served in
  production today), `.env.example` (as `apps/frontend/.env.example`).
- **Delete skeleton files**: `src/app` + `src/global.css` (skeleton versions),
  `metro.config.js` (uniwind), `uniwind-env.d.ts`, `types.d.ts`.
- **Not ported**: `scripts/generateLkHadithLineMap.mjs` output is already committed
  under `src/data`; port `scripts/` for regenerability. Skip old-repo infra:
  `Dockerfile` (npm-based), `config/nginx.conf.erb`, `vercel.json`, `Procfile`,
  `buildprod.sh`, `deploy_frontend.sh`, codev/CI files of the old repo, `yarn.lock`,
  `package-lock.json`.

- **`apps/frontend/package.json`**: keep name `ansari-frontend` (CI filters, root
  scripts, and Dockerfile.web all key on it) and `main: expo-router/entry`. Replace
  `dependencies` with the source's Expo-52 set verbatim. devDependencies: source's
  babel/jest/prettier set, plus `@ansari/tsconfig` + `@ansari/eslint-config`
  (`workspace:*`), with `typescript: catalog:` and `eslint: catalog:` per spec 48
  (see Risks for the fallback if the Expo 52 types can't typecheck under TS 6).
  Scripts: `build:web` becomes plain `expo export --platform web` (**drop the
  `gen:types &&` chain — no uniwind anymore**); drop `gen:types`; keep
  `lint`/`typecheck`/`dev`/`start`; add `test: jest`. Turbo needs no task changes:
  `gen:types` simply stops being defined by this package, so the `dependsOn` edges
  no-op for it (turbo skips undefined scripts); I'll update the now-stale
  `turbo.json`/package.json comments that describe the frontend gen:types chain.

- **`app.json` merge** (migrated identity wins, source capabilities win):
  - Keep (Aug 8, deliberate): name "Ask Ansari", owner/slug/projectId, scheme
    `askansari`, version 4.0.0, bundle/package ids, runtimeVersion fingerprint,
    updates URL, android adaptiveIcon block.
  - Take from source: plugins list (`expo-router`, `expo-font`, `expo-localization`,
    `@sentry/react-native/expo`, `expo-splash-screen` with the source's light/dark
    images, `expo-screen-orientation`), `newArchEnabled: true`,
    `extra.supportsRTL: true`, `web.bundler: metro`.
  - Drop Expo-57-only `experiments` (`reactCompiler` requires React 19;
    `typedRoutes` isn't used by the source code).
  - Icon/splash paths: point at whichever asset set survives a diff of
    `apps/frontend/assets/` vs source `src/assets/images/` (keep the migrated files
    where identical; source wins where they differ, since it's what production ships).
- **`eas.json`**: keep the migrated one (newer CLI floor >= 21, Android submit
  config; build profiles are otherwise identical to source).
- **`Dockerfile.web` / `Caddyfile` / `railway.toml`**: keep the repo versions
  (pnpm-workspace build; its ARG list is already a superset of the source
  Dockerfile's). The only interaction is the `build:web` script change above, which
  the Dockerfile picks up automatically.
- **eslint**: keep the skeleton's flat-config `eslint.config.mjs` shape
  (`@ansari/eslint-config` + `eslint-config-expo/flat.js`) on catalog eslint 9,
  pinning `eslint-config-expo` to a version compatible with eslint 9. The source used
  eslint 8 legacy config; lint config does not affect the shipped bundle. Lint
  fallout from stricter/different rules is handled by **config-level rule
  accommodations, not mass edits to the 228 ported files** — preserving
  diffability against `a99ba97` matters more than rule purity.
- **tsconfig.json**: keep skeleton shape (`extends: ["expo/tsconfig.base",
  "@ansari/tsconfig/base.json"]`) plus the source's `@/* → src/*` path.
- `pnpm install` to regenerate the lockfile; extend `onlyBuiltDependencies` in
  `pnpm-workspace.yaml` only if pnpm reports blocked postinstall scripts.

**Phase 1 exit**: `pnpm --filter ansari-frontend build:web` produces `dist/`; lint +
typecheck green; `docker build -f apps/frontend/Dockerfile.web .` succeeds and the
serve stage serves the app locally.

### Phase 2 — Feedback 422 fix + regression test

In `apps/frontend/src/store/actions/chatActions.ts`, `addMessage` thunk, after the
stream read-loop completes (right before constructing the returned `Message`):

```ts
// Reconcile fabricated stream ids with server UUIDs — feedback validates
// message_id as a UUID, and the raw-text stream returns no server ids.
const { activeThread } = (getState() as RootState).chat
if (activeThread?.id === threadId) {
  await dispatch(fetchThread(threadId))
}
```

- The `activeThread?.id === threadId` guard prevents clobbering a different thread if
  the user navigated away mid-stream.
- `fetchThread` already handles its own errors (dispatches `setError` and re-throws);
  wrap the dispatch so a failed refetch logs but does not discard the streamed
  content already on screen (the message stays visible with the fabricated id — no
  worse than today).
- No API change. The architect has an uncommitted draft adding `message_id` to the
  SSE route's `done` event — that's additive, doesn't cover the raw-text route this
  app actually calls, and stays out of this PR (coordination noted, not duplicated).

**Regression test** (`src/store/actions/__tests__/chatActions.feedback.test.ts`,
jest-expo preset, ports alongside the source's 6 existing test files): build a real
store, mock `fetch` (stream POST returns a raw-text `ReadableStream`; thread GET
returns messages with real UUIDs), dispatch `addMessage`, then `sendFeedback` on the
last assistant message from the store — assert the feedback POST body's `message_id`
is the server UUID, not a `generateUniqueId()` value. Add a `Test` step to the CI
frontend job (name stays frozen as `frontend (lint, typecheck)` per spec 48).

### Phase 3 — Env/build args audit

Every `EXPO_PUBLIC_*` the ported code reads (enumerated via grep of the source at
`a99ba97`):

| Var | Read at | In Dockerfile.web ARGs? |
|---|---|---|
| `EXPO_PUBLIC_API_V2_URL` | ApiService, ChatService, UserService, authSlice, getEnv | yes |
| `EXPO_PUBLIC_API_TIMEOUT` | getEnv (default 60000) | yes |
| `EXPO_PUBLIC_SENTRY_DSN` | app/_layout.tsx | yes |
| `EXPO_PUBLIC_ENVIRONMENT` | app/_layout.tsx (Sentry env + sample rates) | yes |
| `EXPO_PUBLIC_SHARE_URL` | getEnv | yes |
| `EXPO_PUBLIC_ENABLE_SHARE` | getEnv | yes |
| `EXPO_PUBLIC_SUBSCRIBE_URL` | Subscription.tsx, getEnv | yes |
| `EXPO_PUBLIC_FEEDBACK_EMAIL` | getEnv | yes |
| `EXPO_PUBLIC_COMPREHENSIVE_GUIDE_URL` | getEnv | yes |
| `EXPO_PUBLIC_PRIVACY_URL` | getEnv | yes |
| `EXPO_PUBLIC_TERMS_URL` | getEnv | yes |

(`EXPO_PUBLIC_API_URL` in `src/env/index.ts` is dead code — nothing imports that
module; not adding it.)

The Dockerfile ARG list already covers all eleven — no Dockerfile change expected.
Remaining work: add all eleven to `turbo.json` `globalEnv` if any are missing (strict
env mode — a var absent from `globalEnv` is invisible AND missing from the cache key),
and verify the Railway `ansari-multisage-frontend` staging + production services carry
them with per-environment values (`EXPO_PUBLIC_API_V2_URL` →
`api-staging.askansari.ai` / production API respectively). I'll check via Railway
CLI/dashboard read access; if I lack access, I'll list the required variable table in
the PR and flag the check to the architect. **The PR description lists the full
table either way** — a missing var is a silently wrong build, not an error.

### Phase 4 — Staging verification (post-merge)

After merge, the existing `ansari-multisage-frontend` staging service auto-builds from
`apps/frontend/Dockerfile.web`. Verify at `staging.askansari.ai` against
`api-staging.askansari.ai`: login, streamed chat with tools, and **thumbs-down on the
freshly-streamed reply → options panel appears → `POST /api/v2/feedback` returns 200 →
row lands in the staging DB with the comment**.

### Phase 5 — Production cutover runbook (in the PR, human executes)

Exact steps for moving the `askansari.ai` service source to `iaser-ai/ansari` @
`main`, `apps/frontend/Dockerfile.web`, with build args; rollback = repoint at
`ansari-project/ansari-frontend@multisage` / redeploy the retained image. I write it,
nobody executes it in this project.

## Files to Change

- `apps/frontend/src/**` — replaced wholesale with source tree @ `a99ba97` (228 files)
- `apps/frontend/package.json` — rewritten (Expo 52 deps, workspace/catalog devDeps, scripts)
- `apps/frontend/app.json` — merge: migrated identity + source capabilities, drop Expo-57 experiments
- `apps/frontend/babel.config.js`, `metro.config.js`, `tailwind.config.js`, `nativewind-env.d.ts`, `jest.config.js`, `.prettierrc`, `public/**`, `scripts/**`, `.env.example` — ported from source
- `apps/frontend/tsconfig.json` — keep skeleton extends, ensure `@/*` path; drop uniwind include
- `apps/frontend/eslint.config.mjs` — adjust ignores (drop uniwind), add rule accommodations as needed
- `apps/frontend/uniwind-env.d.ts`, `types.d.ts` — deleted
- `apps/frontend/src/store/actions/chatActions.ts` — feedback fix (Phase 2 diff above)
- `apps/frontend/src/store/actions/__tests__/chatActions.feedback.test.ts` — new regression test
- `pnpm-lock.yaml`, possibly `pnpm-workspace.yaml` (`onlyBuiltDependencies`)
- `turbo.json` — `globalEnv` additions for any missing `EXPO_PUBLIC_*`; stale frontend gen:types comments
- `.github/workflows/ci.yml` — add frontend Test step (job name unchanged)
- `apps/frontend/eas.json`, `Dockerfile.web`, `Caddyfile`, `railway.toml` — expected unchanged (diff-verified)
- PR description — env var table + production cutover runbook

## Risks & Alternatives Considered

- **Risk: Expo 52 + Metro under pnpm's isolated node_modules.** The old repo used npm
  hoisting; pnpm symlinks can surface undeclared transitive deps at bundle time. The
  Expo-57 skeleton already builds under this workspace, which is evidence but not
  proof for SDK 52. Mitigation: `docker build` + local `expo export` are Phase 1 exit
  criteria; if a hoisting issue appears, fix with explicit deps or targeted
  `.npmrc`/`public-hoist-pattern` entries — never `node-linker=hoisted` globally
  (would perturb the other apps).
- **Risk: catalog TS ~6.0.3 vs Expo 52's types (@types/react 18, RN 0.76).** If
  typecheck is genuinely impossible under TS 6, fall back to an app-local
  `typescript` pin with a comment documenting the drift and a note in the review doc
  — surfaced at dev-approval, not silently. Same logic for `eslint-config-expo`
  version choice.
- **Risk: `fetchThread` reconciliation replaces `activeThread` after every stream** —
  a visible re-render/scroll jump, and one extra GET per message. Accepted: it's the
  issue-prescribed fix, the GET is cheap, and `addStreamMessageToActiveThread` has
  already rendered the final content so the replacement is content-identical except
  ids/timestamps. Alternative (backend emits `message_id` on the raw-text route)
  rejected: `/api/v2` contract is frozen (mobile compat) and the raw-text stream has
  no framing to carry it.
- **Alternative: upgrade the app to Expo 57 to keep the skeleton toolchain** —
  rejected: massive, unverifiable against production behavior, explicitly a follow-up.
- **Risk: identity-file merge picks a wrong field.** Mitigated by the explicit
  keep/take table above (reviewer can veto at plan gate) and by `npx expo config`
  parsing as a check.
- **Mobile**: out of scope (web parity only); old repo stays authoritative for
  iOS/Android and is not modified.

## Test Plan

- **Unit (CI)**: ported source test suite (6 files) + new feedback-id regression test
  under jest-expo; `turbo run test --filter ansari-frontend`.
- **Static (CI)**: lint, typecheck, `turbo run build --filter ansari-frontend...`
  (frontend job, spec 48).
- **Local/dev-approval (reviewer)**: from the worktree,
  `pnpm --filter ansari-frontend dev` with `.env` pointing
  `EXPO_PUBLIC_API_V2_URL` at `https://api-staging.askansari.ai/api/v2` — log in, send
  a message, watch the stream, thumbs-down the fresh reply: options panel appears,
  network tab shows `POST /api/v2/feedback` → **200** with a UUID `message_id`.
  Also: `docker build -f apps/frontend/Dockerfile.web .` + run the image, confirm the
  SPA serves.
- **Staging (post-merge)**: full pass at `staging.askansari.ai` per Phase 4, including
  the staging-DB feedback row.
- **Cross-platform**: web only (mobile out of scope).
