# Builder thread — pir-121 (Issue #121: Refresh prototypes/ansari-expo from the Replit design)

## 2026-09-07 — Plan phase

Investigated `~/Downloads/Ansari/artifacts/ansari/` (upstream sha `6c58e51`, confirmed via
`git log -1` in that checkout) against our local `prototypes/ansari-expo`. Key findings baked
into the plan (`codev/plans/121-refresh-prototypes-ansari-expo.md`):

- `lib/config.ts` in the Replit tree has zero consumers outside the excluded `server/`/`scripts/`
  — not porting it.
- `lib/insets.ts` and `lib/time.ts` (local) become dead code once their only callers
  (`AuthForm.tsx`, `HistorySheet.tsx`, the old `app/index.tsx`/`chat/[id].tsx`) are
  replaced/removed — deleting both.
- The vendored `@workspace/api-client-react` already exports everything the new design's ~11
  import sites need (checked against `vendor/api-client-react/generated/api.ts` +
  `api.schemas.ts` directly) — no stubbing needed, just a tsconfig path alias + Metro
  `resolver.extraNodeModules` entry.
- Keeping vitest (repo standard) over Replit's `node --test`; only 3 `lib/*.test.ts` files to
  port.

Plan approved by human via architect relay.

## 2026-09-07 — Implement phase

Ported the design directory-by-directory per the plan. Two bugs caught during typecheck (not
present in the plan — worth noting for future similar ports):

1. **Copy-loop bug**: the `UPDATED_COMPONENTS` bulk-copy loop silently no-op'd on the first
   attempt (a `for c in "$VAR"` quoting bug caused `cp` to error and abort without exiting the
   script), so 11 "updated" components (`AnswerMessage.tsx`, `ChatInput.tsx`, etc.) stayed on
   their old local versions. Caught only because `pnpm typecheck` failed with import errors
   (`AnswerMessage.tsx` importing `parseMarkdown`/`firstStrongIsRtl` from the new `lib/markdown.ts`,
   which no longer exports those — it exports the Replit API instead). Re-ran the loop correctly
   (unquoted word list) and the errors resolved. **Lesson**: after any bulk multi-file `cp`/`mv`
   loop, verify the actual file *contents* changed (e.g. `diff` against source), not just that the
   command exited 0 — a shell quoting bug can make a loop silently touch zero files.
2. **Missing `expo-clipboard` dependency**: my plan's dependency diff (comparing Replit's vs
   local `package.json`) only listed `@react-navigation/native` and `expo-navigation-bar` as new
   — missed `expo-clipboard`, which `lib/clipboard.ts` (ported, used by the new `AnswerMessage.tsx`)
   needs. Caught by `pnpm typecheck`'s `Cannot find module 'expo-clipboard'`. Re-diffed the full
   dependency sets programmatically (not by eyeballing) after the fact and found no further gaps
   (`subset-font` is the only other Replit-only dep, and it's legitimately unused — only imported
   by the excluded `scripts/build-web-fonts.js`).

Also found and fixed one latent type-safety gap in the ported `lib/ambientNight.test.ts`: Replit
ran it via `node --test` with raw `.ts` imports (Node's type-stripping, no actual type-checking),
so a `t.kind === 'night'` runtime check via `expect().toBe()` (which isn't a TS type guard) never
got caught narrowing a discriminated union incorrectly. Added an explicit `if (t.kind !== 'night')
return;` right after the `expect()` to narrow for TS while keeping the original assertion's
failure message. This is a **general risk worth remembering**: porting any `node --test` suite to
a typechecked vitest run can surface previously-invisible type errors in test code itself, not
just in application code.

`pnpm typecheck` and `pnpm test` (218 tests, 12 files) both clean after fixes.
`expo export --platform web` bundles clean (1538 modules). Started `expo start --web` and
confirmed the page serves (HTTP 200, correct title, bundle loads with no server-side errors) —
could not get a real screenshot/visual confirmation because the claude-in-chrome browser
extension wasn't connected in this environment session.

### Blocker: porch's `implement`-phase `build` check (`npm run build` → `turbo run build`
### across the whole monorepo) fails on `apps/auth`

`apps/auth`'s `tsdown` build fails with `Failed to import module "unrun". Please ensure it is
installed` — `unrun` is an *optional* peer dep of `tsdown` (confirmed in `pnpm-lock.yaml`) that
plain `pnpm install --frozen-lockfile` doesn't pull in. Confirmed unrelated to this branch before
escalating:
- Branch's merge-base with `origin/develop` **is** `origin/develop`'s current tip (`10c298b`) —
  no drift.
- `apps/auth/package.json` untouched since the app was created (`21173e1`, PIR #59) — this
  branch never touches `apps/auth`, root `package.json`, or `pnpm-lock.yaml`.
- `prototypes/ansari-expo` is deliberately outside the Turborepo graph (see its own README), so
  this diff provably cannot affect `turbo build` for any package.

Architect independently reproduced on a clean `develop` checkout and confirmed CI's `auth` job is
green on `develop` tip and every recent run — so it's a **local/macOS-only tsdown/unrun toolchain
gap**, filed as **issue #122**. Per architect's direction: not fixing `apps/auth` here (out of
scope), opening the PR now so its CI run independently re-verifies `apps/auth` (unaffected by
this branch), and the architect will review the diff + run the prototype directly, then advance
the `dev-approval` gate manually since porch's `build` check can't pass locally in this
environment. Will reference #122 in the review phase's Lessons Learned when that phase runs.
