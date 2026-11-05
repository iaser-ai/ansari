# Rebuttal: import_service, iteration 1

Review: `321-import_service-iter1-claude.txt` (REQUEST_CHANGES). All must-fix points are accepted and fixed in commit `7b04c55`.

## Must fix

**1. No CI job for `apps/whatsapp`. Accepted, fixed.**
Added a `whatsapp` job to `.github/workflows/ci.yml` (ruff check, ruff format check, pytest, working directory `apps/whatsapp`). `astral-sh/setup-uv` is pinned to a full commit SHA with a version comment (`07a047e6…`, v10.3.2, resolved through the GitHub API), matching the other jobs. No secrets are used because `conftest.py` supplies mock-mode defaults.
The review asked to prove the check both ways. Locally, using the exact CI steps (`uv sync --frozen --extra dev`, with no environment variables set):
- Green: ruff check, ruff format check and 7 tests pass.
- Red: a deliberately wrong assertion makes pytest fail (exit 1), and deliberately bad formatting makes `ruff format --check` fail (exit 1). Both were restored afterwards and the tree was clean.
Not proven: the job has not run on a GitHub Linux runner, because it can only run when the PR is opened. The first PR run is its first real test.

**2. `ruff` is not a declared dependency. Accepted, fixed.**
Added `ruff>=0.8.0` to the `dev` extra in `pyproject.toml` and relocked (`ruff==0.17.2`). CI installs it with `--extra dev` and uses the locked version.

## Comments

**3. Dangling references in `README.md` and `tests/README.md`. Accepted, scheduled.**
Phase 4 already owns the README rewrite. `tests/README.md` was missing from it, so it is now named in Phase 4's file list in the plan.

**4. `logs/` created at import in `app_logger.py`. Not changed.**
Deferred as the review suggests, to avoid changing imported code in an as-is phase.

**5. Phone numbers and message bodies in logs and Sentry. Not changed here.**
Already a Phase 2 deliverable ("Logs and errors contain no phone numbers"). The existing redaction helper noted by the review will be used then.

**6. Missing test for signature rejection. Accepted, fixed.**
Added `test_webhook_rejects_missing_signature` and `test_webhook_rejects_wrong_signature` (both expect 403). Shown to fail when the assertion is wrong.

## Environment note

On this Windows machine porch's default whole-monorepo test check cannot pass, so the local-only `.codev/config.json` narrows it to `apps/whatsapp`. CI on Linux still runs the full suites for the other apps.
