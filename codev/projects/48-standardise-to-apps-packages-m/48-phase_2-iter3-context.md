### Iteration 1 Reviews
- gemini: APPROVE — Turborepo 2.x task graph, root scripts, CI workflow, and environment handling are correctly implemented and thoroughly verified against all Phase 2 acceptance criteria.
- codex: REQUEST_CHANGES — Turborepo integration is solid, but strict env handling silently drops two API runtime settings.
- claude: COMMENT — claude lane UNAVAILABLE for phase_2 — no review was produced. Not a verdict.

### Builder Response to Iteration 1
# Phase 2 — Rebuttals, iteration 1

| Reviewer | Verdict | Disposition |
|---|---|---|
| gemini | APPROVE | No issues. (Its first lane timed out; relaunched rather than accept a two-reviewer round.) |
| codex | REQUEST_CHANGES | 1 point — **accepted and fixed.** |
| claude | **LANE UNAVAILABLE** | **No review produced.** Not a verdict. See below. |

---

## codex — two env vars missing from `globalEnv`

**Accepted, fixed, and the root cause was a hole in my method rather than a slip.**

`FACILITATOR_REQUEST_BUDGET_MS` and `FACILITATOR_SYNTHESIS_RESERVE_MS` were absent from
`turbo.json`.

My derivation had been "parse the Zod schema + grep `process.env.X`". These two are read at
`apps/api/lib/facilitator/agent.ts:38` as **`process.env[name]`** — a *dynamic* index, with
the variable names appearing only as string literals passed to `envBudgetMs(...)`. A static
`process.env.X` pattern **cannot** see that, by construction.

So I had been claiming "derived, not guessed" while running a derivation with a blind spot.
The claim was true of the method I executed and false of the property I implied.

**Consequence had it shipped:** an operator setting `FACILITATOR_REQUEST_BUDGET_MS=60000`
would have it silently stripped by strict env mode, reverting to the 120s default, and
excluded from the cache hash. No error — the same silent-failure shape as everything else on
this project.

**Fixed as a class, not as two instances.** Grepped `process\.env\[` across `apps/`: exactly
two sites — the test helper (which *writes* env, not a read) and `envBudgetMs`, whose two
callers are precisely what codex named. So the missing set is **known** complete at two
rather than hoped complete.

**Proven in both directions**, because one direction cannot distinguish working from broken:

- Declared → turbo lists both under `configured`, and the build hash changes
  (`de7e59c6` → `a7647875`).
- Removed from `globalEnv` → `configured` shows **NONE** — silently dropped, exactly as
  codex described.

**Fixed the instructions, not just the list.** `turbo.json`'s re-derivation comment now
mandates three steps and explains why the third exists. Without that, the next person to
re-derive this list repeats my mistake exactly.

---

## claude — LANE UNAVAILABLE (this is not a verdict)

Three sequential attempts, each producing **zero bytes** before being killed: 31:49, 23:43,
59:17, against a **~5 minute** healthy baseline for this lane on this project. SIGTERM was
ignored every time; SIGKILL was required.

**Not "flaky."** The architect tested the lane independently during the outage — a trivial
prompt completed in **3.9s**, against lane-wide stats of 86% success / 151s average. The CLI
and model are healthy. Recording this as flakiness would be false, and would stop anyone
investigating a real defect.

**Root cause (architect's hypothesis; it fits every data point):** phase_2 is the phase that
introduced a **persistent, never-terminating task**. `turbo run dev` does not exit, by
design. An agentic reviewer with shell access that decides to *exercise* the dev task hangs
forever.

- Zero bytes, not partial output → a held pipe, not slow thinking.
- SIGTERM ignored, SIGKILL required → a child process group holding the pipe open.
- **The two file-agentic lanes are exactly the two that hung**: claude (Agent SDK, tool use)
  3×, gemini (agentic, `--sandbox`) once. codex completed normally — on precisely the phase
  that added a task which never returns.

Ruled out: `.turbo` dirs are trivial (124K, gitignored); the phase_2 diff is small (211
insertions, 5 files); the branch total of 232 files is large but phase_1 reviewed cleanly
three times against it.

**I did not fabricate a third verdict**, and the architect confirmed that refusal was
correct. The record file states plainly that no review exists.

### Compensating control — mandatory, and written down

Phase_2 is the highest-consequence phase in this plan: a wrong cache key ships wrong baked
`EXPO_PUBLIC_*` to production **while reporting a cache hit**. It has now had the least
review of any phase.

**Phase 6 must explicitly re-review `turbo.json`** — `globalEnv` completeness against all
three derivation methods, and the cache-key assertion proven in both directions. This is now
a phase 6 acceptance criterion in the plan, deliberately not left in my head.

---

## Process changes adopted

1. **Kill a silent lane at ~10 minutes of zero bytes**, not an hour. Three sequential
   hour-long hangs was the expensive failure here — far more costly than the missing verdict.
2. **Liveness means progress, not existence.** Compare bytes-written and elapsed against a
   known-good baseline from the same batch; a live PID proves nothing.
3. **Never let porch's phase pointer drift.** It scopes the phase-scoped review diff, so a
   stale pointer silently targets the wrong content — a failure that would look exactly like
   a review passing.

---

## Verification at close of phase 2

- Suite: 66 files / **623 passed / 3 skipped**, matching the `develop` baseline.
- `pnpm build` twice → **FULL TURBO** (3 tasks, 11ms).
- `pnpm dev` verified by a human: both apps up, Expo TUI keypresses (`i`/`a`/`w`/`r`) working.
- Emitted CI check names verified against `develop`'s required list programmatically.


### Iteration 2 Reviews
- gemini: APPROVE — Turborepo 2.x task graph, complete globalEnv caching, root script rewires, and CI integrations are cleanly implemented and fully aligned with the plan.
- codex: REQUEST_CHANGES — Task graph is sound, but strict environment filtering breaks documented Sentry source-map uploads.
- claude: APPROVE — Phase 2 is complete and correct — I independently re-derived globalEnv, proved the cache key in both directions, verified the gen:types edge cold and warm, and ran the suite, api CI command, and frontend build to green.

### Builder Response to Iteration 2
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


### IMPORTANT: Stateful Review Context
This is NOT the first review iteration. Previous reviewers raised concerns and the builder has responded.
Before re-raising a previous concern:
1. Check if the builder has already addressed it in code
2. If the builder disputes a concern with evidence, verify the claim against actual project files before insisting
3. Do not re-raise concerns that have been explained as false positives with valid justification
4. Check package.json and config files for version numbers before flagging missing configuration
