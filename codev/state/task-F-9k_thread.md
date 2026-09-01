# task-F-9k — root `prototype` convenience script

## Task
Add a root `package.json` script to run the ansari-expo prototype. One-line change +
README touch, standalone PR off `develop`. Prototypes architect reviews.

## Decision: self-installing alias (not fail-fast)
```json
"prototype": "cd prototypes/ansari-expo && pnpm install --ignore-workspace && pnpm start"
```
Chose the self-installing form over "fail with a message" because it *just works* from a
clean checkout with zero prior knowledge. `pnpm install --ignore-workspace` is a fast no-op
when `node_modules` is current (~0.3s), so the cost on the warm path is negligible, and it
is the only invocation that actually installs the prototype (bare `pnpm install` walks up to
the root workspace and skips `prototypes/` entirely). README Quick start updated to name the
new alias.

## Constraints held
- `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `turbo.json` — byte-identical (untouched).
- No new deps. Prototype stays out of workspace/turbo graph:
  `pnpm turbo run lint --dry=json | ... len(packages)` → **7** (unchanged before/after).
- Clean-checkout install writes an isolated `node_modules` + its own lockfile — both
  gitignored, so nothing leaks into git.

## Tests (real, from repo root; metro pinned to free port 8091 to dodge a sibling
worktree's expo already on 8081)
1. **node_modules present:** install "Already up to date. Done in 303ms" → Metro up →
   `Waiting on http://localhost:8091`. ✅
2. **clean checkout** (deleted `prototypes/ansari-expo/node_modules`): full install of 834
   packages "Done in 7.3s" → Metro up → `Waiting on http://localhost:8091`. ✅

Note: an early run without a pinned port exited 1 only because a sibling worktree (air-64,
pid 64653) held port 8081 and CI/non-interactive mode couldn't answer expo's port prompt —
environmental, not a script defect. Confirmed by re-running on a free port.
