# air-22 — Codify RELEASE.md (develop→main promotion + smoke test + migration runbook)

## 2026-08-02 — Implement phase start
- Strict AIR, issue #22. Porch: implement phase, criteria build+tests.
- Branch was 80 commits behind origin/develop (missing Spec 4 = migrations 0003, grant-admin
  bootstrap, session_version). Merged origin/develop in first — RELEASE.md must reference that
  work (deploy order: migration → grant-admin → deploy is from spec 4's verify phase).
- Sources mined: spir-4 thread verify section (2026-08-02 real verification: migration chain
  0000→0003 on disposable Postgres 16, grant-admin end-to-end, runbook confirmed by architect:
  inspect system rows → psql 0003 → grant-admin → deploy); arch-critical.md (never db:push);
  docs/self-hosting.md (env, health-as-deploy-gate, Railway root dir backend/).
- GAP: the two production domains for post-deploy health checks are NOT recorded anywhere
  in-repo (issue says "health checks both domains" from architect notes). Asked architect via
  afx send; proceeding with clearly-marked placeholders so the PR isn't blocked on the answer.
- Plan: RELEASE.md at repo root (checklist + smoke sequence + migration variant + rollback),
  plus backend/tests/release-doc.test.ts — consistency checks that the doc's npm scripts,
  file references, and endpoints actually exist (and that db:push is never recommended).

## 2026-08-02 — Implemented
- Architect answered the domain question mid-flight: https://api.askansari.ai +
  https://api-35.ansari.chat (both → Railway service 'backend'). Pinned exactly; the test
  asserts both present AND that the wrong guess (api.ansari.chat) never reappears.
- RELEASE.md written: deployment model (ff-only promotion), 8-step standard checklist,
  6-step smoke sequence (build → fresh-Postgres-16 migrate → boot → health → auth round-trip
  → real streamed chat w/ tool use), migration variant (inspect → psql → grant-admin bootstrap
  → deploy; db:push prohibited, backward-compat requirement), rollback (Railway redeploy; DB
  = corrective forward migration).
- backend/tests/release-doc.test.ts: 6 tests — doc exists; every `npm run X` exists in
  package.json; every db:push mention is a prohibition; every /api/ path maps to a real
  route.ts; referenced repo files exist; domains pinned. All pass.
- porch check 22: build ✓ tests ✓. Committing → porch done → PR phase.

## 2026-08-02 — PR gate
- PR #28 opened (base develop) with full review in body. porch checks pr_exists + e2e_tests ✓.
- Gate 'pr' requested; architect notified via afx send. STOPPED — waiting for human approval.
