# Rebuttal: review iteration 1 (claude, REQUEST_CHANGES)

Fixed in commit `e81e9629`, pushed to `builder/pir-363` (PR #390). The full suite still passes (214 tests), and `ruff check` and `ruff format --check` are clean.

## Blocking: `.env.example` half-renamed

**Agreed, and fixed.** The variable line was renamed but the comment above it still listed `local`. Changed:

- Lines 2 to 3 now list `development, staging, production` (the names `apps/api` and `apps/auth` use), say that development adds localhost and the zrok address to `ORIGINS`, and explain the prefix routing in three lines.
- Lines 17 and 21 now say "if development".
- Line 181 now says "any environment" instead of a list that included `local`.

The remaining uses of the word "local" in that file (a local address, "local/stage testing", "local development with zrok") are ordinary English and not the retired value, so I left them.

## Non-blocking

- **`RELEASE.md` and `arch.md` still called the third environment "local".** Agreed and fixed: both now say "development".
- **A bare `!s ` forwards an empty text to `apps/api`.** Agreed that it is a new reachable input. No code change: it is harmless as far as I can tell, and the test pins it. I added a line under "Things to Look At During PR Review" in the review file.
- **The autouse fixture in `conftest.py` bypasses the mock refusal.** Agreed, and no change. The validator has its own tests that build the settings from scratch, which the negative controls exercised (mocks allowed in staging fails 4 tests). The review file already says to keep the fixture narrow.
- **`.env.example` should mention prefix routing.** Done, in the same edit as the first point.

## One claim I could not reproduce

The review says the diff is a 231-file list caused by base drift. I checked: `upstream/develop` is at `ea2c67c4`, which is also the merge base of this branch, and GitHub reports PR #390 as **20 changed files, +590 / -166** (the 16 code and doc files plus the plan, the review, and porch's records). So the PR is not inflated. The consultation probably compared against a stale reference. This did not affect any finding above, which I checked against the files on disk.

The review also notes that the pre-gate review arrived after the `dev-approval` gate. That is the order porch's phases run in for PIR (the consultation happens at the review phase, after the gate), so nothing is out of order.
