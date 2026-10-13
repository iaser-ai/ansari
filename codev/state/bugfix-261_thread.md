# bugfix-261 thread

## Investigate (2026-10-12)

- Reproduced: `gh api graphql ... contactLinks` on iaser-ai/ansari (default branch `develop`
  @ a7134cb) returns only "Report a security vulnerability". The "General question" link is
  missing.
- Root cause: `.github/ISSUE_TEMPLATE/config.yml:8` uses `url: mailto:info@iaser.ai`. GitHub
  discards non-https contact links. The test in `apps/api/tests/contributor-docs.test.ts`
  only checked that a link named like "question" exists in the file, not its URL scheme.
- Surprise: the worktree was spawned from a stale base (75a75cf, 673 commits behind
  iaser-ai `develop`; the fork's `origin/develop` is stale too) and did not contain
  `config.yml` or the test at all. Merged iaser-ai `develop` (a7134cb) into the branch so
  the fix applies to the real files. No conflicts.
- Scope: two files, a few lines. Fits BUGFIX.
- Fix choice: point the link at
  `https://github.com/iaser-ai/ansari/blob/develop/CONTRIBUTING.md#filing-an-issue`, which
  already says to email `info@iaser.ai`. Enabling Discussions is a maintainer decision and
  was left alone.

## Fix (2026-10-12)

- `config.yml`: "General question" now links to
  `https://github.com/iaser-ai/ansari/blob/develop/CONTRIBUTING.md#filing-an-issue`.
- `contributor-docs.test.ts`: two new tests. One asserts every contact link is `https://`.
  The other asserts the question link's anchor resolves to a real CONTRIBUTING.md heading
  whose section still contains `info@iaser.ai`, so the link cannot rot into a dead end.
- Negative test: restored the old `mailto:` config, both new tests failed (2 failed / 11
  passed); with the fix 13 passed.
- First push was rejected (`workflow` scope missing: the merge of upstream develop carried
  `.github/workflows/ci.yml` changes the fork did not have). It went through later once the
  fork's `develop` had caught up to a7134cb; I did not sync the fork myself.
- porch `build` check needs env. `next build` fails in a bare worktree (no `.env`); ran the
  checks with the committed dummy `apps/api/.env.ci` loaded, as CI does. Loading
  `apps/auth/.env.ci` as well makes `@ansari/auth` tests fail, so load only the API one.
- One porch `tests` run failed in `ansari-api#test` and I did not capture which test. Two
  full reruns passed (API 84 files, frontend 616 tests), so it is intermittent and not
  identified.
- Acceptance criterion "GraphQL returns both links" can only be checked after merge: the
  chooser renders from the default branch.

## PR (2026-10-12)

- PR #288 against iaser-ai/ansari `develop`.
- First CMAP round produced nothing: `consult` stopped on "Multiple projects found" because
  the develop merge brought every project directory into the worktree. Reran with
  `--issue 261`.
- gemini APPROVE, claude APPROVE. Claude's nits taken: the section check now ends at the
  next heading of the same or higher level (not a hardcoded `##`), starts at the matched
  line index, and reads the file the URL path names. Negative-tested three ways: `mailto:`
  (2 fail), heading renamed (1 fail), address moved to the next section (1 fail).
- codex: default model `gpt-5.6-sol` is rejected for this ChatGPT account. Reran with
  `--model-id gpt-5.5`: APPROVE (reviewed after the tightening commit; gemini and claude
  reviewed before it).
- `pr` gate requested. Waiting for the architect.
- `pr` gate approved by the human (relayed by the architect, 2026-10-12). Ran
  `porch approve` and `porch done`; porch now reports the protocol complete/verified even
  though PR #288 is NOT merged. This account has read-only access upstream, so the merge
  is left to a maintainer. No fork-CI `action_required` hold: CI started on the head commit.
- Still open after merge: rerun the GraphQL `contactLinks` query and confirm both links.
- Architect asked for `porch rollback bugfix-261 pr` so the record matches reality (PR #288
  still open). Done: phase is `pr` again. Next step after the maintainer merges:
  `porch done bugfix-261 --merged 288` (architect relays re-approval if the gate reappears).
