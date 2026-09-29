# air-125 — Node version floor (issue #125)

Protocol: AIR (strict). Config-only change, no spec/plan/review files.

## What & why
Root cause behind #122: `tsdown@0.22.14` needs Node `^22.18.0 || >=24.11.0`. Below 22.18 it
falls back to `unrun` (uninstalled) and the auth build fails. Repo let a dev land on an
unsupported Node with no signal.

Issue proposed THREE changes; change #1 (`.nvmrc` pin) was DROPPED by human decision
(architect main, 2026-09-07) — see "Decision: .nvmrc reverted" below. Shipping TWO:
1. `engines.node` `>=22.0.0` → `>=22.18.0` — declares the true floor. Applied to all THREE
   manifests that declare it: root, apps/api, apps/auth (auth is the one that actually breaks;
   api raised for consistency so the declared floor doesn't disagree across the repo).
2. `pnpm-workspace.yaml` `engineStrict: true` — turns the `engines` WARN into a hard refusal.
   Chosen over `.npmrc engine-strict` because `.npmrc` stops enforcing on pnpm >=11.

Explicitly NOT done: adding `unrun`/`jiti` (rejected in #125).

## Decision: .nvmrc reverted to `22` (change #1 dropped)
I pushed back on pinning `.nvmrc` to 22.19.0. Key distinction I surfaced before writing final
code: `engineStrict` enforces `engines.node` which is ALREADY a minimum (`>=22.18.0`) — pnpm
forces no exact minor/patch — and pnpm NEVER reads `.nvmrc`. The only exact value in play was
`.nvmrc`, which just advises `nvm` and pins CI (`node-version-file`).
Human decision: keep `.nvmrc` as `22`. Rationale (in PR body): before this PR, `.nvmrc` `22`
was dangerous — it floats to the newest locally-installed 22.x and nothing caught the resulting
divergence (that's how #122 happened). With `engineStrict` landed, that divergence is now caught
loudly at install time (`ERR_PNPM_UNSUPPORTED_ENGINE` naming the expected version), self-
correcting: dev on 22.16 runs `nvm use` → 22.16 → `pnpm install` → clear error → installs 22.19
→ proceeds. So the exact pin is no longer load-bearing. Consequence: this PR does NOT change CI
behaviour — CI keeps floating to newest 22.x. The CI-pin caveat is REMOVED from the PR body.
Architect will amend #125 to record change #1 was dropped.

## Verification (both directions, real user path = bare root install)
RE-RUN against the final shipping tree (`.nvmrc = 22`) — not carried forward from the pinned tree.
- FAIL on Node 22.16.0: `corepack pnpm@10.33.0 install --frozen-lockfile` (cwd = repo root) →
  `ERR_PNPM_UNSUPPORTED_ENGINE`, "Expected version: >=22.18.0  Got: v22.16.0", exit 1.
  (corepack because global pnpm lives under the 22.19.0 nvm prefix; SAME pinned pnpm@10.33.0 in
  both runs, so Node is the only variable.)
- PASS on Node 22.19.0: `pnpm install --frozen-lockfile` → exit 0;
  `pnpm --filter ansari-auth build` → Build complete, dist/index.mjs 489.62 kB, exit 0.
- Confirmed no package under apps/* or packages/* declares a floor lower than 22.18.0.

No unit tests: purely declarative config; the both-directions install check is the verification.

## CI note
CI is UNAFFECTED. `.nvmrc` stays `22`, so all 3 `setup-node` steps keep floating to the newest
22.x exactly as today. (Earlier draft pinned `.nvmrc` and carried a CI-behaviour caveat; that
pin was reverted, so the caveat is gone — this was the main review risk and it no longer exists.)

## Git-history note
Original commit 7879e84 ("pin Node floor — .nvmrc 22.19.0 …") shipped the pin. porch then added
two state commits (record PR #126, pr phase-transition). The `.nvmrc` revert lands as a SEPARATE
commit on top rather than an amend — amending would have rewritten porch's state commits, which
builders must not do. So PR #126 reads: feat(pin) → porch → porch → revert(.nvmrc pin).

## Architect
main reviewing personally (root config). Coordinated live on: .nvmrc version, root-manifest
scope, real-user-path test requirement, and the final human decision to drop the .nvmrc pin.
