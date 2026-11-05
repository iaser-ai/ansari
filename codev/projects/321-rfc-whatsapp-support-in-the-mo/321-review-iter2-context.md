### Iteration 1 Reviews
- claude: REQUEST_CHANGES — Well-executed port with honest docs and verified cross-service contracts, but the mocked sign-in can silently merge all WhatsApp users into one account if deployed as planned, and thread deletion isn't scoped by source.

### Builder Response to Iteration 1
# Rebuttal: review phase (PR #327), iteration 1

Review: `321-review-iter1-claude.txt` (REQUEST_CHANGES). The four code findings are accepted and fixed; nothing is rebutted. Each new test was shown to fail when its fix is undone.

## Must fix

**1. Nothing stopped `MOCK_AUTH_CLIENT=True` with `MOCK_AUTH_TOKEN` outside `local`. Accepted, fixed.**
`WhatsAppSettings` now refuses to load when `MOCK_AUTH_TOKEN` is set and `DEPLOYMENT_TYPE` is not `local`, so the service will not start in staging or production with it. Tests: local allows it, staging and production refuse it, and an empty value is fine anywhere. They fail (2 tests) when the guard is disabled.
One consequence the review's premise misses: a mocked sign-in without `MOCK_AUTH_TOKEN` hands out fake tokens that a real `apps/api` rejects, so a mocked sign-in cannot serve real users anywhere. A deployment against a real `apps/api` needs the real `apps/auth` `/whatsapp` route. The README, `.env.example` and the PR description now say so.

**2. `_resolve_thread` could delete a thread that is not a WhatsApp thread. Accepted, fixed.**
`get_last_thread_info` now considers only threads whose `source` is `whatsapp` (the list endpoint returns `source`). Test: a newer `web` thread is ignored, and a user whose only thread is `web` counts as having none. It fails when the filter is removed. The existing real-client fixtures now include `source`, as the real endpoint does.

**3. Meta's raw error body was logged, against the README's "no phone numbers or BSUIDs in logs". Accepted, fixed.**
Both send paths now log only the status code. Test: a failing send (the mock error body echoes a BSUID) must log the status but neither the BSUID nor the body, for the message and typing-indicator calls. It fails when the body logging is put back.

**4. Dead commented-out debug block. Accepted, removed** from `ansari_client_real.py`.

## Also fixed (nits)

- `verification_webhook` was annotated `-> str | None` but returns `HTMLResponse`; corrected.

## Not changed, with reasons

- **`pytest` in the runtime dependencies, and `requires-python`/ruff `py310` against a 3.13 image.** Both are imported legacy packaging. Moving `pytest` to the `dev` extra changes the lockfile and the Docker install; narrowing the Python range changes supported versions. Left for a follow-up and listed in the review document; the suite passes on 3.13.
- **`await request.json()` outside the try block (a signature-valid non-JSON body returns 500).** Legacy behaviour; Meta sends JSON and the signature is checked first. Listed as a follow-up.
- **Docker image never built; CI job never run on a runner.** Unchanged and stated in the PR. Neither can be done from this machine (no Docker daemon); the first PR run is the CI job's first real test.

## Review's own caveat on counts

The review counted 57 `def test_` functions against "70 tests"; parametrized cases account for the difference. After these changes the suite is 77 tests.

Verification: ruff clean, format clean, 77 passed.


### IMPORTANT: Stateful Review Context
This is NOT the first review iteration. Previous reviewers raised concerns and the builder has responded.
Before re-raising a previous concern:
1. Check if the builder has already addressed it in code
2. If the builder disputes a concern with evidence, verify the claim against actual project files before insisting
3. Do not re-raise concerns that have been explained as false positives with valid justification
4. Check package.json and config files for version numbers before flagging missing configuration
