# Rebuttal — Review/PR (Round 1)

**Verdicts:** Gemini APPROVE · Codex REQUEST_CHANGES · Claude REQUEST_CHANGES. Both change-requests were about **branch freshness / lifecycle hygiene**, not the security engineering (Claude independently verified the concurrency invariants and config-bypass closure and called the design correct). All points ACCEPTED.

---

## Codex + Claude (blocking) — branch 11 commits behind `develop`; new files never linted; doc conflict

ACCEPTED. `origin/develop` had landed "Open-source readiness (#6)" — Node 22 pin, `lint` → `eslint .` (+ `eslint.config.mjs`), `test:coverage`, and a CI job gating on lint/coverage/build — none of which existed on this branch.

- **Merged `origin/develop`** into `builder/spir-4`. `docs/self-hosting.md` (edited on both sides) **auto-merged cleanly** (my `ADMIN_EMAILS`/provisioning edits and develop's Node-22 edits were in different regions — no conflict markers). Develop also *removed* the Playwright e2e specs (#6 "test honesty").
- **Ran the new full gate on the merged tree**: `npm run lint` (0 errors, 7 pre-existing warnings), `npm run typecheck`, `npm test` **and** `npm run test:coverage` (**583 passed, 3 skipped**), `npm run build` — all green.
- **Fixed `tests/api.test.ts`** (a develop integration test that exercises the real login route against pglite): it landed after my Phase 3 schema change, so its hand-written `users` DDL lacked `is_admin`/`system_key`/`session_version` (drizzle enumerates all columns → failure), and it set only `JWT_SECRET` while auth now routes through validated `config` (full-env validation). Added the three columns and the required env vars. This is the same hand-DDL-sync discipline the plan established in Phase 3.

## Codex — spec/plan still `Status: draft`; unchecked checklists
ACCEPTED. Spec → `implemented (PR #15)`, Plan → `complete — all 9 phases`. (Acceptance is tracked in the review's Spec Compliance section, all checked.)

## Codex — untracked review/context artifacts
ACCEPTED. Committed the PR-review consultation outputs and the remaining porch `*-context.md` artifacts; working tree is clean.

## Codex — review says 2 skipped, repo has 3
ACCEPTED. Corrected the review's Flaky Tests section: **three** pre-existing `it.skip` in `tests/mcp-complete.test.ts` (104, 117, 247), all "route returns non-JSON streaming", unrelated to this spec.

## Claude (non-blocking) — accepted where cheap, disclosed otherwise
- **Migration index lock**: added a deploy note to `0003_lying_dracula.sql` (non-concurrent `CREATE UNIQUE INDEX` briefly locks `users` writes; use `CONCURRENTLY` at scale).
- **Password policy narrowness** (`score >= 3` still admits repeated-char passwords because length is scored twice): matches the spec's literal criterion; already noted as a residual. No change (would be a spec deviation).
- **Logout-with-expired-token 401**: already disclosed in the PR body and review as a client-visible residual; clients clear local tokens on a 401. No code change (plan pinned "only a valid access token proceeds").

---

## Result
Branch is now current with `develop` and passes the full CI-equivalent gate (lint + typecheck + test:coverage + build). PR #15 updated. The security design was verified correct by the reviewers; the blockers were mechanical and are resolved.
