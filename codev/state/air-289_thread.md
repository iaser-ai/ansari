# air-289 thread

- Added `### Using the Codev tooling (optional)` at the end of CONTRIBUTING.md "Pull requests" (six points from #289), README Codev sentence now links to it, test pins heading + README anchor.
- Surprise: `codev/resources/commands/overview.md` is NOT in this repo (resolves from the `@cluesmith/codev` skeleton), so it can't be a relative link — the contributor-docs link test would fail. Named it in backticks with the package-resolution note instead.
- Dropped the "#258 was 576 commits behind" specific from the doc: it's a dated anecdote naming a contributor's PR; the general rule carries the point.
- Negative-tested: renaming the heading fails the new test (1 failed / 11 passed); restored → 12 passed.
- porch tests check failed 3/3 under parallel load on a pre-existing frontend leak (ScrollDismiss.test.tsx, timer firing after jsdom teardown). Architect confirmed it's pre-existing and broader (AmbientVideo, pglite api files), filed #290, chose "no workaround". Re-ran on a quiet machine: build + tests passed.
- Verified overview.md ships at `@cluesmith/codev/skeleton/resources/commands/overview.md` in the installed package.
- Owner direction (post-PR): reword to "strongly recommended" and drop every "not required/optional" note. Heading is now `### Using the Codev tooling (strongly recommended)`; README anchor + test updated. This deliberately departs from #289's original "Codev is optional" framing, on the owner's word.
- Owner direction: "Codev tooling" isn't Codev's own terminology. Per github.com/cluesmith/codev, Codev is a human-agent software development methodology; its CLIs are `codev`, `afx` (Agent Farm, spawns builders), `porch` (protocol orchestration), `consult`. Heading is now `### Developing with Codev (strongly recommended)`. CONTRIBUTING and README link the upstream repo, and the CLI reference now links upstream `codev/resources/commands/overview.md` (verified it exists on main).
