# task-wzFk — Dependabot security alerts (12 open)

## 2026-09-02 — orientation
- No porch project; task-style builder, self-driven. Branch `builder/task-wzFk` off develop.
- 12 open alerts, all in `pnpm-lock.yaml`: sharp(1), postcss(4), esbuild(2), uuid(1),
  decode-uri-component(1), @xmldom/xmldom(1), image-size(2, NO patched version).
- Root cause of most of them: `apps/api/package.json` carried an npm-style `overrides`
  block (postcss/sharp/react-email>esbuild) left over from before spec 48's npm→pnpm move.
  pnpm ignores that key entirely, so the lockfile never honoured it. Removed it; real
  overrides now live in `pnpm-workspace.yaml` (pnpm 10 reads `overrides` there, and YAML
  allows the per-entry rationale comments).

## Decisions
- Global overrides for sharp/postcss/esbuild/uuid: every consumer in the tree resolves to a
  version we want unified anyway. `@xmldom/xmldom` is RANGE-SCOPED (`@^0.9.0`) because
  `@expo/plist` pins `^0.8.8`, which is outside the vulnerable range and 0.8→0.9 is breaking.
- decode-uri-component NOT overridden. Every patched version (>=0.4.0) is ESM-only; its sole
  consumer query-string@7.1.3 (via expo-router, incl. latest 57.0.18) is CJS and calls
  `require('decode-uri-component')(value)`. Reproduced with babel-preset-expo (what Metro
  runs): module becomes `{default: fn}`, call throws "not a function" — i.e. every
  expo-router URL/query parse would crash on all platforms. Frontend CI (lint/typecheck/
  build only) would NOT catch this. Left open; options for the architect in the PR body.
- image-size (2 alerts): no upstream patch; accepted-pending-upstream per the task.

## Verification
- Runtime smoke from each real consumer dir: xcode→uuid@11 `v4()` ok; plist→xmldom@0.9.12
  build/parse round-trip ok; next→sharp@0.35.4 (vips 8.18.6) renders a PNG; next→postcss
  8.5.26; @esbuild-kit/core-utils + drizzle-kit → esbuild 0.28.1 `transformSync` ok, and
  `drizzle-kit generate` in apps/api and packages/auth both load config+schema and report
  "No schema changes".
- CI-equivalent with `.env.ci` loaded, `--force` (no cache): lint 5/5, typecheck 6/6,
  api test:coverage 659 passed / 3 pre-existing skips, auth tests 8/8, build 4/4
  (next build compiled + 19 static pages; expo export web OK). `pnpm install
  --frozen-lockfile` clean, zero peer warnings.
- Next's "multiple lockfiles" warning during build is the nested worktree seeing the main
  checkout's lockfile — pre-existing, unrelated.

## 2026-09-02 — PR #110 open (base develop)
- 9/12 alerts fixed. image-size ×2 accepted-pending-upstream. decode-uri-component left
  for the architect: tested override + 1-line `pnpm patch` of query-string@7.1.3 on side
  branch `exp/decode-uri-patch` (Node-native and Metro-style parses correct, expo web
  export OK). Not merged into the PR because a third-party patch was not in the mandate.
- GitHub's dependency-graph compare API 404'd for the branch at first push (not yet
  indexed); `pnpm why -r` per package is the verification of record.
