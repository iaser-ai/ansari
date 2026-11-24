# task-0guM — next 15.5.29 + sharp >= 0.35.5 security update for apps/api

Brief from the security architect (2026-11-24, owner's word): close the seven open Dependabot alerts on
`next` (one critical) by moving apps/api to next 15.5.29 and forcing sharp >= 0.35.5. Two PRs: A to
develop, B a hotfix to main (branched from origin/main c314fa59).

## PR A (develop)

- Change: apps/api `next` floor ^15.5.25 → ^15.5.29; workspace override `sharp: ^0.35.0` → `^0.35.5`
  (comment now also cites GHSA-wq5f-xc86-pv6w, the open sharp alert #491).
- Finding: on develop, next's runtime sharp was 0.35.4 (the lockfile held 0.35.4 AND 0.35.5; next's
  snapshot pointed at 0.35.4). Shown both locally and inside the real api image (node:22-slim, glibc 2.36).
- Lockfile churn gotcha: regenerating from develop's lockfile with BOTH edits in one `pnpm install`
  also deduped tslib 2.8.1 → 2.9.1 and a browserslist caniuse-lite (unrelated). Doing it in two steps
  (next floor first, `pnpm install --lockfile-only`; then the override, `pnpm install`) gives only the
  next/sharp family: step 2 moves nothing. Use the two-step when re-merging develop.
- Test gotcha: `vitest run` without CI's placeholder env fails ~41 api tests ("Environment validation
  failed"), identically on clean develop. ci.yml exports apps/api/.env.ci first; doing the same gives
  1464 passed / 3 skipped, matching develop.
- `images.unoptimized: true` trial (reverted, proposal only): every /_next/image request → 404, sharp
  never reached.
- Merged develop twice (434 vitest at 2405c760, then 435 react at f827e38a); lockfile regenerated each
  time with pnpm, never hand-merged.
