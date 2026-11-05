# Review: WhatsApp support in the monorepo (spec 321)

## Summary

The legacy Python WhatsApp service now lives in the monorepo as `legacy/whatsapp`. It identifies users by their business-scoped user ID (BSUID), gets a JWT for them from `apps/auth`, and talks to `apps/api`, keeping one thread per user that is replaced after 3 hours of silence. Four phases (import, BSUID/JWT, thread lifecycle, environments and docs) were built and reviewed; 79 tests pass. It has run against a real `apps/api` and `apps/auth`, and Meta accepted one real send to a BSUID, but a real phone's message has never reached the new service, the Docker image has never been built, and the `apps/auth` `/whatsapp` route does not exist yet (the sign-in is mocked by owner decision).

## Spec Compliance

Met means covered by an automated test unless stated. "Live" means checked by hand against a real service, not by the suite.

- [x] A phone-visible user's message is answered through the new stack. Tested with mocks and a mock transport (phases 2, 4); run live against a real `apps/api` with sample webhooks.
- [x] A phone-hidden user (BSUID only) is answered; no phone number reaches `apps/auth` or `apps/api`. Tested, including a request-body check that no phone or BSUID is sent to `apps/api` (phase 2); live with Meta's sample webhook shape (phase 4).
- [x] The same BSUID is the same user and thread; a new BSUID is a new user (phases 2, 3). Tested with the mock sign-in.
- [x] `apps/api` authenticates WhatsApp requests only via the `apps/auth` JWT; no WhatsApp login logic in `apps/api` (phase 2). No change was made to `apps/api`.
- [x] After more than 3 hours of silence the next message starts a new thread and the old one is deleted (phase 3). Tested, including a real-shaped `...Z` timestamp. "Exactly one thread per user" holds except for a race on two near-simultaneous first messages (see Deviations).
- [ ] Answers longer than 4000 characters are delivered as multiple messages in order. **Not covered by any test.** The splitter (`whatsapp_message_splitter.py`, limit 4000) is the legacy code imported unchanged and used by the conversation manager; no test was written or kept for it in this project. Unverified here.
- [x] Meta always gets a success response immediately, and its signature is verified (phase 1: missing and wrong signature rejected with 403). The "always 200" behaviour is the `ALWAYS_RETURN_OK_TO_META` setting, which tests deliberately turn off.
- [x] Status updates, webhooks for other numbers and unsupported message types do not trigger a chat answer. Status and other-number webhooks were seen being ignored live; the unsupported-type path is covered by the imported legacy test and logic.
- [x] With `WA_MAINTENANCE_MODE` on, users get the notice and no chat call is made, independent of `apps/api`'s `MAINTENANCE_MODE` (phase 4, tested both ways).
- [x] In staging, messages starting with `!d ` are ignored and others processed (phase 4, tested in staging and local).
- [x] No legacy users or threads were migrated.
- [x] Tests use mock Meta and mock backend clients, as in the legacy service.

Not in the spec's list but part of the owner's Phase 4 requirement: real services. Done by hand on 2026-10-26 (see the plan): real `apps/auth` and `apps/api` with a real JWT; Meta's dashboard sample webhooks through zrok with a valid signature; one real production-number send to a real BSUID, accepted by Meta (HTTP 200, delivery and read statuses followed). Not done: a real phone's webhook arriving at the new service (no Meta test number could be claimed), the Docker image, and the `apps/auth` `/whatsapp` route.

## Deviations from Plan

- **Phase 4, `/chat` instead of the raw route.** The client moved to `POST /api/v2/threads/{id}/chat`, which reports failures as an explicit `error` event, so the planned "detect the trailing `Error:` text" work became unnecessary.
- **Phase 4, no per-user lock.** The lock added in phase 3 was removed by the owner. A race on two near-simultaneous first messages can create two threads, and two overlapping answers can interleave in a thread's history. Both are accepted, documented in `_resolve_thread`, and cleaned up by an occasional manual sweep (keep the newest `whatsapp` thread per user).
- **Phase 4, `WA_MAINTENANCE_MODE`.** Renamed from `WHATSAPP_UNDER_MAINTENANCE` and made independent of `apps/api`'s `MAINTENANCE_MODE` (owner decision); the spec was amended.
- **Phase 4, logging.** Logs carry only `request_id` and are one JSON line per entry on stdout, the shape Railway indexes. This replaced the CloudWatch-shaped sink and the user-id tracking, and removed `get_subject`.
- **Phase 4, extra deploy fixes.** The app reads `PORT`; the Dockerfile uses repo-root paths, uv 0.9.13 and `uv sync --frozen`; `legacy/whatsapp/railway.toml` records settings (not read by Railway); a `.python-version` pins 3.13.
- **Phase 4, `MOCK_AUTH_TOKEN`.** A test-only setting so the mocked sign-in can return a real JWT to a real `apps/api`. Not in the plan.
- **Real-Meta test.** The plan assumed a Meta test number; none could be claimed (a widespread Meta-side failure), so Meta's sample webhooks and one production-number send were used instead. See the PR description for the request for a shared staging and test number.

## Consultation Feedback

Only Claude was consulted (a decision for this environment, since the other models' tooling is unusable on native Windows). Five reviews were run across four phases.

### import_service Phase (Round 1) , REQUEST_CHANGES

#### Claude
- **Concern**: no CI job for `legacy/whatsapp` → **Addressed**: a `whatsapp` job was added to `ci.yml`, with the action pinned to a commit SHA.
- **Concern**: `ruff` configured but not declared → **Addressed**: added to the `dev` extra and locked.
- **Concern**: READMEs reference files that do not exist → **Addressed** in phase 4 (both READMEs rewritten).
- **Concern**: no test for a missing or invalid Meta signature → **Addressed**: two tests added, shown to fail when wrong.
- **Concern**: CWD-relative `logs/` directory created at import; phone numbers logged and sent to Sentry → **Addressed** later (phase 2 redaction; the `logs/` directory and old logger were removed in phase 4).

### import_service Phase (Round 2) , APPROVE

#### Claude
- **Concern**: Dockerfile pins uv 0.5.11 against a `revision = 3` lockfile and its second sync is not `--frozen` → **Addressed** in phase 4.
- **Concern**: `conftest.py` comment wrong about `.env` precedence → **Addressed** (comment fixed).
- **Concern**: `test_webhook_message_basic` asserts only HTTP 200 → **N/A**: legacy test kept as imported; not tightened.

### auth_token_exchange Phase (Round 1) , COMMENT

#### Claude
- **Concern**: `get_subject()` can raise outside its try block → **Addressed** (fixed and tested); the function was later removed in phase 4.
- **Concern**: token exchange timeout of 15 s exceeds Meta's window → **Addressed**: lowered to 5 s.
- **Concern**: typing indicator never cancelled when sign-in fails → **Addressed**: scheduled only after sign-in succeeds.
- **Concern**: no assertion that no phone reaches `apps/api` → **Addressed**: test added, shown to fail when a phone is injected.
- **Concern**: mid-stream `apps/api` errors relayed unlogged as `Error:` text → **Addressed** in phase 4 by the `/chat` event stream.
- **Concern**: dependency on `from_user_id` and an untested BSUID send → **Addressed** in phase 4 as far as possible: `from_user_id` is present in Meta's sample webhooks, and a real send to a BSUID succeeded once (see Spec Compliance for the limits).
- **Concern**: reviewer did not run `pytest`/`ruff` → **N/A**: run by the builder and CI.

### thread_lifecycle Phase (Round 1) , APPROVE

#### Claude
- **Concern**: lock covers resolution only → **Rebutted** by owner decision: the lock was removed entirely and the cases accepted and documented.
- **Concern**: `...Z` timestamps untested → **Addressed** (test added).
- **Concern**: a create response without a thread id leaves the user un-notified → **Addressed** (user is told); Sentry capture added in phase 4.
- **Concern**: thread info/create/delete failures not captured in Sentry → **Addressed** in phase 4, with tests.
- **Concern**: single-replica assumption → **N/A**: no longer applies once the lock was removed.

### environments_and_docs Phase (Round 1) , COMMENT

#### Claude
- **Concern**: README and `tests/README.md` contradict the recorded live runs → **Addressed**: rewritten to state what was and was not verified.
- **Concern**: Sentry captures untested → **Addressed**: four tests, each shown to fail when its capture is removed.
- **Concern**: unreachable `TimeoutException` branch → **Addressed**: branch and import removed; timeouts are captured as message-processing failures.
- **Concern**: vacuous JSON-log test → **Addressed**: decision extracted into `should_use_json_logs()` with parametrized tests, shown to fail without the CI clause.
- **Concern**: Python version drift across CI, dev and the image → **Addressed**: `.python-version` pins 3.13; the suite passes on it.
- **Concern**: dead `META_WABA_ID` documentation and a legacy `ngrok` host → **Addressed**: removed.
- **Concern**: maintenance check runs before the `!d ` filter → **N/A**: matches the legacy order and is harmless; recorded in the plan.

### PR review (PR #327, Round 1) , REQUEST_CHANGES

#### Claude
- **Concern**: nothing stops `MOCK_AUTH_CLIENT=True` with `MOCK_AUTH_TOKEN` outside `local`, which would put every user in one account and thread → **Addressed**: the settings refuse to load with `MOCK_AUTH_TOKEN` unless `DEPLOYMENT_TYPE=local`; tested, and the tests fail when the guard is disabled. A mocked sign-in without the token hands out fake tokens a real `apps/api` rejects, so it cannot serve real users anywhere; a real deployment needs the `apps/auth` `/whatsapp` route.
- **Concern**: `_resolve_thread` could delete a thread from another client → **Addressed**: only `whatsapp` threads count; tested, fails without the filter.
- **Concern**: Meta's raw error body was logged, against the README → **Addressed**: only the status code is logged; tested for both send paths, fails with the body logging restored.
- **Concern**: dead commented-out debug block → **Addressed**: removed.
- **Concern**: wrong return annotation on `verification_webhook` → **Addressed**.
- **Concern**: `pytest` in runtime dependencies; `requires-python` and ruff `py310` against a 3.13 image; `await request.json()` outside the try block → **N/A** here: legacy packaging and behaviour, listed as follow-ups.
- **Concern**: Docker image never built; CI never run on a runner → **N/A**: stated in the PR; neither can be done from this machine.
See `codev/projects/321-rfc-whatsapp-support-in-the-mo/321-review-iter1-rebuttals.md`.

### PR review (PR #327, Round 2) , COMMENT

#### Claude
- **Concern**: all four round-1 findings → **Verified fixed** by the reviewer, each with a non-vacuous test.
- **Concern**: the apps/api client still logged and reported the raw error body → **Addressed**: only the status code; tested, fails with the body restored.
- **Concern**: the staging `!d ` filter crashed on an unsupported message type (list-shaped body), giving a 500 and a Meta retry loop in staging only → **Addressed**: guarded with an `isinstance` check; tested, fails without it.
- **Concern**: one payload interpolation skipped redaction → **Addressed**.
- **Concern**: "Message too old, notified user" while nothing notifies the user → **Addressed**: text and docstring corrected.
See `codev/projects/321-rfc-whatsapp-support-in-the-mo/321-review-iter2-rebuttals.md`.

## Lessons Learned

### What Went Well

- Negative controls. Every test that expects a failure was proven able to fail by briefly breaking the code and restoring it. A first version of the `/chat` error-event test passed with the handling disabled; this practice caught it.
- Reading the real contracts. The `apps/api` thread and chat routes were read in the code rather than assumed, and the client matched them. The Phase 4 real run then confirmed the main path against a live `apps/api`.
- A manual real-service run found problems the mocks could not: an expired 15-minute test JWT (apps/api answered 401 and the failure path told the user), an app ID that belonged to a different Meta app than the secret, and a log line that printed the webhook verify token in local mode.

### Challenges Encountered

- Windows. `afx spawn` is unusable (hard-coded `/bin/bash`), porch's whole-monorepo test check cannot pass, and `consult` misdetects the builder worktree. All were worked around locally; the list is kept for an upstream report.
- Meta test numbers. No test number could be claimed, so a real phone's webhook could not reach the new service. The workaround was Meta's sample webhooks plus one production-number send to a developer's own BSUID, which needed a temporary, now commented-out, log line in the legacy production service.
- Claims in docs drifting from facts. The README said nothing had run against live Meta after it had; the review caught it.

### What Would Be Done Differently

- Test the 4,000-character splitting. The criterion was never given a test or an owner and slipped through to the end.
- Decide earlier how a real phone's message would reach the service in a non-production environment. The shared-number routing idea (see the PR description) would have solved this at the start.

### Methodology Improvements

- Porch's review phase runs a `pr_exists` check before the builder signals completion, but the review file and PR are only written in this phase; the order is confusing for a first-time reader.
- Every phase boundary produces a "refresh your context" task that needs a live builder terminal; it should be skippable when none exists.
- A plan item that no phase owns (here the splitter test, found from the spec's success criteria) should be flagged when the plan is approved, by checking each success criterion against a phase.

## Architecture Updates

- Routed: cold, `codev/resources/arch.md` ("Monorepo layout, build & deploy") — `legacy/whatsapp` is a Python service in the repo: identifies users by BSUID only, mints a JWT through `apps/auth` (route and header assumed, sign-in mocked until `apps/auth` has the route), calls `apps/api`'s `/chat`, logs one JSON line per entry on stdout with only `request_id`; deployed by Dockerfile `legacy/whatsapp/Dockerfile` with the repo root as build context.
- No hot-tier change: both hot files are at their 10-fact cap and nothing here changes behaviour for builders working in other apps. Not demoted.

## Lessons Learned Updates

- Routed: cold, `codev/resources/lessons-learned.md` (new "WhatsApp service port (spec 321)" section) — do not log a webhook verify token or any user identifier, and prove that with a test that fails when the line is restored; a manual run against real services finds config errors (wrong app ID for a secret, expired tokens) that mocks cannot.
- No hot-tier change: the existing hot lesson "prefer failures that are loud over checks that are quiet" already covers the negative-control practice.

## Flaky Tests

No flaky tests encountered in `legacy/whatsapp`. On native Windows, porch's whole-monorepo `npm test` check could not pass, so it was narrowed locally to `legacy/whatsapp` through a git-ignored `.codev/config.json`; CI on Linux runs the stock checks for the other apps.

## Follow-up Items

- Create a new WhatsApp phone number shared by staging and test (call to action for Waleed; see the PR description), since a Meta test number cannot be claimed.
- Test the 4,000-character splitting; it has no test.
- Replace the mocked sign-in once `apps/auth` ships the route from issue #329 (`POST /api/whatsapp/session`, `Authorization: Bearer <AUTH_WHATSAPP_API_KEY>`, body `{bsuid}`, response `{token}`).
- Build and run the Docker image; run the staging smoke test in `legacy/whatsapp/README.md`.
- Raise with the `apps/api` owner: the chat routes save every message with `source: 'web'` even for WhatsApp threads.
- Make the `whatsapp` CI job a required check on `develop` (needs a repo admin; the job has not yet run on a GitHub runner).
- Occasional manual sweep: delete all but the newest `whatsapp` thread per user.
- Remove the dead legacy `ORIGINS` and CORS middleware if no browser calls this service.
- Packaging clean-up: move `pytest` to the `dev` extra, align `requires-python` and ruff `target-version` with the 3.13 image, and move `await request.json()` inside the webhook's try block (a signature-valid non-JSON body currently returns 500).
- A real deployment needs the real `apps/auth` `/whatsapp` route: the mocked sign-in cannot serve real users outside `local` (fake tokens are rejected by `apps/api`, and a shared real token is refused by the settings).
