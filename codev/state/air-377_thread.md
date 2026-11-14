# air-377 thread — mcp: no RAILWAY_* reads

- Found an existing guard already: apps/api source-scan 6 (#314), with a one-entry RAILWAY_ALLOWLIST for apps/mcp's runtime-config (#377). Widened it instead of adding a second guard: scope is now every apps/*/src, apps/*/lib and packages/* (discovered dynamically) plus the api/auth scripts it already covered. Allowlist deleted; no file is exempt. 0 hits in 269 files.
- apps/api turbo.json test + test:coverage inputs widened to match (apps/*/src, apps/*/lib, packages/**). Verified: a frontend/lib or packages/auth edit moves both hashes; revert restores them.
- Negative test: a real file packages/types/src/planted-377.ts reading process.env.RAILWAY_X failed 2 scan-6 tests; removed, all pass.
- release-doc.test.ts pinned the old "`ANSARI_RELEASE` is **not** set" sentence; now pins the new dashboard-reference row.
- Deploy note: owner must add ANSARI_RELEASE=${{RAILWAY_GIT_COMMIT_SHA}} on mcp-staging; until then the release label is the default.
