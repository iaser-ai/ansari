# Ansari Expo prototype — reference only

This directory is a **read-only reference copy** of an earlier Replit Expo prototype of the
Ansari mobile/web app. It exists so the team can read a working UI while building the real
frontend in `apps/frontend`.

## 1. Reference only — outside the workspace, runs standalone

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

  With no backend configured this renders the UI shell only — every data call goes to
  `https://undefined/api/...` and fails (see "Running with a live backend" below). Running it
  does **not** enroll it in the workspace; the isolated `node_modules`, any lockfile it writes,
  and `.expo/` are gitignored here so they never get committed.

  `babel-preset-expo` is listed as an explicit devDependency purely so this standalone install
  works: the source relied on the Replit monorepo hoisting it to the top level, but a
  single-package install nests it under `node_modules/expo/` where `babel.config.js` can't
  resolve it. Declaring it top-level is the fix Expo's own error message recommends.

### Running with a live backend (full functionality)

The data layer **does** work if you point it at the backend the prototype was built for. That
backend was **not** imported (it's out of scope for this reference), but it lives in the same
source monorepo and needs no database:

- It is `artifacts/api-server` in `/Users/amrmohamed/Downloads/Ansari` @ `896cd4c` — a small
  Express 5 server that mounts everything under `/api`. It seeds an **in-memory** store at
  startup with canned, cited answers (`src/routes/ansari.ts`, `seed()` near line 340), so there
  is **no DB to provision**. Its `@workspace/db` dependency is vestigial and unused at runtime;
  at runtime it only really needs `@workspace/api-zod` (two validators). Run it from inside that
  monorepo so its `workspace:*`/`catalog:` deps resolve:

  ```bash
  # in /Users/amrmohamed/Downloads/Ansari
  PORT=5000 pnpm --filter @workspace/api-server dev   # builds, then starts on $PORT
  ```

- Then tell the prototype where the backend is. `app/_layout.tsx` builds the base URL as
  `"https://" + EXPO_PUBLIC_DOMAIN`, so set **`EXPO_PUBLIC_DOMAIN` to a host only, no scheme**,
  in a `.env.local` (gitignored — copy `.env.local.example`):

  ```bash
  cp .env.local.example .env.local
  # then edit EXPO_PUBLIC_DOMAIN, and restart `expo start` (EXPO_PUBLIC_* is inlined at bundle time)
  ```

- **Scheme warning — the `https://undefined` symptom.** The base URL is hardcoded to `https://`.
  Two consequences: (1) if `EXPO_PUBLIC_DOMAIN` is unset you literally request
  `https://undefined/api/...` (`ERR_NAME_NOT_RESOLVED`) — that's the failure you'll see with no
  `.env.local`; (2) a **local** `http://localhost:5000` backend won't work as-is — you need an
  HTTPS URL (an already-https tunnel such as a Replit/ngrok dev domain works unpatched), or a
  one-line local patch to `app/_layout.tsx` to use `http://` for localhost.

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

**Against _this repo's_ API the whole data layer is unusable** — `vendor/api-client-react/` and
every hook/query that calls it would have to be rebuilt against `/api/v2/threads` (+ auth). It
_does_ work against the prototype's **original** backend (see "Running with a live backend"
above), which is how you see it fully functional. But for porting into `apps/frontend`, **the
value of this reference is the UI; the plumbing is throwaway.**

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
