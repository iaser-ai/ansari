# Phase 2 — Rebuttals, iteration 3

| Reviewer | Verdict | Disposition |
|---|---|---|
| gemini | APPROVE | No issues. |
| codex | REQUEST_CHANGES | 1 point — **accepted and fixed.** |
| claude | APPROVE | 3 minor — **all accepted and fixed.** |

Every finding this round was **a claim I wrote that was false**, not missing code. That is a
worse class than the earlier env omissions: a wrong comment actively misleads the next
reader, and nothing tests a comment.

## codex — `apps/frontend/README.md` documented a workflow this phase broke

**Accepted.** It said app-local `pnpm typecheck` "regenerates uniwind types, then
tsc --noEmit". True until I de-chained `typecheck` in this very phase — the ordering is now
a Turbo `dependsOn` edge that applies only through the graph. Drift I introduced.

**I then nearly shipped a false fix.** I wrote that skipping `gen:types` makes `tsc` "fail on
the missing `uniwind-types.d.ts`" — verified it, and got **EXIT=0**. The committed
`types.d.ts` supplies Expo ambient types so `tsc` passes; the generated file only adds
uniwind's `UniwindConfig` theme tuple.

The real consequence is a **silently weaker typecheck**: theme-name mistakes go uncaught
while the command still reports success. Worse than the loud failure I assumed. Corrected to
the verified behaviour, with the EXIT=0 evidence stated in the doc itself.

## claude — three more inaccurate comments of mine

1. **`"//"` claimed the in-script `gen:types` "becomes a Turbo cache hit".** It does not —
   `pnpm run` bypasses Turbo entirely. **Verified: one forced build prints "Artifacts
   generated" twice.** Reworded to duplicate-but-idempotent-and-required-for-Docker.
2. **`build:web` is effectively unreachable via the graph** — frontend `build` shells
   straight to `pnpm run build:web`, so ordering comes from `build`'s own `dependsOn`. Its
   config applies only to a direct `turbo run build:web`. Documented so nobody relies on it.
3. **`.env.ci` in `inputs` is redundant** — git-tracked, so `$TURBO_DEFAULT$` covers it.
   Harmless, but I implied a safety net. Relabelled documentation-only.

## Lesson adopted

Rigorous about proving behaviour, careless about proving claims. Four comments in this phase
asserted untested mechanisms — cache-hit behaviour, failure modes, reachability — each
plausible, each wrong. Comments now get the same discipline as scans: run it and read the
output before writing the sentence.

## Verification
66 files / 623 passed / 3 skipped; `pnpm build` twice → FULL TURBO.
