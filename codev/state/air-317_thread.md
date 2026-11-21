# air-317 thread — web build guard for EXPO_PUBLIC_API_URL / EXPO_PUBLIC_AUTH_URL

- 2026-11-21: Guard is `apps/frontend/scripts/check-web-env.mjs` (plain Node ESM, no deps), run by
  `Dockerfile.web` as the FIRST step after WORKDIR — before `pnpm install`, so a misconfigured service
  fails in ~1s. The ARGs moved up with it (declared once, still visible to `build:web`).
- Rules: both required and non-empty, every environment, no flag; each must parse as a URL; the
  production api host and production auth host only as a pair (exact hostname match, so a lookalike
  `api.askansari.ai.example.com` is not "production").
- Unit tests `scripts/check-web-env.test.mjs` (vitest include gained `scripts/**/*.test.mjs`); a
  mutation check killed all four mutants (no mixed check, no required check, substring host match,
  CLI exit 0).
- Docker matrix run on the real path with `--no-cache`: unset auth / unset api / both unset / both
  mixed directions fail at the guard step; staging pair and production pair pass (full build).
- Decision: new files use single quotes to match the code; the checked-in `.prettierrc.json` says
  double quotes but existing files (e.g. `lib/api/config.ts`) already fail it at HEAD, so it is not
  enforced. Not changed here.
- Fixed in place: `codev/resources/arch.md` still said the app's env surface was `EXPO_PUBLIC_API_URL`
  alone, the only ARG (stale since spec 300 added `EXPO_PUBLIC_AUTH_URL`).
