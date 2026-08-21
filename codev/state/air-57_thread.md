# Builder air-57 — Import Replit Expo prototype (reference-only) — Issue #57

Protocol: AIR (strict). Reference-only import; no spec/plan/review files.

## What I did

Imported the Replit Expo prototype as an inert reference under `prototypes/ansari-expo/`.

- **Source**: `/Users/amrmohamed/Downloads/Ansari` @ commit `896cd4c` (verified with `git log`).
- **Copied**:
  - `artifacts/ansari/` → `prototypes/ansari-expo/` (excluding `server/`, `scripts/`,
    `.replit-artifact/`, `.expo/`, `node_modules/`, `.DS_Store`, and the prototype's nested
    `.gitignore` — it ignored `expo-env.d.ts`, which is a reference file we keep).
  - `lib/api-client-react/src/` (4 files, 1,097 LOC) → `prototypes/ansari-expo/vendor/api-client-react/`.
  - Result: 45 files, ~1.5MB. `assets/` (fonts + video) kept as required.
- **Import rewrite**: 8 `@workspace/api-client-react` imports → `@/vendor/api-client-react`
  (via the prototype's existing `@/*` tsconfig alias). No `@workspace/*` or `catalog:`
  references remain anywhere in the prototype.
- **package.json cleanup**: renamed `@workspace/ansari` → `ansari-expo-prototype`; resolved the
  four `catalog:` specifiers to concrete versions from the source catalog (react/react-dom
  19.1.0, @tanstack/react-query ^5.90.21, zod ^3.25.76); dropped the `workspace:*` client dep
  (now vendored) and the Replit `dev`/`build`/`serve` scripts (they invoked the excluded
  `server/` + `scripts/` scaffolding).
- **tsconfig.json**: removed the stale `references` → `../../lib/api-client-react`; added
  `vendor/**` to `include`.
- **README.md**: covers the four required points (reference-only, source+SHA, the API gap
  table, the version-gap table). Frontend versions in the README verified against
  `apps/frontend` (expo 57, RN 0.86.2, TS 6.0 via catalog, uniwind).

## Verification (the load-bearing part)

`prototypes/` matches no `pnpm-workspace.yaml` glob (`apps/*`, `packages/*`), so the import is
inert. Proven, not assumed:

- `pnpm install --frozen-lockfile`: succeeds, lockfile **byte-identical** (sha
  `26f196dd…` before and after). `pnpm-workspace.yaml` and root `package.json` unchanged.
- `pnpm -r list`: same 6 workspace entries as before — `ansari-expo-prototype` is NOT enrolled.
- `turbo run {lint,typecheck,build} --dry-run`: package scope **unchanged at 5 packages** for
  all three (diff before/after empty).
- `pnpm lint` green (3 tasks; pre-existing warnings only). `pnpm typecheck` green (4 tasks).
- `pnpm build`: green for frontend + packages. `ansari-api` build fails **only** locally on
  `DATABASE_URL Invalid input` — a missing-env condition. CI loads `apps/api/.env.ci` first;
  reproducing that locally makes `ansari-api` build succeed (FULL TURBO). My change modifies
  **zero tracked files** (all additions under `prototypes/`), so this failure is pre-existing
  and independent of the import.

## Notes

- No tests added: this is a config/reference-only import with no runtime code in the workspace.
  The "test" is the before/after task-scope verification above.
- Scope: well under 300 LOC of authored change (README + small config edits); the rest is a
  verbatim reference copy.
