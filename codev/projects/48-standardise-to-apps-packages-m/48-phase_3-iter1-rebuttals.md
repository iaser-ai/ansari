# Phase 3 — Rebuttals, iteration 1

| Reviewer | Verdict | Disposition |
|---|---|---|
| gemini | APPROVE | No issues. |
| codex | REQUEST_CHANGES | 2 evidence requests — **both satisfied.** |
| claude | REQUEST_CHANGES | 1 serious defect + 1 nit — **both fixed.** |

## claude #1 — shared package contents were NOT in the cache hash (serious)

**Accepted. This is the most consequential find of the phase, and I had missed it entirely.**

A `workspace:*` dependency puts a package in the dependency **graph**, but its file
**contents** are not part of a consumer task's hash. Verified before fixing, on both shared
packages:

```
edit packages/tsconfig/base.json    -> ansari-api#typecheck  30aa0865 -> 30aa0865  (unchanged)
edit packages/eslint-config/base.js -> ansari-api#lint       7f40a12e -> 7f40a12e  (unchanged)
```

So a warm cache would replay stale results against a changed shared config: **green run, no
signal, wrong answer** — the exact failure this spec exists to prevent, introduced in the two
phases whose entire purpose was sharing configuration.

Claude predicted the same gap would apply to phase 4's eslint package. It did; I confirmed
that rather than assuming it.

**Fix:** `globalDependencies` entries for `packages/tsconfig/*.json` and
`packages/eslint-config/*.js`. **Proven in both directions** — after the fix both hashes move
(`dbfc7ee3 → ccbb8fd9`, `38287772 → d760c345`); the measurements above are the other
direction. Added as a **phase 6 criterion**, because it recurs for any shared package added
later and is invisible without an explicit check.

### Why I missed it

Phases 3 and 4 proved *behaviour preservation* — resolved tsconfig identical, eslint
violation sets identical with non-zero denominators — and both proofs were sound. I never
asked whether the **cache** could tell the shared config had changed. Thorough along one
axis, absent along another, and the missing axis was the one that matters.

This is the fourth instance of one shape on this project: unresolved eslint config reporting
zero violations; warm cache skipping codegen; undeclared env excluded from the hash; shared
config excluded from the hash. Everything that has gone wrong has **reported success while
not doing its job**.

## claude #2 — `@ansari/tsconfig` broke alphabetical ordering (minor)
**Accepted, fixed.** Both apps' `devDependencies` are now genuinely sorted — verified with
`keys == sorted(keys)` rather than by eye.

## codex — record the evidence, do not assert it

Both points were requests for **evidence**, not defects, and the criticism is fair: "I did
it" is not evidence.

1. **Frontend Docker rebuild.** Re-run against the current tree (which now also carries
   phases 4 and 5, so it covers more than phase 3 alone): `FRONTEND_EXIT=0`, and the log
   shows the real path exercised — `COPY packages packages` → `pnpm install
   --frozen-lockfile --filter ansari-frontend` → `Exported: dist`. `API_EXIT=0` alongside it.
2. **`pnpm install --frozen-lockfile`.** Re-run and recorded: *"Lockfile is up to date,
   resolution step is skipped / Already up to date"*, exit 0.

## claude's caveat, acknowledged

Claude noted it could not verify the Docker builds or the frozen install itself because the
worktree was **contaminated by in-flight phase 4 changes** while it reviewed. That is a real
limitation of my working style, not a reviewer failing — I built phase 4 while phase 3 was
under review. The evidence above is recorded precisely because the reviewer could not
gather it.

## Verification after fixes
`pnpm lint` 3 tasks · `pnpm typecheck` 4 tasks · suite 66 files / 623 passed / 3 skipped ·
`pnpm install --frozen-lockfile` clean · both Docker images `EXIT=0`.
