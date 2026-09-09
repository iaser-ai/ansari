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
- Dependency-graph compare works when given commit SHAs instead of branch names:
  confirms 9 GHSA IDs on removed versions, none on added. Recorded in PR body.
- Waiting on architect: decode-uri-component option 1 (patch) vs 2 (accept).

## 2026-09-03 — architect decision
- decode-uri-component: ACCEPT-pending-upstream, no patch. Rationale: client-side-only
  medium DoS via expo-router/query-string (self-inflicted browser hang, no server exposure);
  a pnpm patch on a transitive is disproportionate. `exp/decode-uri-patch` stays as the
  ready fallback and is linked from the PR body. Final tally: 9 fixed, 3 accepted.
- PR body updated; gate now with Waleed.

## 2026-09-09 — gate approved, merging
- Waleed approved (relayed by architect). develop had moved 210 commits; merged
  origin/develop. Conflicts: apps/api/package.json (took develop's vitest ^4.1.11, kept the
  dead npm-style overrides block REMOVED) and pnpm-lock.yaml (took develop's, re-ran
  `pnpm install` so our overrides re-resolve). Merged lockfile: no vulnerable versions.
- Full suite on merged tree with CI env, --force: lint 5/5 (0 errors), typecheck 6/6,
  api tests 763 passed / 3 skipped, auth 8/8, build 4/4.

## 2026-09-09 — follow-up: Next RCE + js-yaml + qs (branch builder/task-wzFk-next-rce)
- Architect fast-tracked: 7 alerts opened while #110 sat. Branch off post-#110 develop.
- next ^15.5.22 → ^15.5.24 in apps/api (resolves 15.5.25, latest patch; advisory floor is
  15.5.24). js-yaml 4.3.2 and qs 6.16.0 needed NO override — every declared range already
  admitted them; `pnpm update -r <names>` moved unrelated packages (rolldown, metro,
  browserslist…), so instead I restored the lockfile and deleted only the stale
  js-yaml@4.3.1 / qs@6.15.3 entries, letting `pnpm install` re-resolve them in range.
  Resulting diff: next + @next/*, js-yaml, qs only.
- Suite with CI env, --force: lint 5/5 (0 errors), typecheck 6/6, api 763/3 skipped,
  auth 8/8, build 4/4 on Next 15.5.25.

## 2026-09-09 — Part 1: batch of "green" Dependabot bumps (branch builder/task-wzFk-dep-bumps)
- Off post-#132 develop. One commit per bump so any can be dropped at review.
- Hidden problems CI could not see (bot CI is web-only lint/typecheck/build):
  * #114 @better-auth/expo 1.7.3 peer-requires better-auth/@better-auth/core ^1.7.3; repo
    pinned 1.6.27. Bumped better-auth in packages/auth + apps/auth alongside. drizzle-kit
    generate in packages/auth: no schema drift. Auth tests 8/8.
  * #120 reanimated 4.6.0 peer-requires react-native-worklets 0.12.x, but expo-modules-core
    57.0.10 (and @expo/ui) pin worklets 0.10.1 and peer-accept only ^0.7–^0.10. Bumping
    worklets leaves TWO native worklets in the tree and an unmet peer either way — broken
    native build under SDK 57. EXCLUDED; belongs with the SDK upgrade. The variant including
    it is kept locally as branch builder/task-wzFk-dep-bumps-with-reanimated (commit 556778d).
  * #119 gesture-handler 3.2.1 (MAJOR): heroui-native 1.0.8 (latest 1.0.9 too) peers
    ^2.28.0 → unmet. It imports only `Gesture` and `GestureDetector`, both still exported by
    GH3; @gorhom/bottom-sheet peers >=2.16.1. Kept per architect, flagged.
  * `expo install --check` reports screens/safe-area/GH deviating from SDK 57's bundled
    versions (~4.26.0 / ~5.7.0 / ~2.32.0). runtimeVersion policy is `fingerprint`, so an
    OTA with changed native modules will NOT reach old binaries.
- Pre-existing peer warning (not mine): @expo/metro-runtime 57.0.15 wants @expo/log-box
  ^57.0.4, found 57.0.2 — from merged bot PR #113.
- Suite with CI env, --force: lint 5/5 (0 errors), typecheck 6/6, api 763/3 skipped,
  auth 8/8, build 4/4. turbo 2.10.12 drove the runs.

## 2026-09-09 — vitest alert 29 + Part 2 pre-assessment (no code written)
- Alert #29 (vitest) will NOT auto-close: its manifest is prototypes/ansari-expo/package.json
  (`vitest ^3.2.4`), which is outside the pnpm workspace and has no lockfile. Dependabot
  flags the manifest range. Fix is a one-line spec bump there, or dismiss as unused.
- Part 2 — all three bot PRs fail on UPSTREAM support, not on our code:
  * #112 react-native 0.87.1: @expo/cli 57 requires `react-native/rn-get-polyfills`, which
    RN 0.87 no longer exports. Expo stable is SDK 57 (RN 0.86); SDK 58 exists only as canary.
    RN 0.87 == Expo SDK 58 upgrade. Not doable on stable today.
  * #115 eslint 10: eslint-plugin-react 7.37.5 (latest) peers eslint ≤^9.7 and calls the
    removed `context.getFilename` → crashes under 10 via eslint-config-expo; eslint-config-next
    15.5.x peers eslint ^9 and its @rushstack/eslint-patch refuses eslint 10 ("Failed to
    patch ESLint"). Needs upstream releases (plugin-react, config-next for Next 15).
  * #82 typescript 7.0.2: typescript-eslint 8.70.0 (latest) peers typescript `<6.1.0`;
    nothing supports TS 7 yet. Catalog-pinned across every package. Blocked upstream.
- Architect decisions: vitest spec bump in prototypes/ansari-expo/package.json goes on #133
  (prototype is live-serving, not unused). Part 2: close #112 #115 #82 as blocked-upstream
  with re-open triggers; nothing attempted.
