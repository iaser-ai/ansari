# Phase 2 — Rebuttals, iteration 2

| Reviewer | Verdict | Disposition |
|---|---|---|
| gemini | APPROVE | No issues. |
| codex | REQUEST_CHANGES | 1 point — **accepted and fixed.** |
| claude | **APPROVE** | 4 non-blocking findings — **all accepted and actioned.** |

The claude lane returned this round (5763 bytes) after producing nothing three times in
iteration 1. Phase 2 has now had four review rounds across two iterations, making it the
*most*-reviewed phase in the plan rather than the least.

---

## codex — `SENTRY_AUTH_TOKEN` missing from `globalEnv`

**Accepted, fixed — and it exposed a fourth blind spot, not just a missing string.**

`SENTRY_AUTH_TOKEN` appears **nowhere in our source**; grep confirms zero hits across
`apps/**`. `withSentryConfig` consumes it internally at build time for source-map uploads,
and `docs/self-hosting.md:86` documents it as "build-time only".

So all three of my existing derivation methods were blind to it **by construction**:

1. Zod schema — not in the schema.
2. Static `process.env.X` grep — not in our code.
3. Dynamic `process.env[` grep — not in our code.

The missing category is **env consumed by dependencies**, where documentation is the only
authority because our source never names the variable.

**Fixed as a class.** Added a repeatable cross-check comparing the documented env surface
(`docs/self-hosting.md` table + `apps/api/.env.example` keys — names only, never values)
against `globalEnv`. Before: exactly one gap. After: **none**. Known complete, not hoped
complete.

`turbo.json` now documents **four** required derivation steps, each annotated with the real
variable lost by skipping it — step 3 lost the facilitator budget vars, step 4 lost this one.
A future reader inherits the failure history, not just a procedure.

**Verified:** appears in turbo's `configured` list; moves the build hash
(`96403d2b` → `f7b032dd`).

---

## claude — APPROVE, four non-blocking findings

Claude independently re-derived `globalEnv`, proved the cache key in both directions,
verified the `gen:types` edge cold **and** warm, and ran the suite, the api CI command, and
the frontend build.

### 1. `typecheck` + `build` race inside `ansari-api` — the most valuable of the four
**Accepted.** `apps/api/tsconfig.json:24` includes `.next/types/**/*.ts`, which a concurrent
`next build` rewrites underneath `tsc`. Claude hit it once in two runs of **this plan's own
acceptance command**: `typecheck exited (2)`, passing on re-run. It predates the task graph
(the same overlap existed with parallel `pnpm` runs) but turbo makes concurrency the default,
so it surfaces far more often. CI is unaffected — separate sequential steps.

Actioned in the place it will actually be read: documented in `turbo.json` next to the
`typecheck` task, **and** Phase 6's criteria now forbid the combined invocation and
explicitly warn against dismissing a typecheck failure there as "just a flake".

Phase 6 re-runs exactly that command. Without this, whoever hit it would have mis-diagnosed
it — and "intermittent, passes on re-run" is precisely the shape that gets papered over.

### 2. `_comment_build:web` sat inside `"scripts"`
**Accepted — my mistake, and a sloppy one.** As written it was a listed, runnable script
whose body is an English sentence. I reached for a convention package.json genuinely has
(`"//"`) and put it in the wrong object. Moved to a top-level `"//"` key, out of the script
namespace.

### 3. `gen:types` narrowed `inputs` will go stale-silent
**Accepted.** `["src/global.css", "package.json"]` is correct *today* — `global.css`'s only
`@source` points into `node_modules`, covered by the `pnpm-lock.yaml` global dependency. The
day someone adds a repo-local `@import`/`@source`, edits to that file stop busting the cache
and the generated dts silently lags. Caveat added beside the task, naming the fix
(add the file, or fall back to `$TURBO_DEFAULT$`).

### 4. `docs/self-hosting.md` was in phase 2's file list but untouched
**Accepted.** Leaving it app-scoped is correct — it is an operator runbook executed *from*
`apps/api`, the same reasoning as the recorded `RELEASE.md` decision, and its one root-level
instruction (`pnpm install` at the repo root) was already right. But that rationale existed
only in my head, which makes it indistinguishable from a silently skipped plan item.

Now a Phase 6 criterion, so its absence from phase 2's diff reads as a decision rather than
drift.

### 5. Frontend job name (noted, not actioned)
Claude notes `frontend (lint, typecheck)` now also builds, and that it is the one check
name that *could* be corrected without admin access since it is not protection-required.
Left frozen per the architect's explicit decision; the lag is documented in `ci.yml`.

---

## A data point on the wedge diagnosis

Claude's lane completed this round on the **same phase** with the **same** never-terminating
`dev` task that wedged it three times in iteration 1 (31:49 / 23:43 / 59:17, zero bytes each).

That refines the architect's hypothesis rather than refuting it: the mechanism is "an
agentic reviewer that *decides* to exercise the dev task hangs forever", and whether it so
decides is **stochastic**. Three hangs followed by a completion fits a probabilistic
trigger; it does not fit "this phase always hangs".

Recorded this way deliberately — claiming the prediction was cleanly confirmed would
overstate the evidence, and the distinction matters for phases 4–6, where a lane may hang
once and complete on retry.

---

## Verification at close

Run with `typecheck` and `build` as **separate** commands, per the new rule:

- `pnpm typecheck` → 3 tasks; `pnpm build` → 3 tasks.
- Suite: 66 files / **623 passed / 3 skipped**.
- `pnpm build` twice → **FULL TURBO**.
- Documented-env cross-check → **no gaps**.
