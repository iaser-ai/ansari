# Phase 4 — Rebuttals, iteration 1

| Reviewer | Verdict |
|---|---|
| gemini | **APPROVE** |
| codex | **APPROVE** |
| claude | **APPROVE** |

Unanimous on the first iteration. No issues raised; nothing to rebut.

## What the phase delivered

`@ansari/eslint-config` — deliberately thin (build-output ignore globs only), consumed by
both apps.

**Behaviour preservation, with non-zero denominators.** An empty-to-empty diff proves
nothing, so the linted-file counts matter as much as the violation counts:

| app | linted files | violations | set identical |
|---|---|---|---|
| api | 77 → 77 | 7 → 7 | yes |
| frontend | 6 → 6 | 0 → 0 | yes |

**The env guard stayed in the api and is provably intact.** `eslint-env-guard.test.ts`
passes 9/9 — it lints virtual files through the *real composed* config, so it demonstrates
the `no-restricted-properties` rule survived being layered on a shared base rather than
merely still existing in the file. Its allowlist names backend-relative paths
(`lib/config.ts`, `drizzle.config.ts`) that are meaningless in an Expo app: security rules
belong where their allowlist is meaningful.

**The CJS→ESM conversion had a real, loud cost.** `eslint-config-expo/flat` is a directory;
`require()` resolves it via `index.js`, ESM `import` does not
(`ERR_UNSUPPORTED_DIR_IMPORT`). Fixed with an explicit `flat.js` import and a comment
recording why. A hard error is the good outcome here — the alternative would have been a
config that silently resolves to zero rules.

**Guarded the silent-zero case anyway.** Wrote a throwaway file containing an unused
variable, confirmed the frontend config reported it, deleted the probe. "Config is clean"
and "config isn't running" are indistinguishable in a violation diff; only a deliberate
violation separates them.

## Carried in from phase 3's review

The `globalDependencies` fix that put `packages/eslint-config/base.js` into the cache hash
was applied during phase 3's iteration 1, after claude found the same gap for
`packages/tsconfig`. Without it, editing the shared eslint base left `ansari-api#lint` at an
identical hash (`7f40a12e → 7f40a12e`), so a warm cache would have replayed stale lint
results against a changed config.
