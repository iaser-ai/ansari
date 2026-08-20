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
