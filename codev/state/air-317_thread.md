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
- porch `tests` check: the shared config had lost the per-app-env command, so api tests ran env-less. Architect
  chose option (b): the pir-400 command in an untracked worktree-only `.codev/config.local.json`.
  With it, api showed ONE real failure, mine: `tests/release-doc.test.ts` extracts `/api/...` from RELEASE.md and
  my new text `lib/api/config.ts` read as an endpoint `/api/config` (its lookbehind excludes only `apps/api`).
  Reworded to name `DEFAULT_API_URL`/`DEFAULT_AUTH_URL`; that test went from failing to 16/16.
- porch tests check passed through the override (api 1422/3 skipped, auth 635, eval 145, frontend 803; 213 s). PR #413 opened against develop. CMAP skipped (small change; main reviews the Dockerfile hunk). Waiting at the pr gate.
- Architect review (PR #413): blocking — `new URL('api.askansari.ai:443')` parses (scheme `api.askansari.ai:`, empty host), so it passed and defeated the pair check (old guard exit 0 on both rows; reproduced). Fix: http(s) protocol + non-empty host required. Tests for both rows + non-http schemes; Docker run of row 1 fails at the guard. The empty-host clause is an equivalent mutant (WHATWG gives http(s) a host always); kept as asked.
- Took the non-blocking suggestion: `api-35.ansari.chat` (second domain of the production backend, deploy-guide) is now a production api host for the pair check.
