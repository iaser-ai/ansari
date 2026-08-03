# air-21 thread — Document boot-blocks-on-unreachable-DB in docs/self-hosting.md (issue #21)

## Implement

- Worktree was branched from develop **before** PR #15 (spec 4) merged, so
  `assertConfiguredAdminsExist` didn't exist here. Merged `origin/develop`
  (1915e60) so the docs describe the real code.
- Added a "Troubleshooting: crash loop at boot (admin bootstrap check)" section
  to `docs/self-hosting.md`: symptom (DB blip at boot → crash loop on
  restart-on-crash platforms, looks like a provisioning error), triage table
  keyed on the two distinct error texts (DB-unreachable vs missing/unflagged
  admin), position-not-address error labeling, and a timing note separating the
  deploy-time presentation (healthcheck rollback) from the restart-time one
  (crash loop). Cross-linked from "Provisioning admins" step 3.
- Test: `backend/tests/self-hosting-docs.test.ts` — drift guard asserting the
  triage table's distinguishing phrases exist in BOTH `startup-checks.ts` error
  text and the docs, so either side changing breaks CI.
- `porch check 21`: build ✓, tests ✓.

## PR

- PR #23 opened against develop (review embedded in PR body per AIR).
- porch pr-phase checks passed (pr_exists, e2e_tests); `porch gate 21` requested.
- Waiting at pr gate for human approval; architect notified via afx send.
