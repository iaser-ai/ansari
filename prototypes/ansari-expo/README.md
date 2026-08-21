# Ansari Expo prototype — reference only

This directory is a **read-only reference copy** of an earlier Replit Expo prototype of the
Ansari mobile/web app. It exists so the team can read a working UI while building the real
frontend in `apps/frontend`.

## 1. Reference only — it does not build, install, or run here

- It is **not** part of the pnpm workspace and **not** in the Turborepo task graph.
  `pnpm-workspace.yaml` globs only `apps/*` and `packages/*`; `prototypes/` matches neither,
  so `pnpm install`, `pnpm lint`, `pnpm typecheck`, and `pnpm build` all ignore it.
- **Do not** move it under `apps/`, add it to `pnpm-workspace.yaml`, or wire it into CI or the
  task graph. Doing so enrolls it in every workspace task and breaks the build — it targets a
  different toolchain (see below) and a different backend.
- The `package.json` here is kept so a reader can see the prototype's dependency list. Its
  `catalog:` and `workspace:*` specifiers (which pointed at the source repo's pnpm catalog and
  sibling packages) have been resolved to concrete versions so nothing here is misleading. Its
  Replit-specific `dev`/`build`/`serve` scripts and the `server/` + `scripts/` deploy scaffolding
  they invoked have been dropped — they taught us nothing about the frontend.
- A minimal `start` script (`expo start`) is kept for convenience if you want to boot the UI
  **standalone**, outside this repo's workspace:

  ```bash
  cd prototypes/ansari-expo
  pnpm install          # creates an isolated node_modules HERE (not the workspace's)
  pnpm start            # expo start
  ```

  This renders the UI shell only. The data layer will not work — see the API gap in section 3.
  Running it does **not** enroll it in the workspace; that isolated `node_modules` is untracked.

## 2. Source + SHA

- Imported from a separate Replit pnpm monorepo at local path `/Users/amrmohamed/Downloads/Ansari`.
- Source commit: **`896cd4c`** ("Lighten the Literata prose scale one weight").
- Only two things were imported: the Expo app (`artifacts/ansari/`) and the React API client it
  depends on (`lib/api-client-react/src/` → `vendor/api-client-react/`). The other six packages
  of that monorepo (`ansari-web`, `api-server`, `mockup-sandbox`, `api-spec`, `api-zod`, `db`)
  were **not** imported.
- This is a **point-in-time snapshot and it will rot.** It is not tracked against its origin (the
  source's backup remote is unreachable from here). Treat it as a frozen artifact, not a
  maintained dependency.

## 3. The API gap — read this before porting anything

The prototype was built against a **different backend** — the "Ansari 4 API specification" — with
an orval-generated client (vendored under `vendor/api-client-react/`). That backend has **zero
overlapping endpoints** with the API this repo serves, and the prototype has **no auth at all**.

| Prototype expects | This repo serves |
|---|---|
| `/api/conversations` | `/api/v2/threads` |
| `/api/conversations/{id}` | `/api/v2/threads/{id}` |
| `/api/conversations/{id}/messages` | `/api/v2/threads/{id}/chat` |
| `/api/suggested-questions` | — |
| `/api/healthz` | `/api/health` |
| — | `/api/v2/users/*` (all auth) |

**The whole data layer is unusable here.** `vendor/api-client-react/` and every hook/query that
calls it must be rebuilt against this repo's API. **The value of this reference is the UI; the
plumbing is throwaway.**

## 4. Version gaps a porter will hit

These are not defects — they are the translation list from this snapshot to `apps/frontend`:

| Concern | Prototype | This repo |
|---|---|---|
| Expo SDK | 54 | 57 |
| React Native | 0.81.5 | 0.86.2 |
| TypeScript | 5.9 | 6.0 |
| zod | 3 | 4 |
| Styling | `StyleSheet.create` (11 components) | uniwind `className` |

## Layout

```
prototypes/ansari-expo/
  app/                       Expo Router screens (index, chat/[id], _layout, +not-found)
  components/                UI components (styled with StyleSheet.create)
  constants/ hooks/ lib/     colors, color-scheme hooks, small utilities
  assets/                    fonts + ambient video (kept — needed to port the look)
  vendor/api-client-react/   the imported orval client (see the API gap above)
  app.json babel.config.js metro.config.js tsconfig.json package.json
```

## What changed on the way in

- Excluded: `server/`, `scripts/` (Replit deploy scaffolding), `.replit-artifact/`, `.expo/`,
  `node_modules/`, `.DS_Store`, and the prototype's own `.gitignore` (it ignored
  `expo-env.d.ts`, which we keep as reference).
- `lib/api-client-react/src/` was vendored to `vendor/api-client-react/`, and the eight
  `@workspace/api-client-react` imports were rewritten to `@/vendor/api-client-react` (via the
  existing `@/*` tsconfig alias) so the code reads coherently.
- The stale `references` entry in `tsconfig.json` (pointing at the source repo's
  `../../lib/api-client-react`) was removed; `vendor/**` was added to `include`.
