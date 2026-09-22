# air-129 thread

## Issue #129: prototypes/ansari-expo web build falls back to system font

**Root cause confirmed**: `useAppFonts.web.ts` delegates web type entirely to
`public/index.html`'s `@font-face` shell. #121 dropped all of `public/` as
"Replit's hosting layer" — correct for most of it, wrong for the font shell,
which is standard Expo web (`public/index.html` + `public/fonts/`), not
Replit-specific. It was never re-added, so the web build fell back to system
fonts. This repo's git history confirms `prototypes/ansari-expo/public/`
never existed before this PR.

## What I did

Copied from the Replit source (`~/Downloads/Ansari/artifacts/ansari/`,
upstream `6c58e51`) per the issue's explicit "Fix" scope:
- `public/fonts/` — 12 subsetted `.woff2` (688 KB)
- `public/index.html` — the `@font-face` + preload shell
- `public/grain.png` — one addition beyond the issue's literal file list:
  `index.html`'s pre-mount paper background references `/grain.png`, and
  without it that CSS rule 404s. Tiny (8.5 KB), non-code, made a judgment
  call to include it so the exact file the issue asks to restore is
  actually correct.

Deliberately left out (per the issue's own "Optional" framing):
`favicon.ico`, `apple-touch-icon.png`, `icon-192.png`, `site.webmanifest`,
`og-image.png`, `robots.txt`. Updated README's "Known gaps" section to name
these as the remaining gap (replacing the now-fixed font gap). Confirmed via
`expo export -p web` that Expo auto-generates its own `favicon.ico`
regardless of `public/`, so that one link isn't actually broken in practice.

No code changes — matches the issue's own framing.

## Round 2: architect review on PR #130

Architect reviewed and pushed back on the "optional" scoping: `index.html`
ships real `<link>`s to `favicon.ico`/`icon-192.png`/`apple-touch-icon.png`/
`site.webmanifest` regardless of whether the issue called them optional —
leaving them out means the PR ships a page with 404 links. Asked me to copy
the rest of `public/` (favicon.ico, apple-touch-icon.png, icon-192.png,
icon-512.png, icon-maskable-512.png, site.webmanifest, robots.txt,
og-image.png) and remove the gap note since it's now moot.

Done — `prototypes/ansari-expo/public/` now matches the Replit source
`public/` exactly (fonts/, index.html, grain.png, plus all 8 icon/manifest/
share/robots files, 2.0 MB total). Removed the README's "Known gaps from the
port" section entirely (both the original font gap and my interim
icons/manifest gap are resolved; nothing else was ever listed there).

Re-verified: `expo export -p web` (all 8 files land in export output,
`index.html` gains real manifest/icon links instead of Expo's synthesized
fallback), `expo start --web` via curl (all 8 files + `fonts/` +
`grain.png` return 200 — zero 404s), typecheck + vitest (220 tests)
unchanged. Pushed as a second commit on the same branch/PR.

## Verification

- `pnpm typecheck` / `pnpm test` (vitest, 220 tests) — clean, unchanged.
- `expo export -p web` — custom shell picked up (12 `@font-face` rules,
  `%WEB_TITLE%`/`%LANG_ISO_CODE%` filled correctly), `fonts/` + `grain.png`
  land in export output.
- `expo start --web` — confirmed via curl (Chrome extension wasn't connected
  this session, so no rendered screenshot): `index.html` serves the 12
  `@font-face` rules, `/fonts/*.woff2` and `/grain.png` return 200.
- `porch check 129` (build + tests) — passes once `apps/api/.env.ci`'s dummy
  secrets are exported into the shell first (documented in that file itself;
  this worktree has no `apps/api/.env`, and neither does the main checkout —
  a pre-existing, environment-only gap, same class as the one documented in
  PR #123 for `apps/auth`). One transient `porch check` test failure
  (146s, DB-connection-refused errors in `health.test.ts`) self-resolved on
  rerun and reproduced cleanly via `turbo run test --filter=ansari-api`
  directly (76 files / 763 tests passing in ~16s) — not investigated further
  since `apps/api` is untouched by this diff.

## PR

#130, opened against `develop`. `pr` gate reached — waiting on human
approval (re-requested after round 2).
