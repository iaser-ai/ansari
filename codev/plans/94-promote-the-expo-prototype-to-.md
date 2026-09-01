# PIR Plan: Promote the Expo prototype to apps/frontend

> **STOOD DOWN — 2026-09-01.** Owner decision, relayed by the architect at the plan-approval
> gate: project 94 is declined. The current staging setup (Railway Nixpacks override building
> `prototypes/ansari-expo` directly) is deemed fine as-is; the port is not needed. No
> implementation was started — this plan is preserved for the record in case the work revives
> (pir-75 precedent). Issue #94 closed by the architect.

## Understanding

Owner decision (supersedes #75): the frontend rolls forward. `prototypes/ansari-expo` — the
PIR #63 Expo SDK 54 app with chat streaming, AuthGate, citations, and session persistence,
already talking to the live `apps/api` contract — becomes the real `apps/frontend`. The
HeroUI/uniwind scaffold currently at `apps/frontend` (Expo SDK 57, two placeholder screens in
`src/app/`) is deleted. The prototype directory is removed in the same PR. Staging's interim
Railway override (Nixpacks building `prototypes/ansari-expo` directly) is retired by the
architect post-merge; this PR's job is to make `apps/frontend`'s existing Docker web pipeline
build the ported app so that flip is a pure config revert.

Key facts found during investigation:

- The prototype is **outside** the pnpm workspace (own npm world, no committed lockfile —
  `prototypes/ansari-expo/.gitignore` ignores all lockfiles). Joining the workspace means the
  root `pnpm-lock.yaml` picks up its dependency tree.
- The prototype is **Expo SDK 54 / RN 0.81.5 / React 19.1.0**; the scaffold is SDK 57. We port
  the prototype **at SDK 54** — an SDK upgrade is feature work, out of scope.
- **Correction to the issue text**: `eas.json` exists only in `apps/frontend` (from f396356,
  legacy app identity). The prototype has none. So "reconcile" means: keep the scaffold's
  `eas.json` verbatim and merge the f396356 identity fields into the prototype's `app.json`.
- f396356 also added `expo-updates ~57.0.12` + `expo-dev-client` (SDK-57 pins). Porting to
  SDK 54 requires the SDK-54-compatible versions of both (via `npx expo install`). **This
  changes f396356's dependency pins** (identity config is untouched) — flagged here per the
  issue's "do not break without flagging" instruction.
- The prototype has no uniwind/tailwind. The whole `gen:types` (uniwind codegen) machinery in
  `turbo.json`, `apps/frontend/package.json`, and `Dockerfile.web` becomes dead and is removed.
- The app reads exactly one env var: `EXPO_PUBLIC_API_URL`
  (`prototypes/ansari-expo/lib/api/config.ts:17`), defaulting to
  `https://api-staging.askansari.ai`. The Dockerfile's current ARG list
  (`EXPO_PUBLIC_API_V2_URL` etc.) is legacy-app surface and is replaced.
- Live references to `prototypes/ansari-expo` exist only inside the prototype itself and in
  historical codev records (plans/reviews/state threads for #57/#63/#64). Historical records
  stay untouched — they describe the past; the acceptance grep is scoped to the live tree
  (code, config, CI, docs).

## Proposed Change

One PR, five commits (phases):

### 1. Move the prototype into apps/frontend

- `git rm` the scaffold's app source: `src/`, `uniwind-env.d.ts`, `types.d.ts`,
  `metro.config.js` (uniwind wrapper), `app.json`, `package.json`, `tsconfig.json`,
  `eslint.config.mjs`, scaffold `README.md`, scaffold-only assets except those noted below.
- `git mv` the prototype tree into `apps/frontend/`: `app/`, `components/`, `constants/`,
  `hooks/`, `lib/`, `vendor/`, `assets/`, `babel.config.js`, `metro.config.js` (plain
  `getDefaultConfig`), `expo-env.d.ts`, `vitest.config.ts`, `README.md`, `PERFORMANCE.md`,
  `.env.local.example`.
- **Kept from the scaffold**: `Dockerfile.web`, `Caddyfile`, `railway.toml`, `eas.json`,
  `.prettierrc.json`, `.prettierignore`, `eslint.config.mjs` (adapted, see below),
  `.gitignore` (merged with the prototype's: keep `google-service-account/` ignore from
  f396356; drop the prototype's lockfile ignores — the workspace lockfile is root-level),
  and `assets/images/adaptive-icon.png` (needed for the Android EAS identity; the prototype
  has no adaptive icon).
- `git rm -r prototypes/ansari-expo` remainder; the `prototypes/` dir disappears.

### 2. Join the workspace (package.json, tsconfig, app.json)

- **`apps/frontend/package.json`**: name stays `ansari-frontend` (CI filters, root scripts,
  and Dockerfile `--filter` all reference it). Scripts:
  `start`/`dev` = `expo start`, `web` = `expo start --web`,
  `build` = `pnpm run build:web`, `build:web` = `expo export --platform web` (no gen:types),
  `test` = `vitest run`, `typecheck` = `tsc --noEmit`, `lint` = `eslint .`, plus the
  format scripts. Dependencies = the prototype's list at SDK 54, restructured so runtime
  packages live in `dependencies` (the prototype had nearly everything in `devDependencies` —
  an artifact of its standalone setup), plus `expo-updates` and `expo-dev-client` at
  SDK-54-compatible versions (`npx expo install`) to keep the eas.json build profiles viable.
  Workspace conventions: `@ansari/eslint-config` + `@ansari/tsconfig` as `workspace:*`,
  `eslint`/`typescript` as `catalog:`. If the `~6.0.3` catalog TypeScript trips over SDK 54's
  type definitions, I pin `~5.9.2` locally with a comment and report it at dev-approval
  (catalog stays authoritative for the other packages).
- **`tsconfig.json`**: `extends: ["expo/tsconfig.base", "@ansari/tsconfig/base.json"]`
  (scaffold convention), prototype paths (`"@/*": ["./*"]`), prototype include list
  (incl. `vendor/**/*.ts`).
- **`app.json`** — the reconciliation. Identity from f396356, verbatim: name "Ask Ansari",
  `owner ansari-project`, `slug ansari-chat`, `scheme askansari`, `version 4.0.0`,
  `ios.bundleIdentifier`/`android.package` `chat.ansari.app`, `infoPlist`, `adaptiveIcon`,
  `predictiveBackGestureEnabled`, `runtimeVersion {policy: fingerprint}`, `updates.url`,
  `extra.eas.projectId`, `extra.router.origin: false`. Functional config from the prototype:
  `newArchEnabled: true`, plugins `expo-router` (dropping the prototype's stray
  `origin: "https://replit.com/"`), `expo-font`, `expo-web-browser`, `expo-video`,
  splash from the prototype icon, `experiments` (typedRoutes, reactCompiler), web output
  `single` with the prototype favicon.
- **`eas.json`**: unchanged from f396356.
- `pnpm install` regenerates the root lockfile; verify no new package needs an
  `onlyBuiltDependencies` allowlist entry (a blocked postinstall script fails loudly at
  install/build, not silently).

### 3. Lint + typecheck under workspace conventions

- Adapt `eslint.config.mjs`: keep `@ansari/eslint-config` + `eslint-config-expo` (at the
  SDK-54-compatible version via `expo install`); ignores drop `uniwind-types.d.ts`, keep
  `expo-env.d.ts`, add `vendor/generated/` (machine-generated API client — not hand-lintable).
- The prototype never ran eslint; fix violations mechanically. If a rule fights generated or
  RN-idiomatic code beyond mechanical fixes, a scoped override with a comment, reported at
  dev-approval.

### 4. Build pipeline: turbo, Dockerfile, CI

- **`turbo.json`**: remove the `gen:types` task and its `dependsOn` edges on
  `typecheck`/`build`/`build:web` (no package defines `gen:types` after this PR); rewrite the
  now-stale uniwind comments (fix-docs-everywhere lesson). Everything else — `globalEnv`
  already carries `EXPO_PUBLIC_*`, `test`/`build` task shapes — stays.
- **`Dockerfile.web`**: same structure (repo-root context, `pnpm install --frozen-lockfile
  --filter ansari-frontend`, `build:web`, caddy serve of `dist/`). ARG list becomes
  `EXPO_PUBLIC_API_URL` (the app's entire env surface); the eleven legacy `EXPO_PUBLIC_*`
  args go. `EXPO_NO_TELEMETRY=1` stays.
- **`Caddyfile`, `railway.toml`**: unchanged — they already describe the target end state
  (the RELEASE.md Railway record also already matches; no doc change needed there).
- **CI (`.github/workflows/ci.yml`)**: add a `Test` step to the frontend job
  (`pnpm exec turbo run test --filter ansari-frontend...`) between Typecheck and Build. The
  job's emitted name stays frozen at `frontend (lint, typecheck)` per the spec-48 decision
  recorded in the workflow comment.

### 5. Docs and self-references

- Ported `README.md`: update paths and delete now-false claims ("reference-only", "NOT part
  of the workspace", npm instructions → pnpm/workspace instructions).
- `.env.local.example`: fix its stale pointer (`app/_layout.tsx` → `lib/api/config.ts`).
- Grep-verify: `grep -rn "prototypes/ansari-expo" --exclude-dir={node_modules,.git}` hits only
  historical codev records (negative-tested against the pre-move tree, which has live hits).

## PR #69 assessment (report requested at this gate)

PR #69 ([AIR #64] title-only history search, +183/−11) is OPEN and touches four prototype
source files (`lib/api/{decode,hooks,mappers}.ts` + `decode.test.ts`) plus README and its own
codev records. After this PR merges, its base paths no longer exist, so a plain rebase will
conflict on every file as modify/delete.

**Recommendation**: don't hold this PR for it. After merge, re-apply #69's diff onto
`apps/frontend/lib/api/` (mechanical path rewrite; the file contents it modifies move
unchanged) as a fresh small PR, and close #69 with a pointer. Closing it outright would
discard a working, tested feature; rebasing in place is strictly more conflict-wrangling than
re-applying. I can do the re-apply as a follow-up if the architect wants.

## Files to Change

- `apps/frontend/**` — scaffold app source deleted; prototype tree moved in (see phase 1 list)
- `apps/frontend/package.json` — rewritten (workspace member, SDK 54 deps, test/lint scripts)
- `apps/frontend/tsconfig.json`, `apps/frontend/eslint.config.mjs`, `apps/frontend/app.json`,
  `apps/frontend/.gitignore` — reconciled as above
- `apps/frontend/eas.json`, `Caddyfile`, `railway.toml`, `.prettierrc.json` — kept as-is
- `apps/frontend/Dockerfile.web` — ARG list + build chain updated
- `turbo.json` — `gen:types` task and edges removed, comments corrected
- `.github/workflows/ci.yml` — frontend job gains a Test step
- `pnpm-lock.yaml` — regenerated (frontend subtree replaced)
- `prototypes/ansari-expo/**` — deleted
- `codev/state/pir-94_thread.md` — builder thread log

## Risks & Alternatives Considered

- **Risk: Metro/Expo under pnpm's symlinked node_modules.** The prototype ran under npm's
  flat layout. Mitigation: `expo/metro-config` has built-in monorepo support, and the SDK-57
  scaffold already ran `expo export` green in CI and Docker under this exact workspace. If
  SDK 54's metro-config needs help, the fix is confined to `metro.config.js`
  (watchFolders/nodeModulesPaths) and will fail loudly at build, not silently.
- **Risk: catalog TypeScript ~6.0.3 vs SDK 54 typings.** Mitigation: `skipLibCheck` is on via
  the shared base; if typecheck still breaks, local pin `~5.9.2` with a comment, reported at
  dev-approval.
- **Risk: exact-pinned React 19.1.0 / RN 0.81.5 peer graph under pnpm.** Kept exactly as the
  prototype pins them; `expo install --check` validates the set.
- **Risk: EAS mobile builds.** `eas.json`/identity carried verbatim, but expo-updates moves to
  its SDK-54 release and the runtime fingerprint changes (it always would — different app).
  Actually running an EAS build is not in CI; viability is verified via `npx expo config`
  resolving and `npx eas config` if credentials allow (best-effort, reported honestly).
- **Alternative: upgrade the prototype to SDK 57 during the port** (match the scaffold's
  newer stack). Rejected: conflates a mechanical promotion with an SDK migration; staging
  today serves the SDK 54 build, and acceptance is "identical UI".
- **Alternative: keep the prototype's flat package.json (everything in devDependencies).**
  Rejected: `dependencies`/`devDependencies` split is what workspace consumers and future
  `--prod` installs expect; the restructure is verifiable via identical resolved versions.
- **Alternative: rename/move to `src/` layout to match the scaffold.** Rejected: expo-router
  convention supports root `app/`; a layout churn adds diff noise and risk for zero behavior.

## Test Plan

- `pnpm install` from repo root: green, single lockfile, no postinstall-blocked warnings.
- `pnpm exec turbo run lint typecheck test build --filter ansari-frontend...`: all green;
  `test` runs the migrated vitest suite (lib/api decode/sse/streaming/chat-stream, lib/auth,
  time — same file count as in the prototype).
- Local web export: `pnpm --filter ansari-frontend run build:web` produces `dist/`; serve it
  statically (`npx serve dist`), load in a browser, log in, send a chat message — streaming
  answer with citations against `api-staging.askansari.ai` (the baked default).
- Docker: `docker build -f apps/frontend/Dockerfile.web .` from repo root succeeds; run the
  image, hit `/`, verify the SPA loads and deep links (`/chat/...`) fall through to
  `index.html`.
- Grep: `grep -rn "prototypes/ansari-expo"` over the live tree hits only historical codev
  records; `prototypes/` no longer exists.
- CI: full pipeline green on the PR, including the new frontend Test step.
- Dev-approval manual pass: reviewer runs `pnpm --filter ansari-frontend dev` (or the exported
  dist) in the worktree and exercises login → chat → citations → history.
- Cross-platform: web is the verified path. Native: `npx expo config --type public` resolves;
  EAS build execution is deferred to the architect's discretion (not CI-verifiable).
