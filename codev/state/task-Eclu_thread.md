# task-Eclu — trimmed dep-bump PR (supersedes #133)

## 2026-09-30 — setup
- Task: replace PR #133 with a trimmed PR carrying only turbo 2.10.12 (f5ce870) and the
  prototypes/ansari-expo vitest ^4.1.11 spec bump (1ccd53a). Waleed approved the trim.
- Dropped on purpose: rn-gesture-handler 3 (#119), rn-screens (#117), rn-safe-area-context
  (#118) — all leave Expo SDK 57's bundled versions, go with the SDK upgrade; better-auth
  1.7.3 (#114) — held for the Spec 60 / PR #148 plan, verified against 1.6.27.
- Branch `builder/task-Eclu-dep-bumps-trimmed` off origin/develop (9eb6bf2).
- Surprise: the turbo cherry-pick applied CLEANLY despite develop having moved. Still
  regenerating pnpm-lock.yaml via `pnpm install` per instructions to make sure it matches.
- 1ccd53a also appended to codev/state/task-wzFk_thread.md (that builder's own log, already
  on develop at an older revision). Dropped that hunk — only package.json is in my commit.
- Stripped the Co-Authored-By trailers from both cherry-picked messages (Waleed's rule).

## 2026-09-30 — verified, PR
- `pnpm install` regen: lockfile unchanged (cherry-picked lock already matched develop).
  `--frozen-lockfile` clean.
- turbo lint/typecheck/test/build with both .env.ci files, --force: 16/16 tasks. api 854
  passed / 3 skipped, auth 8/8, lint 0 errors (7 pre-existing warnings), builds green.
- Opening PR against develop; superseding #133 but leaving it open per instructions.
- PR #210 opened. CI green: api, auth, frontend, gitleaks all pass. Not merged; #133 left
  open. Architect notified.
