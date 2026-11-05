# Plan: WhatsApp support in the monorepo

**Specification**: [codev/specs/321-rfc-whatsapp-support-in-the-mo.md](../specs/321-rfc-whatsapp-support-in-the-mo.md)

## Executive Summary

Follow the spec's recommended Approach 1: import the existing Python WhatsApp service into the monorepo as a separate app (`legacy/whatsapp`), then replace its legacy user handling with the `apps/auth` token exchange, then add the one-thread-per-user lifecycle, then finish environment behaviour (maintenance mode, `!d ` filter) and deployment docs. The Baked Decisions in the spec are fixed and not re-opened here. The `/whatsapp` contract is taken as given (`POST /api/whatsapp/session`, `AUTH_WHATSAPP_API_KEY`, `{ bsuid }` in, `{ token }` out).

Testing strategy, used by every phase:
1. **Automated:** pytest with mock Meta, mock `apps/auth` and mock `apps/api` clients (the legacy base/real/mock service pattern). No network, no Meta.
2. **Local end to end:** the service runs locally, exposed to Meta through a zrok tunnel, with test messages prefixed `!d `. The `zrok.exe` binary is used for this (see "Local testing with zrok" below).
3. **Staging:** a final smoke test only, after the phases are merged and deployed.

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "import_service", "title": "Import the Python service as is"},
    {"id": "auth_token_exchange", "title": "Replace legacy user handling with the apps/auth token exchange"},
    {"id": "thread_lifecycle", "title": "One thread per user with expiry"},
    {"id": "environments_and_docs", "title": "Maintenance mode, staging filter, local testing and docs"}
  ]
}
```

## Phase Breakdown

### Phase 1: Import the Python service as is

**Dependencies**: None

#### Objective

Bring `ansari-whatsapp` into the monorepo as `legacy/whatsapp` with minimal changes, so it builds, lints and passes its existing tests there. Behaviour is unchanged at this point.

#### Files to Create / Modify

- `legacy/whatsapp/` (source, `pyproject.toml`, `uv.lock`, `pytest.ini`, `Dockerfile`, tests, `.env.example`), copied from the legacy repo without its logs, `tmp/` files, personal scripts, the `zrok.exe` binary and generated artifacts.
- Monorepo wiring only where needed (workspace and CI entries), following how other apps are registered.

#### Deliverables

- [ ] `legacy/whatsapp` present and runnable with `uv` and `ruff`.
- [ ] Legacy tests pass with `MOCK_META_API=True` and `MOCK_ANSARI_CLIENT=True`.
- [ ] `.env.example` contains no secrets.
- [ ] Tests for this phase (the imported suite).

#### Acceptance Criteria

- [ ] `uv sync`, `ruff check`, `ruff format --check` and `pytest tests/ -v` pass in `legacy/whatsapp`.
- [ ] Existing monorepo build and tests are unaffected.

#### Test Plan

Run the imported test suite in mock mode. Manually start the service and call the health check (`GET /`) and the webhook verification handshake (`GET /whatsapp/v2`).

### Phase 2: Replace legacy user handling with the apps/auth token exchange

**Dependencies**: Phase 1

#### Objective

Identify users by BSUID only. The service gets a JWT from `apps/auth` and calls `apps/api` with it. No phone number or BSUID is sent to `apps/api` or stored by this app.

#### Files to Create / Modify

- In `legacy/whatsapp`: a new auth client (base, real and mock, like the other services) behind the service provider; the webhook parser and conversation manager updated to key on BSUID and drop phone-number registration and the phone-hidden notice; the Ansari client updated to call `apps/api` with the JWT instead of legacy registration endpoints.
- New settings: auth base URL and `AUTH_WHATSAPP_API_KEY`, validated in config and listed in `.env.example`.
- Confirm in `apps/api` which existing endpoints the service needs (chat streaming, thread create or read, history) and use them as they are. If a needed endpoint is missing, record it as a finding instead of widening this phase.

#### Deliverables

- [ ] Auth client with mock implementation.
- [ ] Phone-visible and phone-hidden payloads both handled; the BSUID (`user_id` in the payload) is the only identity used.
- [ ] Failure of the token exchange sends the user a failure notice, is logged, and Meta still gets "OK".
- [ ] Logs and errors contain no phone numbers.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] Same BSUID yields a token request each time with the same input; a different BSUID is a different user (verified through the mock).
- [ ] No outgoing call to `apps/auth` or `apps/api` carries a phone number (asserted in tests).
- [ ] Streaming answers are still aggregated and split for WhatsApp as before.

#### Test Plan

Unit tests for the auth client (success, 400, 401, 500, timeout) and for webhook parsing of both user types. Service-level tests with all three mocks for the full message flow. Local end-to-end run with the zrok tunnel and `!d ` once `apps/auth` offers the endpoint; until then, only the mock-based tests apply.

### Phase 3: One thread per user with expiry

**Dependencies**: Phase 2

#### Objective

Each user has exactly one thread. If the last activity is older than the global expiry (3 hours), the old thread and its messages are deleted and a new thread starts.

#### Files to Create / Modify

- In `legacy/whatsapp`: the conversation manager's thread logic and the Ansari client's thread calls; expiry setting in config (global, default 3 hours).
- `apps/api` only if the existing endpoints cannot read the thread's last activity or delete a thread with its messages; any such change is kept minimal and noted in the review.

#### Deliverables

- [ ] Expired-thread replacement; non-expired threads reused.
- [ ] Tests for this phase.

#### Acceptance Criteria

- [ ] Message within the expiry reuses the thread and keeps context.
- [ ] Message after the expiry deletes the old thread and messages and creates a new thread.
- [ ] A user normally has exactly one thread. Two messages arriving back to back right after the expiry could each create one; this is a known, accepted corner case, documented in `_resolve_thread` (owner decision: no lock, and an occasional manual sweep keeps only each WhatsApp user's newest thread).

#### Test Plan

Unit tests with a controllable clock for the boundary (just inside, just outside the expiry) and the first-ever message. Local end-to-end check with a short expiry value set through config.

### Phase 4: Maintenance mode, staging filter, local testing and docs

**Dependencies**: Phase 3

#### Objective

Finish environment behaviour and make the service testable and deployable by others.

#### Files to Create / Modify

- In `legacy/whatsapp`: rename the maintenance flag `WHATSAPP_UNDER_MAINTENANCE` to `WA_MAINTENANCE_MODE` (owner decision): it is read from this service's own environment and is independent of `apps/api`'s `MAINTENANCE_MODE`; keep the notice message; keep the staging `!d ` filter; `README.md` and `tests/README.md` for the app (both still reference legacy files that were not imported).
- Deployment notes: per-environment Meta credentials and secrets, and the deploy steps for staging and production, following the monorepo's existing deployment docs.
- Findings from the Phase 2 review to resolve here: (a) apps/api reports a failed or empty answer as an inline `Error: ...` at the end of a 200 stream, which the client currently relays to the user unlogged, so detect it, log it and send a failure notice; (b) deploy blocker to confirm before the staging smoke test: the service now requires `from_user_id` in every webhook, and sending to a BSUID (`recipient`) is untested against Meta's live API (Meta's docs disagree on when it is supported), so check the webhook Graph API version and test a real send; (c) `README.md` still documents the six deleted legacy endpoints.
- Findings from the Phase 3 review to resolve here: failures of the thread list, create and delete calls are logged but not captured in Sentry, unlike message-processing failures, so add that with the logging work. (The review's single-replica note no longer applies: the per-user lock was removed by owner decision.)
- Issues to raise with the `apps/api` owner when the PR is opened, not to fix in this work: (a) the chat routes hard-code `source: 'web'` on every message they save, so WhatsApp messages are labelled `web` even though their thread is `whatsapp`; (b) the answer stream reports a failure as trailing `Error:` text after a 200 response, with no explicit marker (see the `Error:` item above).
- Housekeeping to document: an occasional manual sweep deleting all but the newest thread of each WhatsApp user (threads with source `whatsapp`).
- Deploy-path items found in the Phase 1 review: bump the uv version in the `Dockerfile` (it pins 0.5.11 against a newer lockfile format) and make its second `uv sync` use `--frozen`; decide whether to keep `/sentry-debug` and `clean_logs.sh`; ask an admin to make the `whatsapp` CI job a required check on `develop`.

#### Deliverables

- [x] Maintenance flag `WA_MAINTENANCE_MODE`, with tests.
- [x] `!d ` filter kept, with tests (ignored in staging, processed otherwise).
- [x] README covering setup, tests, and local testing with zrok.
- [x] Staging smoke-test checklist (in `legacy/whatsapp/README.md`).

#### Phase 4 outcome (what changed from the notes above)

- The client now uses the `/chat` stream, which reports failures as an explicit `error` event, so the inline `Error:` detection in item (a) is no longer needed; a failed, cut-off or malformed stream is a failure the user is told about.
- Logs carry only `request_id` (no user id, so `get_subject` was removed) and are one JSON line per entry on stdout, the shape Railway indexes.
- Thread-list, create, delete, message-processing and sign-in failures are captured in Sentry. A backend timeout is captured as a message-processing failure (the real client wraps timeouts into `MessageProcessingError`); there is no separate timeout case.
- `/sentry-debug` is kept but registered only outside production; `clean_logs.sh` is removed (logs go to stdout).
- The app reads `PORT` (default 8001).
- Dockerfile: uv 0.9.13, `uv sync --frozen`, and paths relative to the repo root (the build context RELEASE.md prescribes). `legacy/whatsapp/railway.toml` records the Railway settings; Railway does not read it.

#### Real-service run (owner requirement: Phase 4 is not complete on mocks alone)

Done 2026-10-26, local, no Docker: real `apps/auth` (new empty `ansari_auth` database) and real `apps/api` (the local app database, migrated 8 to 11 with existing rows intact, Gemini key from `apps/api/.env`), the WhatsApp service with `MOCK_ANSARI_CLIENT=False`, `MOCK_AUTH_CLIENT=True` plus `MOCK_AUTH_TOKEN` (a real JWT from a throwaway user) and `MOCK_META_API=True`.

- A correctly signed webhook (BSUID only) was accepted, the real `apps/api` accepted the JWT, a `whatsapp` thread was created, the real `/chat` stream returned an answer (about 9 seconds) and it was handed to the (mock) Meta sender.
- A second message from the same BSUID reused the same thread: one thread, four saved messages (user, assistant, user, assistant).
- Still real-only gaps: the BSUID-to-JWT exchange (`apps/auth` has no `/whatsapp` route yet; mock by owner decision, to confirm with Amr).

#### Real-Meta run (2026-10-26)

No Meta test number could be claimed (see the PR notes below), so the run used Meta's own pieces where it could and the production number for one send.

- **Webhooks from Meta, through zrok:** the Test app's callback URL (`https://zrok0ansari0test.share.zrok.io/whatsapp/v2`) passed Meta's verification handshake; Meta's dashboard sample webhooks (v26.0) reached the service with a valid signature. They were ignored because Meta's samples carry a fake phone number ID; equivalent signed payloads (username with phone hidden, and with phone present) were then sent through the public URL with the sample ID set locally, and each was identified by BSUID, got a thread in the real `apps/api` and an answer. Meta's "not opted in" sample was not replayed.
- **Send to a BSUID:** one text was sent from the production number to the developer's own BSUID (`recipient`, no `to`) with a direct HTTP call using the same endpoint, token and body shape as `MetaApiServiceReal`. Meta answered 200 with the BSUID echoed as `user_id`, and delivery and read status webhooks followed. The developer confirming it appeared on the phone is still to be recorded. The service class itself was not used for this send.
- **How the BSUID was obtained:** a temporary log line for `from_user_id` was added to the legacy service for about an hour and is now commented out; the value lives only in the git-ignored `legacy/whatsapp/.env` as `REAL_TEST_BSUID`.
- **Fixes found on the way:** the verification handler logged the verify token in local mode (removed, with a test); the app ID in the legacy `.env` belonged to a different Meta app than the app secret (a local config error, not a code change).
- **Not covered:** a real phone's message arriving at the new service (the Test app has no number), and the Docker image.

#### Open at the end of Phase 4 (not verified)

- The Docker image has never been built or run (no Docker daemon was available).
- A real phone's webhook reaching the new service is untested (sample webhooks and one production-number send were verified, see above). Meta's own samples show `from_user_id` present, but that is a sample, not a live payload.
- The `apps/auth` `/whatsapp` contract (route, header, `AUTH_WHATSAPP_API_KEY`) is assumed and was not exercised (a real `apps/api` and the real `apps/auth` were run, see above).
- The `whatsapp` CI job has not run on a GitHub runner. Making it a required check on `develop` needs a repo admin; mention how in the PR description rather than doing it here.

#### Phase 4 review (Claude, iteration 1): COMMENT

All findings were checked against the code. Fixed: the README and `tests/README.md` no longer claim nothing ran against live Meta or `apps/api` (they now say what was and was not done); the unreachable `httpx.TimeoutException` branch and its import were removed; a missing new thread id is now captured in Sentry like the other creation failures; Sentry captures for thread-list, delete, create and message-processing failures each have a test (each fails if its capture call is removed); the JSON-log decision became `should_use_json_logs()` with parametrized cases (the old test passed without its CI clause); `legacy/whatsapp/.python-version` pins 3.13, the version the Docker image uses, and the suite passes on it; the dead `META_WABA_ID` block and the legacy `ngrok` host were removed from `.env.example`.

Decided, no change: the maintenance check runs before the `!d ` filter, so a staging instance in maintenance mode answers a developer's `!d ` message with the maintenance notice. This matches the legacy order and is harmless, so it stays.

#### Notes for the PR description (do not lose these)

1. **Call to action (Waleed):** a new WhatsApp phone number is needed for the staging and test environments to share. Reason: the developer cannot claim a Meta test number ("An error occurred while creating the test account. Please try again."), the account has one live production number, and Meta's free tier allows two business numbers, with a test number counting as one. The failure is widely reported and Meta has not said it is working on a fix, as far as the threads below show. Forum threads (Meta for Developers community unless noted; each was seen listed in search results, and only the titles and snippets were read, not the full threads):
   - https://developers.facebook.com/community/threads/1725780401801558/ (test number provisioning fails although the test WABA exists)
   - https://developers.facebook.com/community/threads/899305532556240/ (error while creating a WhatsApp Business test account)
   - https://developers.facebook.com/community/threads/1789721235531963/ (a verified business cannot claim a test number)
   - https://developers.facebook.com/community/threads/2182066965706958/ ("No phone numbers available" when claiming)
   - https://developers.facebook.com/community/threads/1379359970388767/ ("get new test number" fails)
   - https://developers.facebook.com/community/threads/1342448903816361/ (asked 8 Dec 2025, the same error)
   - https://developers.facebook.com/community/threads/568920538895906/ (asked 23 Sep 2024, cannot create a test number)
   - https://developers.facebook.com/community/threads/1246890150314692/ (cannot claim a test number, for several days)
   - https://developers.facebook.com/community/threads/849020947139819/ (no test number after adding the WhatsApp product)
   - https://developers.facebook.com/community/threads/2128147975242023 and https://developers.facebook.com/community/threads/1694270385568451 and https://developers.facebook.com/community/threads/2981069012252252 (same error)
   - https://stackoverflow.com/questions/79475543/whatsapp-cloud-api-test-number-not-active-after-generation (a related Stack Overflow question)
   - https://www.reddit.com/r/WhatsappBusinessAPI/comments/1ni3dxr/whatsapp_api_current_issue_invalid_test_phone/ (Reddit, "apparently some others in the meta developer community")
   The dated threads (Sep 2024, Dec 2025) and the many recent ones show the problem is not new. Before the PR is opened, re-open a few of these and confirm they still say what is written here, and whether anyone from Meta has answered.
2. **Alternative if no new number is created (developer's idea, not built):** all three environments (production, staging, local) share the one production number and each answers only its own messages: no prefix means production, a `!s ` prefix means staging, a `!d ` prefix means local. Each environment ignores messages meant for the others, so the production service must be changed first to ignore the prefixed ones. Downsides to state: every environment's app receives all messages for the number, including real users' (a privacy cost for a laptop), the replies come from the production number, and a missing rule in one environment means a double or wrong answer. Today only the `!d ` rule exists, in staging.
3. **BSUID logging:** the legacy service has a commented-out, opt-in log line for reading a developer's own BSUID; it must stay commented out in production.

#### Acceptance Criteria

- [ ] With the flag on, users get the notice and no chat call is made.
- [ ] In staging mode, `!d `-prefixed messages are ignored and others processed.
- [ ] A new developer can run the service locally and receive a test message following only the README.

#### Test Plan

Unit tests for both behaviours. Manual: local run through zrok with `!d `, then staging smoke test (a normal message answered, a `!d ` message ignored by staging and answered locally).

## Local testing with zrok

- The legacy flow stays: `zrok reserve public localhost:8001 -n <ZROK_SHARE_TOKEN>`, with the Meta test app's webhook URL pointing at the reserved share.
- A copy of `zrok.exe` has been placed in the worktree's `tmp/` folder, which is git-ignored, so the command runs there (`tmp\zrok.exe`) and the 86 MB binary never gets committed. The original stays in `ansari-whatsapp`.
- Cleaner alternatives, not used by default: install zrok once on the PATH (for example through a package manager) so no copy is needed per worktree; or keep one shared tools folder outside the repos and put it on the PATH.
- Local runs use the Meta test app's credentials and the shared test number, so messages meant for local must start with `!d ` to keep staging from answering them.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| `apps/auth` endpoint is not available when Phase 2 is built | Medium | Medium | Mock auth client; local end to end deferred until it exists |
| `apps/api` lacks a thread read or delete endpoint needed in Phase 3 | Medium | Medium | Check early in Phase 2; add the smallest change and note it |
| Concurrent messages create two threads for one user | Low | Low | Accepted without a lock (owner decision); documented in `_resolve_thread`; occasional manual sweep keeps only the newest thread |
| Imported code carries secrets, logs or personal files | Low | High | Copy only source, tests and config examples; review the diff before committing |
| Shared test number makes local and staging answer the same message | Medium | Low | `!d ` filter kept and tested |

## Documentation Updates

- New `legacy/whatsapp/README.md`.
- Deployment and environment notes for the WhatsApp service in the monorepo docs.
- `codev/resources` arch notes only if the review finds a lasting system-shape fact.
