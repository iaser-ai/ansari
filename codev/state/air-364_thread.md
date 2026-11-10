# air-364 thread — apps/mcp Railway staging record

- 2026-11-11: Added `apps/mcp/railway.toml` (dockerfile build, repo-root context, watch paths incl. `packages/**` and `.dockerignore`, `/health`, ON_FAILURE x3; healthcheckTimeout 300 like the others — the issue did not name a timeout).
- RELEASE.md: mcp Dockerfile row, watch-path line, `/health` in deploy settings, mcp service paragraph with the staging env table.
- Fixed "both images copy it" (stale: four TS images now) in arch.md and arch-critical.md; added a staging deployment note to apps/mcp/README.md.
- New test in `apps/api/tests/release-doc.test.ts`: every `apps/*|legacy/*/railway.toml` must be listed, and its dockerfilePath, watchPatterns and healthcheckPath must match RELEASE.md. Negative-tested: dropping `packages/**` from the RELEASE mcp line fails, changing the toml health path fails; restored passes.
- No apps/mcp code touched.
- 2026-11-11 review round 1 (architect, PR #365): (1) added `$TURBO_ROOT$/apps/*/railway.toml` and `legacy/*/railway.toml` to ansari-api#test inputs — verified the hash did NOT move on a toml edit before, moves after (both globs), returns on restore; (2) mcp `packages/**` reworded as defensive (only workspace dep is the eslint-config devDependency; final image is dist + package.json) in RELEASE.md, toml, arch.md, arch-critical.md; (3) `PORT=3000` as a service variable, auth's phrasing, pinned in the test; (4) RELEASE.md "rebuilds *both*" → "*every* service"; optional: dockerfilePath regex-escaped.
