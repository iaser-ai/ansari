# Implement 3 — Rebuttal to iteration-1 implementation review

**Verdicts**: Gemini APPROVE · Codex COMMENT · Claude APPROVE.

No REQUEST_CHANGES; all six phases verified complete (audit clean, gate green, action SHAs +
gitleaks checksum confirmed against upstream by Claude). Codex raised one stale-doc COMMENT and Claude
listed five non-blocking minors. I applied the worthwhile ones in a single review-fix commit.

## Applied

1. **Stale CI description in `docs/self-hosting.md`** (Codex KEY_ISSUE; Claude #4). VERIFIED at
   `self-hosting.md:107` ("CI runs exactly typecheck + test + build"). Fixed: the verification block now
   lists `npm run lint` first, and the prose reads "CI runs lint + typecheck + test (with coverage) +
   build".

2. **`self-hosting.md` healthcheck behavior change undocumented** (Claude #4). The 503-on-dead-DB is the
   one genuine behavior change and self-hosters are who it surprises. Added: a note on the `curl`
   example that `/api/health` now needs a live `DATABASE_URL` (200 only if `SELECT 1` answers, else
   503), and a paragraph under Deployment that the Railway healthcheck is now a real deploy gate (a bad
   `DATABASE_URL` fails the deploy and rolls back).

3. **`health/route.ts` dangling promise on timeout** (Claude #1). Real: when the 2s timer wins, the
   losing `db.execute` promise rejects later (~pool 5000ms) as an unhandled rejection on every dead-DB
   probe — log noise (Next's handler prevents a crash), but avoidable. Fixed with a one-liner:
   `const query = Promise.resolve(db.execute(sql\`SELECT 1\`)); query.catch(() => {});` then race on
   `query`. The race still surfaces a fast query failure first (503 path unchanged; all 4 health tests
   still pass).

4. **`CONTRIBUTING.md:26` "CI runs exactly these"** (Claude #2). "Exactly" was marginally untrue since
   CI runs `test:coverage`. Reworded to "CI runs these — it runs the test step with coverage".

## Not applied (with reason)

5. **`eslint .` lacks `--max-warnings`** (Claude #3). Claude flagged this explicitly as "not
   spec-required … a follow-up thought, not a change request." The spec pinned the script value to
   exactly `eslint .`, so I'm honoring that and leaving warning-gating as a future decision. The 8
   `no-unused-vars` warnings are pre-existing and left per the no-drive-by-refactors constraint.

6. **Hand-written DDL in `tests/api.test.ts` can drift from `db/schema/`** (Claude #5). Claude accepts
   it as a faithful mirror of the established `token-grace.test.ts` pattern; keeping it for consistency
   with the rest of the suite. A schema change wouldn't fail these tests, which is the known trade-off
   of the project's chosen pglite pattern — out of scope to re-architect here.

## Net
Gemini and Claude approved; Codex's single stale-doc comment and Claude's actionable minors are fixed.
Gate remains green (lint 0, typecheck 0, 470 passed / 3 skipped, build compiles, prod audit 0).
