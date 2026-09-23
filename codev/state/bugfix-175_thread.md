# bugfix-175 thread — gitleaks scans all reachable refs

## Investigate (2026-09-24)
- Reproduced locally with the pinned gitleaks 8.24.3 (darwin build, checksum matched the release list) on a fresh clone at develop HEAD:
  the default `gitleaks detect` scanned 749 commits and flagged 46966b18 (chat-reconcile.test.ts), which is reachable ONLY from origin/builder/pir-128.
- Root cause: `actions/checkout` with `fetch-depth: 0` fetches `+refs/heads/*:refs/remotes/origin/*`, and gitleaks with no `--log-opts`
  runs `git log -p -U0 --full-history --all`. `--all` walks every fetched remote branch, so any unmerged builder branch gets scanned.
- The develop/main push scan hits the same problem, not only PRs: `--all` there also walks other people's unmerged branches.
  So "full history on push" has to mean the full history of the pushed HEAD, not `--all`.
- #173 has since merged; its original block is moot, but the class remains.
- Scope: CI yaml + a small scan script + a shell regression test run inside the gitleaks job (which has the binary). Well under 300 LOC.

## Fix (2026-09-24)
- `.github/scripts/gitleaks-scan.sh`: PR runs scan `origin/$BASE_REF..HEAD`; pushes scan `HEAD` (the pushed branch's full history, not `--all`).
  It fails loudly (exit 2) on a shallow repo, a missing/unresolvable base, or an empty range, so a mis-scoped scan can't pass by scanning nothing.
- `.github/scripts/gitleaks-scan.test.sh`: builds throwaway origin+CI-shaped clones with runtime-generated AKIA keys, so the file itself holds no flaggable literal.
  It asserts exact exit codes (0 clean / 1 leak / 2 error). Wired as a step in the gitleaks job, which already has the pinned binary.
- The exact exit codes paid off right away: the first version of the shallow case "passed" only because the fixture clone had no HEAD (git exit 128). Fixed the fixture.
- Proved the test fails without the fix: dropping `--log-opts` fails the 2 cross-branch cases. Removing the shallow guard fails the shallow case.
- Real repo: with 46966b18 still on origin/builder/pir-128, the develop push scan (612 commits) and a bugfix-165 PR scan are both clean.
- Binary pin and checksum steps untouched. No `.gitleaks.toml` allowlist change.
